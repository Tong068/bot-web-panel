import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { conversationKey } from './database.js'
import { fail } from './config.js'
import { segments, received, sanitizeMedia, messageIds, preview, resultState } from './messages.js'
import { Avatars } from './avatars.js'
import { MessageDetails } from './message-details.js'
import { Forwards } from './forwards.js'
import { Rkeys } from './rkeys.js'
import { MediaLinks } from './media-links.js'

export const sendContext = new AsyncLocalStorage()
const string = value => String(value ?? '')
const adapterName = bot => string(bot.adapter?.name || bot.adapter?.id || bot.version?.name || bot.version?.id)
const adapterIs = (bot, ...names) => [bot.adapter?.id, bot.adapter?.name, bot.version?.id, bot.version?.name].some(value => names.includes(value))
const entries = map => map instanceof Map ? [...map] : []
export function online(bot, id, framework) {
  if (typeof bot.isOnline === 'function') { try { return !!bot.isOnline() } catch { return false } }
  if (bot.ws) return bot.ws.readyState === 1
  if (bot.sdk?.ws) return bot.sdk.ws.readyState === 1
  if (typeof bot.online === 'boolean') return bot.online
  return Array.from(framework.uin || []).some(x => string(x) === id)
}
export class Bridge {
  constructor(bot, db, media, publish, log = console) {
    Object.assign(this, { bot, db, media, publish, log })
    this.restore = []; this.hooked = new WeakMap(); this.tasks = Promise.resolve(); this.stopped = false
    this.avatars = new Avatars(this, media)
    this.details = new MessageDetails(this)
    this.forwards = new Forwards(this)
    this.rkeys = new Rkeys(this, media.controller.signal)
    this.mediaLinks = new MediaLinks(this)
  }
  instances() {
    const source = this.bot.bots || this.bot
    return Object.entries(source).filter(([id, b]) => b && typeof b === 'object' && (b.adapter || b.pickFriend || b.pickGroup) && !['bot', 'bots'].includes(id))
  }
  get(id, active = false) {
    if (typeof id !== 'string' || !id || id.length > 256) throw fail(400, '必须指定机器人 ID')
    const bot = this.instances().find(([key]) => key === id)?.[1]
    if (!bot) throw fail(404, '机器人不存在')
    if (active && !online(bot, id, this.bot)) throw fail(409, '机器人当前离线')
    return bot
  }
  canonical(bot, kind, id, botId) {
    const map = kind === 'group' ? bot.gl : bot.fl
    const keys = entries(map).map(([key]) => string(key))
    id = string(id)
    if (keys.includes(id)) return id
    const prefixed = `${botId}${bot.adapter?.sep || ':'}${id}`
    return keys.includes(prefixed) || adapterIs(bot, 'QQBot') && !id.startsWith(`${botId}${bot.adapter?.sep || ':'}`) && !id.startsWith('qg_') ? prefixed : id
  }
  pick(botId, kind, id, active = true) {
    if (!['group', 'private'].includes(kind) || typeof id !== 'string' || !id || id.length > 512) throw fail(400, '无效会话')
    const bot = this.get(botId, active), fn = kind === 'group' ? 'pickGroup' : 'pickFriend'
    if (typeof bot[fn] !== 'function') throw fail(422, '此机器人不支持该会话类型')
    const map = kind === 'group' ? bot.gl : bot.fl
    const rawKey = entries(map).find(([key]) => string(key) === id)?.[0] ?? id
    const pick = bot[fn](rawKey)
    if (!pick) throw fail(404, '会话不存在')
    return pick
  }
  capabilities(pick, kind, botId) {
    const bot = this.get(botId)
    return { text: typeof pick.sendMsg === 'function', image: typeof pick.sendMsg === 'function', at: kind === 'group' && !adapterIs(bot, 'stdin'), quote: adapterIs(bot, 'OneBotv11', 'ICQQ', 'QQBot'), file: typeof pick.sendFile === 'function', recall: typeof pick.recallMsg === 'function', members: kind === 'group' && (typeof pick.getMemberMap === 'function' || typeof pick.getGroupMemberList === 'function') }
  }
  async bots() {
    return Promise.all(this.instances().map(async ([id, bot]) => ({ id, name: string(bot.nickname || bot.info?.username || id), adapter: adapterName(bot), online: online(bot, id, this.bot), avatar: await this.avatars.resolve(id, 'private', id, bot.avatar), unread: (await this.db.conversations(id)).reduce((n, c) => n + c.unread, 0) })))
  }
  async contacts(id) {
    const bot = this.get(id), saved = await this.db.conversations(id)
    const contacts = new Map(saved.map(x => [x.key, x])), refreshed = new Set()
    for (const [kind, map] of [['private', bot.fl], ['group', bot.gl]]) for (const [rawId, info] of entries(map)) {
      const target_id = string(rawId), key = conversationKey(id, kind, target_id)
      const old = contacts.get(key) || {}
      contacts.set(key, { ...old, key, bot_id: id, kind, target_id, name: string(info?.remark || info?.group_name || info?.nickname || info?.name || old.name || target_id), avatar: await this.avatars.resolve(id, kind, target_id, info?.avatar || info?.avatar_url), unread: old.unread || 0 })
      refreshed.add(key)
    }
    for (const contact of contacts.values()) if (!refreshed.has(contact.key)) contact.avatar = await this.avatars.resolve(id, contact.kind, contact.target_id, contact.avatar)
    return [...contacts.values()]
  }
  enqueue(fn) {
    if (this.stopped) return Promise.resolve()
    const work = this.tasks.then(fn)
    this.tasks = work.catch(error => this.log.error?.(`[BotWeb] 消息记录失败: ${error.message}`))
    return work
  }
  async record(data, trusted = false, event) {
    if (!data) return
    data = await this.details.message(data, event)
    data = await this.avatars.message(data)
    data.conversation_avatar = await this.avatars.resolve(data.bot_id, data.kind, data.target_id, data.conversation_avatar)
    data.message = await sanitizeMedia(data.message, this.media, data.bot_id, trusted, data)
    data.preview = preview(data.message)
    const result = await this.db.save(data)
    await this.publish({ type: 'message', ...result })
    return result.message
  }
  hook(adapter, method, signature = 'standard') {
    const icqq = signature === 'icqq', stdin = signature === 'stdin'
    const original = adapter[method]
    if (typeof original !== 'function') return
    const installed = this.hooked.get(adapter) || new Map()
    if (installed.get(method) === original) return
    const bridge = this
    const wrapped = function(...args) {
      const context = sendContext.getStore()
      if (context?.depth || context?.panel) return original.apply(this, args)
      let data
      try {
        const info = stdin ? { self_id: adapter.id, user_id: adapter.id } : icqq ? args[1] : args[0], botId = string(icqq ? args[0] : info?.self_id)
        const bot = bridge.get(botId)
        const kind = method.includes('Group') || method.includes('Guild') || icqq && info?.group_id ? 'group' : 'private'
        const rawTarget = method.includes('Guild') ? `${adapterIs(bot, 'QQBot') ? 'qg_' : ''}${info?.guild_id}-${info?.channel_id}` : kind === 'group' ? info?.group_id : info?.user_id
        const target = bridge.canonical(bot, kind, rawTarget, botId)
        const content = stdin ? args[0] : icqq ? args[2] : method.includes('File') ? { type: 'file', file: args[1], name: method === 'sendGroupFile' && adapterIs(bot, 'OneBotv11') ? args[3] : args[2] } : args[1]
        if (target) data = { id: randomUUID(), bot_id: botId, kind, target_id: target, message: segments(content), sender: { user_id: botId, nickname: string(bot.nickname || botId) }, direction: 'out', origin: 'plugin', time: Date.now() / 1000 }
      } catch { /* Unknown adapter signatures retain their original behavior. */ }
      const capture = (result, error) => { if (data) bridge.enqueue(() => bridge.record({ ...data, platform_id: messageIds(result)[0] || null, platform_ids: messageIds(result), status: error ? 'failed' : resultState(result), error: error ? '适配器发送失败' : undefined }, true)).catch(() => {}) }
      try {
        const result = sendContext.run({ ...context, depth: 1 }, () => original.apply(this, args))
        if (result?.then) result.then(value => capture(value), error => capture(null, error))
        else capture(result)
        return result
      } catch (error) { capture(null, error); throw error }
    }
    adapter[method] = wrapped; installed.set(method, wrapped); this.hooked.set(adapter, installed)
    this.restore.push(() => { if (adapter[method] === wrapped) adapter[method] = original })
  }
  hookDirect(bot, botId, method, kind) {
    const original = bot[method]
    if (typeof original !== 'function') return
    const installed = this.hooked.get(bot) || new Map()
    if (installed.get(method) === original) return
    const descriptor = Object.getOwnPropertyDescriptor(bot, method), bridge = this
    const wrapped = function(target, message, ...args) {
      if (sendContext.getStore()?.depth || sendContext.getStore()?.panel) return original.call(this, target, message, ...args)
      const data = { id: randomUUID(), bot_id: botId, kind, target_id: bridge.canonical(bot, kind, target, botId), message: segments(message), sender: { user_id: botId, nickname: string(bot.nickname || botId) }, direction: 'out', origin: 'plugin', time: Date.now() / 1000 }
      const capture = (result, error) => bridge.enqueue(() => bridge.record({ ...data, platform_id: messageIds(result)[0] || null, platform_ids: messageIds(result), status: error ? 'failed' : resultState(result) }, true)).catch(() => {})
      try {
        const result = sendContext.run({ depth: 1 }, () => original.call(this, target, message, ...args))
        if (result?.then) result.then(value => capture(value), error => capture(null, error)); else capture(result)
        return result
      } catch (e) { capture(null, e); throw e }
    }
    bot[method] = wrapped; installed.set(method, wrapped); this.hooked.set(bot, installed)
    this.restore.push(() => { if (bot[method] === wrapped) { if (descriptor) Object.defineProperty(bot, method, descriptor); else delete bot[method] } })
  }
  scan() {
    for (const [id, bot] of this.instances()) {
      if (!bot.adapter) continue
      if (adapterIs(bot, 'ICQQ')) {
        this.hook(bot.adapter, 'sendMsg', 'icqq')
        this.hookDirect(bot, id, 'sendPrivateMsg', 'private')
        this.hookDirect(bot, id, 'sendGroupMsg', 'group')
      } else if (adapterIs(bot, 'stdin')) this.hook(bot.adapter, 'sendMsg', 'stdin')
      else for (const name of ['sendFriendMsg', 'sendGroupMsg', 'sendGuildMsg', 'sendDirectMsg', 'sendFriendFile', 'sendGroupFile']) this.hook(bot.adapter, name)
    }
    const state = this.instances().map(([id, bot]) => [id, online(bot, id, this.bot), string(bot.nickname)])
    if (JSON.stringify(state) !== this.lastState) { this.lastState = JSON.stringify(state); this.enqueue(() => this.publish({ type: 'bots' })).catch(() => {}) }
  }
  start() {
    this.onMessage = event => { try { const data = received(event); if (data) this.enqueue(() => this.record(data, false, event)).catch(() => {}) } catch (e) { this.log.error?.(`[BotWeb] 无法解析消息: ${e.message}`) } }
    this.onConnect = () => this.scan()
    this.onNotice = event => {
      if (!['recall', 'delete'].includes(event.sub_type) && !/recall/.test(event.notice_type || '')) return
      const data = received(event)
      if (!data?.platform_id) return
      this.enqueue(async () => {
        const row = await this.db.get('SELECT m.body FROM messages m JOIN message_receipts r ON r.message_id=m.id WHERE r.conversation=? AND r.platform_id=?', [conversationKey(data.bot_id, data.kind, data.target_id), data.platform_id])
        if (row) await this.record({ ...JSON.parse(row.body), recalled: true })
      }).catch(() => {})
    }
    this.bot.prependListener('message', this.onMessage)
    this.bot.on('message_sent', this.onMessage)
    this.bot.on('notice', this.onNotice)
    this.bot.prependListener('connect', this.onConnect)
    this.bot.on('system.offline', this.onConnect)
    this.scan(); this.timer = setInterval(() => this.scan(), 10000); this.timer.unref?.()
  }
  async send(botId, params) {
    const { kind, target_id, request_id } = params
    if (typeof request_id !== 'string' || !/^[a-f0-9-]{36}$/.test(request_id)) throw fail(400, '缺少发送请求标识')
    const existing = await this.db.get('SELECT body FROM messages WHERE id=?', [request_id])
    if (existing) {
      const body = JSON.parse(existing.body)
      if (body.bot_id !== botId || body.kind !== kind || body.target_id !== target_id) throw fail(409, '发送请求标识已被使用')
      return body
    }
    const pick = this.pick(botId, kind, target_id), cap = this.capabilities(pick, kind, botId)
    if (!Array.isArray(params.message) || !params.message.length || params.message.length > 100) throw fail(400, '消息为空或消息段过多')
    if (JSON.stringify(params.message).length > 65536) throw fail(413, '消息过长')
    const normalized = [], outgoing = []
    for (const part of params.message) {
      if (part.type === 'text') { if (typeof part.text !== 'string') throw fail(400, '无效文字'); normalized.push({ type: 'text', text: part.text }); outgoing.push({ type: 'text', text: part.text }) }
      else if (part.type === 'at' && cap.at) { const qq = string(part.qq); if (!qq || qq.length > 512) throw fail(400, '无效成员'); normalized.push({ type: 'at', qq, text: string(part.text).slice(0, 100) }); outgoing.push({ type: 'at', qq }) }
      else if (part.type === 'face' && /^\d{1,5}$/.test(string(part.id))) { normalized.push({ type: 'face', id: string(part.id) }); outgoing.push({ type: 'face', id: Number(part.id) }) }
      else if (['image', 'file'].includes(part.type)) {
        if (part.type === 'file' && !cap.file) throw fail(422, '此机器人不支持文件发送')
        const file = await this.media.get(part.media_id)
        if (file.bot_id !== botId) throw fail(403, '附件属于其他机器人')
        if (part.type === 'image' && !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(file.mime)) throw fail(400, '请选择有效图片')
        normalized.push({ type: part.type, media_id: file.id, name: file.name, url: `/bot-web/api/media/${file.id}` })
        outgoing.push({ type: part.type, file: file.path, name: file.name })
      } else throw fail(422, '不支持的发送内容')
    }
    if (!outgoing.some(x => x.type !== 'text' || x.text.trim())) throw fail(400, '消息不能为空')
    let quote = null
    if (params.quote_id) {
      if (!cap.quote) throw fail(422, '此机器人不支持引用回复')
      const row = await this.db.get('SELECT body FROM messages WHERE id=? AND conversation=?', [params.quote_id, conversationKey(botId, kind, target_id)])
      if (!row) throw fail(404, '引用消息不存在')
      const message = JSON.parse(row.body)
      if (!message.platform_id) throw fail(422, '此消息没有可引用的消息 ID')
      quote = { id: message.platform_id, text: message.preview, user_id: message.sender.user_id }
      outgoing.unshift({ type: 'reply', id: message.platform_id })
    }
    const bot = this.get(botId)
    const data = { id: request_id, bot_id: botId, kind, target_id, direction: 'out', origin: 'panel', status: 'sending', time: Date.now() / 1000, sender: { user_id: botId, nickname: string(bot.nickname || botId) }, message: normalized, quote: quote ? { id: quote.id, text: quote.text, user_id: quote.user_id } : null }
    await this.enqueue(() => this.record(data))
    const sending = sendContext.run({ panel: true }, async () => {
        const files = outgoing.filter(x => x.type === 'file'), parts = outgoing.filter(x => x.type !== 'file'), results = []
        let error = null
        try {
          if (parts.length) results.push(await pick.sendMsg(parts))
          for (const file of files) results.push(await pick.sendFile(file.file, file.name))
        } catch { error = '适配器发送失败，请检查机器人日志' }
        const failed = error || results.some(x => ['failed', 'partial'].includes(resultState(x)))
        const succeeded = results.filter(x => ['sent', 'partial', 'unknown'].includes(resultState(x)))
        const ids = results.flatMap(messageIds)
        return { ...data, status: failed ? succeeded.length ? 'partial' : 'failed' : results.some(x => resultState(x) === 'unknown') ? 'unknown' : 'sent', platform_id: ids[0] || null, platform_ids: ids, error }
      })
    let timer
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), 30000); timer.unref?.() })
    const result = await Promise.race([sending, timeout]); clearTimeout(timer)
    if (result) return this.enqueue(() => this.record(result))
    const unknown = await this.enqueue(() => this.record({ ...data, status: 'unknown', error: '等待回执超时，后台继续等待，请勿重复发送' }))
    sending.then(result => this.enqueue(() => this.record(result))).catch(error => this.log.error?.(`[BotWeb] 迟到回执记录失败: ${error.message}`))
    return unknown
  }
  async action(botId, action, params = {}) {
    this.get(botId)
    if (['send_private_msg', 'send_group_msg'].includes(action)) return this.send(botId, { ...params, kind: action === 'send_group_msg' ? 'group' : 'private' })
    if (action === 'get_contacts') return this.contacts(botId)
    if (action === 'get_forward_msg') return this.forwards.load(botId, params)
    if (action === 'get_history') return Promise.all((await this.db.history(conversationKey(botId, params.kind, params.target_id), params.before, params.limit)).map(async message => this.avatars.message(await this.details.message(message))))
    if (action === 'set_conversation_preferences') {
      this.pick(botId, params.kind, params.target_id, false)
      const changes = Object.fromEntries(['pinned', 'unread'].filter(key => key in params).map(key => [key, params[key]]))
      if (!Object.keys(changes).length || Object.values(changes).some(value => typeof value !== 'boolean')) throw fail(400, '无效会话设置')
      await this.db.preferences(botId, params.kind, params.target_id, changes)
      await this.publish({ type: 'contacts', bot_id: botId })
      return true
    }
    if (action === 'mark_read') { await this.db.read(conversationKey(botId, params.kind, params.target_id), Number(params.seq) || 0); await this.publish({ type: 'read', bot_id: botId }); return true }
    if (action === 'get_capabilities') { const pick = this.pick(botId, params.kind, params.target_id, false); return this.capabilities(pick, params.kind, botId) }
    if (action === 'get_group_member_list') {
      const pick = this.pick(botId, 'group', params.target_id)
      const members = typeof pick.getMemberMap === 'function' ? await pick.getMemberMap() : typeof pick.getGroupMemberList === 'function' ? await pick.getGroupMemberList() : null
      if (!members) throw fail(422, '此机器人无法提供成员列表')
      return (members instanceof Map ? [...members.values()] : Array.isArray(members) ? members : members.data || []).slice(0, 5000).map(m => ({ user_id: string(m.user_id || m.id), nickname: string(m.card || m.nickname || m.name || m.user_id) }))
    }
    if (action === 'delete_msg') {
      const row = await this.db.get('SELECT body FROM messages WHERE id=? AND bot_id=?', [params.id, botId])
      if (!row) throw fail(404, '消息不存在')
      const msg = JSON.parse(row.body), pick = this.pick(botId, msg.kind, msg.target_id)
      if (msg.direction !== 'out' || !msg.platform_id || typeof pick.recallMsg !== 'function') throw fail(422, '此消息无法撤回')
      const result = await pick.recallMsg(msg.platform_ids?.length ? msg.platform_ids : msg.platform_id)
      if (result === false || Array.isArray(result) && result.includes(false)) throw fail(502, '撤回失败')
      return this.enqueue(() => this.record({ ...msg, recalled: true }))
    }
    throw fail(422, '此功能未开放')
  }
  async close() {
    this.stopped = true; clearInterval(this.timer)
    for (const [name, fn] of [['message', this.onMessage], ['message_sent', this.onMessage], ['notice', this.onNotice], ['connect', this.onConnect], ['system.offline', this.onConnect]]) if (fn) this.bot.off(name, fn)
    for (const restore of this.restore.reverse()) restore()
    await this.tasks
    await this.forwards.close()
  }
}
