import { base } from './config.js'

const entry = (map, id) => map instanceof Map ? [...map].find(([key]) => String(key) === id)?.[1] : undefined

export class Avatars {
  constructor(bridge, media) { this.bridge = bridge; this.media = media; this.cache = new Map() }
  async source(url, botId) {
    if (typeof url !== 'string' || !url) return ''
    if (url.startsWith(`${base}/api/media/`)) {
      const id = url.slice(`${base}/api/media/`.length)
      return await this.media.db.get('SELECT id FROM media WHERE id=? AND bot_id=?', [id, botId]) ? url : ''
    }
    const id = await this.media.register(url, botId, 'avatar')
    return id ? `${base}/api/media/${id}` : ''
  }
  async resolve(botId, kind, targetId, source, groupId = '') {
    targetId = String(targetId)
    const key = JSON.stringify([botId, kind, targetId, source || '', groupId])
    const cached = this.cache.get(key)
    if (cached && cached.until > Date.now()) return cached.promise
    if (this.cache.size > 5000) this.cache.clear()
    const promise = this.lookup(botId, kind, targetId, source, groupId).catch(() => '')
    this.cache.set(key, { until: Date.now() + 60000, promise })
    return promise
  }
  async lookup(botId, kind, targetId, source, groupId) {
    const bot = this.bridge.get(botId)
    const info = entry(kind === 'group' ? bot.gl : bot.fl, targetId)
    const member = groupId && entry(entry(bot.gml, groupId), targetId)
    for (const url of [source, member?.avatar, member?.avatar_url, info?.avatar, info?.avatar_url, targetId === botId && kind === 'private' && (bot.avatar || bot.info?.avatar)]) {
      const result = await this.source(url, botId)
      if (result) return result
    }
    let pick
    if (groupId && typeof bot.pickMember === 'function') {
      try { pick = bot.pickMember(groupId, targetId) } catch { /* Some adapters only expose friend avatars. */ }
    }
    if (typeof pick?.getAvatarUrl !== 'function') pick = this.bridge.pick(botId, kind, targetId, false)
    if (typeof pick.getAvatarUrl !== 'function') return ''
    const result = pick.getAvatarUrl()
    if (!result?.then) return this.source(result, botId)
    let timer
    try {
      // A slow optional avatar lookup must not indefinitely block chat history or recording.
      const url = await Promise.race([result, new Promise(resolve => { timer = setTimeout(() => resolve(''), 1500); timer.unref?.() })])
      return await this.source(url, botId)
    } finally { clearTimeout(timer) }
  }
  async message(data) {
    if (!data) return data
    const own = data.direction === 'out'
    const avatar = await this.resolve(data.bot_id, 'private', own ? data.bot_id : data.sender.user_id, data.sender.avatar, own || data.kind !== 'group' ? '' : data.target_id)
    return { ...data, sender: { ...data.sender, avatar } }
  }
}
