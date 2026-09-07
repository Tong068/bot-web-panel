import { fail } from './config.js'
import { mediaLocator, segments } from './messages.js'
import { ntImageSource, ntMediaSource } from './rkeys.js'

function httpUrl(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}
function findMedia(parts, id, parent = {}) {
  for (const [index, item] of parts.entries()) {
    if (item.media_id === id && ['video', 'record'].includes(item.type)) return { ...parent, index, type: item.type }
    if (item.type === 'forward') for (const [node, content] of (item.content || []).entries()) {
      const match = findMedia(content.message, id, { forward: item, node })
      if (match) return match
    }
  }
}

export class MediaLinks {
  constructor(bridge) { this.bridge = bridge }
  request(run) { return this.bridge.rkeys.request(run) }
  async renew(botId, locator) {
    const bot = this.bridge.get(botId, true), { segment } = locator
    let result
    if ([bot.adapter?.name, bot.adapter?.id].includes('OneBotv11') && typeof bot.sendApi === 'function') {
      result = await this.request(() => bot.sendApi('get_file', { file: segment.file || segment.fid, download: false }))
      result = result?.data ?? result
      return httpUrl(result?.url)
    }
    if ([bot.adapter?.name, bot.adapter?.id].includes('ICQQ')) {
      const pick = this.bridge.pick(botId, locator.kind, locator.target_id), contact = pick.raw || pick
      const method = segment.type === 'video' ? 'getVideoUrl' : 'getPttUrl'
      if (typeof contact[method] === 'function') result = await this.request(() => contact[method]({ ...segment }))
      return httpUrl(result)
    }
    return null
  }
  async original(message) {
    if (!message.platform_id) return null
    const bot = this.bridge.get(message.bot_id, true), sdk = bot.sdk || bot.raw || bot
    let result
    if ([bot.adapter?.name, bot.adapter?.id].includes('OneBotv11') && typeof bot.sendApi === 'function') result = await this.request(() => bot.sendApi('get_msg', { message_id: message.platform_id }))
    else if (typeof sdk.getMsg === 'function') result = await this.request(() => sdk.getMsg(message.platform_id))
    result = result?.data?.message ? result.data : result
    if (!result || result.self_id != null && String(result.self_id) !== message.bot_id) return null
    if (result.message_id != null && String(result.message_id) !== message.platform_id) return null
    if (result.group_id != null && (message.kind !== 'group' || String(result.group_id) !== message.target_id)) return null
    if (message.kind === 'private') {
      const sender = String(result.sender?.user_id ?? result.user_id ?? '')
      const peer = sender && sender !== message.bot_id ? sender : result.target_id ?? result.peer_id
      if (peer && String(peer) !== message.target_id) return null
    }
    return segments(result.message)
  }
  async recover(row) {
    // Old records retained media IDs but discarded the SDK's file identifiers.
    const rows = await this.bridge.db.all("SELECT DISTINCT m.body FROM messages m,json_tree(m.body,'$.message') j WHERE m.bot_id=? AND j.key='media_id' AND j.value=? LIMIT 5", [row.bot_id, row.id])
    for (const entry of rows) {
      const message = JSON.parse(entry.body), match = findMedia(message.message, row.id)
      if (!match || message.recalled) continue
      let parts
      if (match.forward) parts = (await this.request(() => this.bridge.forwards.retrieve(row.bot_id, message, match.forward)))[match.node]?.message
      else parts = await this.original(message)
      const item = parts?.[match.index]
      if (item?.type !== match.type) continue
      const locator = mediaLocator(item, message), source = httpUrl(item.url)
      if (locator) {
        row.locator = JSON.stringify(locator)
        row.source = ntMediaSource(source || row.source)?.href || source || row.source
        await this.bridge.db.run('UPDATE media SET locator=?,source=? WHERE id=? AND bot_id=?', [row.locator, row.source, row.id, row.bot_id])
      }
      return { locator, source }
    }
    return {}
  }
  async resolve(row, force = false) {
    if (ntImageSource(row.source)) return this.bridge.rkeys.resolve(row.source, row.bot_id, force)
    let locator = row.locator ? JSON.parse(row.locator) : null
    if (!locator && !ntMediaSource(row.source)) return row.source
    const fallback = httpUrl(row.source)
    try {
      if (locator) {
        try {
          const source = await this.renew(row.bot_id, locator)
          if (source) return source
        } catch { this.bridge.media.controller.signal.throwIfAborted() }
      }
      const recovered = await this.recover(row)
      if (recovered.source) return recovered.source
      if (!locator && recovered.locator) {
        const source = await this.renew(row.bot_id, recovered.locator)
        if (source) return source
      }
    } catch (error) {
      this.bridge.media.controller.signal.throwIfAborted()
      if (!fallback || force || ntMediaSource(fallback) && !new URL(fallback).searchParams.has('rkey')) throw error
    }
    if (fallback && (!ntMediaSource(fallback) || new URL(fallback).searchParams.has('rkey'))) return fallback
    throw fail(502, '无法刷新视频或语音链接，原消息或适配器文件记录可能已过期')
  }
}
