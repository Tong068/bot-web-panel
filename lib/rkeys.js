import { fail } from './config.js'

export function ntMediaSource(source) {
  let url
  try { url = new URL(source) } catch { return null }
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'multimedia.nt.qq.com.cn' || url.port || url.username || url.password || url.pathname !== '/download' || !url.searchParams.get('appid')) return null
  url.searchParams.delete('rkey')
  return url
}
export function ntImageSource(source) {
  const url = ntMediaSource(source)
  return url?.searchParams.get('fileid') && ['1406', '1407'].includes(url.searchParams.get('appid')) ? url : null
}

function keyValue(value) {
  if (typeof value !== 'string') return ''
  const key = /^[?&]?rkey=/.test(value) ? new URLSearchParams(value.replace(/^&/, '')).get('rkey') : value
  return key?.trim() || ''
}
function keysFrom(result) {
  if (result?.status === 'failed' || Number(result?.retcode || 0) !== 0) return {}
  const data = result?.data ?? result, keys = {}
  const add = (type, entry, expires) => {
    const key = keyValue(entry)
    if (key && (expires == null || Number(expires) > Date.now() / 1000)) keys[type] = key
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      const type = ['10', 'private'].includes(String(item?.type)) ? 'private' : ['20', 'group'].includes(String(item?.type)) ? 'group' : null
      if (type) add(type, item.rkey, item.expire_time ?? (item.ttl == null ? undefined : Number(item.created_at ?? item.time ?? Date.now() / 1000) + Number(item.ttl)))
    }
  } else if (data && typeof data === 'object') {
    for (const [type, index, field] of [['private', 10, 'offNTPicRkey'], ['group', 20, 'groupNTPicRkey']]) {
      add(type, data[index]?.rkey ?? data[`${type}_rkey`] ?? data[`${type}_key`] ?? data[field], data[index]?.expire_time ?? data.expired_time)
    }
  }
  return keys
}

export class Rkeys {
  constructor(bridge, signal) { this.bridge = bridge; this.signal = signal; this.pending = new Map(); this.methods = new WeakMap() }
  async request(run) {
    this.signal.throwIfAborted()
    let timer, abort
    try {
      return await Promise.race([Promise.resolve().then(run), new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(fail(504, '获取媒体下载信息超时，请重试')), 5000); timer.unref?.()
        abort = () => reject(this.signal.reason)
        this.signal.addEventListener('abort', abort, { once: true })
      })])
    } finally { clearTimeout(timer); this.signal.removeEventListener('abort', abort) }
  }
  async fetch(botId, force) {
    const bot = this.bridge.get(botId, true)
    if ([bot.adapter?.name, bot.adapter?.id].includes('ICQQ')) {
      const sdk = bot.sdk || bot.raw || bot
      let result
      if (typeof sdk.refreshNTPicRkey === 'function') result = await this.request(() => sdk.refreshNTPicRkey(force))
      else if (typeof sdk.pickFriend === 'function') {
        const pick = sdk.pickFriend(Number(botId) || botId), contact = pick.raw || pick
        if (typeof contact.getNTPicRkey === 'function') result = await this.request(() => contact.getNTPicRkey())
      }
      return keysFrom(result)
    }
    if ([bot.adapter?.name, bot.adapter?.id].includes('OneBotv11') && typeof bot.sendApi === 'function') {
      const methods = [...new Set([this.methods.get(bot), 'get_rkey', 'nc_get_rkey', 'get_rkey_server'].filter(Boolean))]
      for (const method of methods) {
        try {
          const keys = keysFrom(await this.request(() => bot.sendApi(method, {})))
          if (Object.keys(keys).length) { this.methods.set(bot, method); return keys }
        } catch (error) {
          this.signal.throwIfAborted()
          if (error?.status === 504) throw error
        }
      }
    }
    return {}
  }
  async resolve(source, botId, force = false) {
    const url = ntImageSource(source)
    if (!url) return source
    this.signal.throwIfAborted()
    const key = JSON.stringify([botId, force])
    if (!this.pending.has(key)) this.pending.set(key, this.fetch(botId, force).finally(() => this.pending.delete(key)))
    const keys = await this.pending.get(key), rkey = keys[url.searchParams.get('appid') === '1406' ? 'private' : 'group']
    if (!rkey) throw fail(502, '无法获取有效的 QQ 图片 rkey，请检查适配器接口后重试')
    url.searchParams.set('rkey', rkey)
    return url.href
  }
}
