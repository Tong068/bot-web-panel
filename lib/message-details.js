import { conversationKey } from './database.js'
import { preview, segments } from './messages.js'

const entry = (map, id) => map instanceof Map ? [...map].find(([key]) => String(key) === id) : undefined
const name = info => String(info?.card || info?.nickname || info?.name || '')

export class MessageDetails {
  constructor(bridge) { this.bridge = bridge; this.cache = new Map() }
  async cached(key, lookup) {
    key = JSON.stringify(key)
    const cached = this.cache.get(key)
    if (cached && cached.until > Date.now()) return cached.promise
    if (this.cache.size > 5000) this.cache.clear()
    const promise = (async () => {
      let timer
      try {
        // Adapter metadata is optional and must not stall the recording queue.
        return await Promise.race([Promise.resolve().then(lookup), new Promise(resolve => { timer = setTimeout(resolve, 1500); timer.unref?.() })])
      } catch { return undefined } finally { clearTimeout(timer) }
    })()
    this.cache.set(key, { until: Date.now() + 60000, promise })
    return promise
  }
  async member(data, userId) {
    return this.cached(['member', data.bot_id, data.kind, data.target_id, userId], async () => {
      const bot = this.bridge.get(data.bot_id)
      const friend = entry(bot.fl, userId)
      const fallback = name(friend?.[1]) || (userId === data.bot_id ? name(bot) : '') || (userId === data.sender.user_id ? name(data.sender) : '')
      if (data.kind !== 'group') return fallback
      const group = entry(bot.gml, data.target_id), member = entry(group?.[1], userId)
      if (name(member?.[1])) return name(member[1])
      const groupId = group?.[0] ?? entry(bot.gl, data.target_id)?.[0] ?? data.target_id
      const rawId = member?.[0] ?? friend?.[0] ?? userId
      try {
        const pick = this.bridge.pick(data.bot_id, 'group', data.target_id, false)
        const contact = typeof pick.pickMember === 'function' ? pick.pickMember(rawId) : bot.pickMember?.(groupId, rawId)
        const localName = name(contact?.info) || name(contact)
        if (localName) return localName
        const getInfo = contact?.getInfo || contact?.renew
        if (typeof getInfo === 'function') {
          const info = await getInfo.call(contact)
          return name(info?.data || info) || fallback
        }
        const members = await this.cached(['members', data.bot_id, data.target_id], () => pick.getMemberMap?.() ?? pick.getGroupMemberList?.())
        const info = members instanceof Map ? entry(members, userId)?.[1] : (Array.isArray(members) ? members : members?.data || []).find(item => String(item.user_id ?? item.id) === userId)
        return name(info) || fallback
      } catch { return fallback }
    })
  }
  async parts(message, data) {
    return Promise.all(message.map(async item => {
      if (item.type !== 'at') return item
      const qq = String(item.qq), text = String(item.text || '').replace(/^@/, '')
      return { ...item, text: qq === 'all' ? '全体成员' : text && text !== qq ? text : await this.member(data, qq) || text }
    }))
  }
  async quote(data, event) {
    const reply = data.message.find(item => item.type === 'reply')
    let quote = data.quote ? { ...data.quote, id: data.quote.id || reply?.id || '' } : reply ? { id: reply.id, text: '', user_id: '' } : null
    if (!quote) return null
    if (event?.source?.message) quote.text = preview(await this.parts(segments(event.source.message), data))
    if (quote.text) return quote
    if (quote.id) {
      const row = await this.bridge.db.get('SELECT m.body FROM messages m JOIN message_receipts r ON r.message_id=m.id WHERE r.conversation=? AND r.platform_id=?', [conversationKey(data.bot_id, data.kind, data.target_id), quote.id])
      if (row) {
        const original = JSON.parse(row.body)
        return { ...quote, text: original.recalled ? '消息已撤回' : preview(await this.parts(original.message, data)), user_id: original.sender.user_id }
      }
    }
    if (!quote.id && typeof event?.getReply !== 'function') return quote
    const original = await this.cached(['quote', data.bot_id, data.kind, data.target_id, quote.id || data.id], async () => {
      let result
      if (typeof event?.getReply === 'function') result = await event.getReply()
      else {
        const pick = this.bridge.pick(data.bot_id, data.kind, data.target_id, false)
        result = typeof pick.getMsg === 'function' ? await pick.getMsg(quote.id) : await this.bridge.get(data.bot_id).getMsg?.(quote.id)
      }
      result = result?.data?.message ? result.data : result
      if (!result) return undefined
      if (result.self_id != null && String(result.self_id) !== data.bot_id) return undefined
      if (result.group_id != null && (data.kind !== 'group' || this.bridge.canonical(this.bridge.get(data.bot_id), 'group', result.group_id, data.bot_id) !== data.target_id)) return undefined
      if (data.kind === 'private') {
        const userId = String(result.sender?.user_id ?? result.user_id ?? '')
        const peerId = userId && userId !== data.bot_id ? userId : result.target_id ?? result.peer_id
        if (peerId && this.bridge.canonical(this.bridge.get(data.bot_id), 'private', peerId, data.bot_id) !== data.target_id) return undefined
      }
      return result
    })
    if (original) quote = { id: quote.id || String(original.message_id ?? original.id ?? ''), text: preview(await this.parts(segments(original.message ?? original.raw_message), data)), user_id: String(original.sender?.user_id ?? original.user_id ?? quote.user_id) }
    return quote
  }
  async message(data, event) {
    const [message, quote] = await Promise.all([this.parts(data.message, data), this.quote(data, event)])
    return { ...data, message, quote, preview: preview(message) }
  }
}
