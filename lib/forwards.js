import { fail } from './config.js'
import { forwardNodes, sanitizeMedia } from './messages.js'

function locate(message, path) {
  let parts = message.message, part
  for (let i = 0; i < path.length; i += 2) {
    part = parts?.[path[i]]
    if (part?.type !== 'forward') throw fail(404, '合并转发消息不存在')
    if (i + 1 < path.length) parts = part.content?.[path[i + 1]]?.message
  }
  return part
}

export class Forwards {
  constructor(bridge) { this.bridge = bridge; this.pending = new Map() }
  load(botId, { id, path }) {
    if (typeof id !== 'string' || !Array.isArray(path) || !path.length || path.length > 15 || path.length % 2 !== 1 || path.some(index => !Number.isSafeInteger(index) || index < 0)) throw fail(400, '无效转发消息位置')
    if (this.bridge.stopped) throw fail(409, '消息面板正在关闭')
    const key = JSON.stringify([botId, id, path])
    if (!this.pending.has(key)) this.pending.set(key, this.fetch(botId, id, path).finally(() => this.pending.delete(key)))
    return this.pending.get(key)
  }
  async stored(botId, id) {
    const row = await this.bridge.db.get('SELECT seq,body FROM messages WHERE id=? AND bot_id=?', [id, botId])
    if (!row) throw fail(404, '消息不存在')
    const message = { ...JSON.parse(row.body), seq: row.seq }
    if (message.recalled) throw fail(410, '消息已撤回')
    return message
  }
  async retrieve(botId, message, part, depth = 0) {
    if (!part.id) throw fail(422, '此转发消息没有可查询的标识')
    const bot = this.bridge.get(botId, true), pick = this.bridge.pick(botId, message.kind, message.target_id)
    let getForward
    if ([bot.adapter?.name, bot.adapter?.id].includes('ICQQ')) {
      // ICQQ pick proxies expose unbound SDK methods; their raw contact owns the SDK state.
      const contact = pick.raw || pick
      if (typeof contact.getForwardMsg === 'function') getForward = () => contact.getForwardMsg(part.id, part.filename || undefined)
      else if (typeof bot.getForwardMsg === 'function') getForward = () => bot.getForwardMsg(part.id, part.filename || undefined)
    } else if ([bot.adapter?.name, bot.adapter?.id].includes('OneBotv11') && typeof bot.sendApi === 'function') {
      getForward = () => bot.sendApi('get_forward_msg', { id: part.id, message_id: part.id })
    } else if (typeof pick.getForwardMsg === 'function') getForward = () => pick.getForwardMsg(part.id)
    else if (typeof bot.getForwardMsg === 'function') getForward = () => bot.getForwardMsg(part.id)
    if (!getForward) throw fail(422, '此机器人不支持读取合并转发')
    let result, timer
    try {
      result = await Promise.race([Promise.resolve().then(getForward), new Promise((resolve, reject) => { timer = setTimeout(() => reject(fail(504, '读取转发消息超时，请重试')), 10000); timer.unref?.() })])
    } catch (error) { throw error.status === 504 ? error : fail(502, '无法读取转发内容，请稍后重试') }
    finally { clearTimeout(timer) }
    const content = forwardNodes(result, depth)
    if (!content.length) throw fail(404, '转发内容为空或已过期')
    return content
  }
  async fetch(botId, id, path) {
    const message = await this.stored(botId, id), part = locate(message, path)
    if (part.content?.length) return message
    const content = await this.retrieve(botId, message, part, (path.length - 1) / 2)
    for (const node of content) node.message = await sanitizeMedia(node.message, this.bridge.media, botId, false, message)
    // Merge only the fetched node into the latest record, preserving concurrent recalls and loads.
    const updated = await this.bridge.db.serialized(async () => {
      const latest = await this.stored(botId, id), target = locate(latest, path)
      if (target.id !== part.id) throw fail(409, '转发消息已变化，请重新打开')
      if (!target.content?.length) target.content = content
      await this.bridge.db.run('UPDATE messages SET body=? WHERE id=? AND bot_id=?', [JSON.stringify(latest), id, botId])
      return latest
    })
    await this.bridge.publish({ type: 'message', message: updated, update: true })
    return updated
  }
  async close() { await Promise.allSettled(this.pending.values()) }
}
