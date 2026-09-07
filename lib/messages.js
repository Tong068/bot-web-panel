import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { base } from './config.js'

let parseMultiMsg
function legacyForward(payload) {
  if (parseMultiMsg === undefined) {
    parseMultiMsg = null
    try {
      const require = createRequire(new URL('../../ICQQ-Plugin/package.json', import.meta.url))
      require('icqq') // The SDK entry initializes the parser's circular dependencies.
      ;({ parseMultiMsg } = require('icqq/lib/message/converter'))
    } catch { /* ICQQ is an optional adapter. */ }
  }
  return parseMultiMsg?.({ type: 'xml', data: payload })
}

export function forwardNodes(input, depth = 0) {
  const nodes = Array.isArray(input) ? input : input?.messages ?? input?.data?.messages ?? input?.data
  if (!Array.isArray(nodes)) return []
  return nodes.slice(0, 100).map(node => {
    const data = node?.type === 'node' && node.data && !Array.isArray(node.data) ? node.data : node
    return { nickname: String(data?.nickname || data?.name || data?.sender?.card || data?.sender?.nickname || data?.user_id || ''), message: segments(data?.message ?? data?.content ?? data?.raw_message, depth + 1) }
  })
}
export function segments(input, depth = 0) {
  if (input == null) return []
  if (depth > 8) return [{ type: 'text', text: '[嵌套消息层数过多]' }]
  return (Array.isArray(input) ? input : [input]).map(item => {
    if (!item || typeof item !== 'object') return { type: 'text', text: String(item ?? '') }
    const data = item.data && typeof item.data === 'object' && !Array.isArray(item.data) ? { ...item.data, ...item } : item
    const type = data.type || 'unknown'
    switch (type) {
      case 'text': return { type, text: String(data.text || '') }
      case 'at': return { type, qq: String(data.qq ?? data.user_id ?? 'all'), text: String(data.text || '').replace(/^@/, '') }
      case 'reply': return { type, id: String(data.id ?? data.message_id ?? '') }
      case 'face': return { type, id: String(data.id || ''), text: data.text || '' }
      case 'image': case 'mface': case 'file': case 'record': case 'video': return { type: type === 'mface' ? 'image' : type, file: data.file ?? data.file_id, url: data.url, name: String(data.name || data.summary || type), media_id: data.media_id, ...Object.fromEntries(['fid', 'md5', 'sha1', 'size', 'seconds', 'nt'].filter(key => data[key] !== undefined).map(key => [key, data[key]])) }
      case 'markdown': return { type, text: String(data.content || data.text || '') }
      case 'node': return { type: 'forward', id: String(data.id ?? ''), content: forwardNodes(Array.isArray(data.data) ? data.data : [data], depth) }
      case 'forward': case 'multimsg': return { type: 'forward', id: String(data.resid ?? data.id ?? ''), ...(data.filename ? { filename: String(data.filename) } : {}), content: forwardNodes(data.content ?? data.messages ?? data.data, depth) }
      case 'json': case 'xml': {
        const payload = data.data?.data ?? data.data
        let forward
        if (type === 'json') {
          try {
            const card = typeof payload === 'string' ? JSON.parse(payload) : payload
            const detail = card?.meta?.detail || card?.meta?.detail_1
            if ((card?.app === 'com.tencent.multimsg' || card?.view === 'viewMultiMsg') && detail?.resid) forward = { resid: detail.resid, filename: detail.uniseq }
          } catch { /* Ordinary or malformed cards retain their placeholder. */ }
        } else {
          try { forward = legacyForward(payload) } catch { /* Ignore malformed legacy ICQQ cards. */ }
        }
        return forward ? { type: 'forward', id: String(forward.resid), ...(forward.filename ? { filename: String(forward.filename) } : {}), content: [] } : { type, text: `[${type}]` }
      }
      default: return { type, text: `[${type}]` }
    }
  })
}
export function mediaLocator(item, context) {
  if (!['video', 'record'].includes(item.type) || !['group', 'private'].includes(context?.kind) || !context.target_id) return null
  const segment = Object.fromEntries(['type', 'file', 'fid', 'name', 'md5', 'sha1', 'size', 'seconds', 'nt'].filter(key => ['string', 'number', 'boolean'].includes(typeof item[key])).map(key => [key, item[key]]))
  for (const key of ['md5', 'sha1']) if (Buffer.isBuffer(item[key])) segment[key] = item[key].toString('hex')
  if (segment.file && (/^(?:https?|file|base64):\/\//i.test(segment.file) || /^[a-z]:[\\/]/i.test(segment.file))) delete segment.file
  if (!segment.file && !segment.fid) return null
  return { kind: context.kind, target_id: String(context.target_id), segment }
}
export async function sanitizeMedia(message, media, bot_id, trusted = false, context) {
  return Promise.all(message.map(async item => {
    if (item.type === 'forward') return { ...item, content: await Promise.all(item.content.map(async x => ({ ...x, message: await sanitizeMedia(x.message, media, bot_id, trusted, context) }))) }
    if (!['image', 'file', 'record', 'video'].includes(item.type)) return item
    let id = trusted ? item.media_id : undefined
    if (!trusted && item.url?.startsWith(`${base}/api/media/`)) {
      const known = await media.db.get('SELECT id FROM media WHERE id=? AND bot_id=?', [item.media_id || item.url.split('/').at(-1), bot_id])
      id = known?.id
    }
    try {
      if (!id && Buffer.isBuffer(item.file) && trusted && item.file.length <= media.max()) id = (await media.store(Readable.from(item.file), item.name, bot_id)).id
      if (!id && typeof item.file === 'string' && item.file.startsWith('base64://') && trusted && item.file.length < media.max() * 1.4) id = (await media.store(Readable.from(Buffer.from(item.file.slice(9), 'base64')), item.name, bot_id)).id
      if (!id) id = await media.register(item.url || item.file, bot_id, item.name, trusted, mediaLocator(item, context))
    } catch { /* A failed attachment must not prevent text recording or sending. */ }
    return { type: item.type, name: item.name, ...(id ? { media_id: id, url: `${base}/api/media/${id}` } : { unavailable: true }) }
  }))
}
export const preview = message => message.map(x => x.type === 'reply' ? '' : x.type === 'text' || x.type === 'markdown' ? x.text : x.type === 'at' ? `@${x.text?.replace(/^@/, '') || (x.qq === 'all' ? '全体成员' : x.qq)}` : ({ image: '[图片]', file: '[文件]', record: '[语音]', video: '[视频]', forward: '[合并转发]', face: '[表情]' }[x.type] || `[${x.type}]`)).join('').slice(0, 300)
export function received(event) {
  if (event.self_id == null || (event.group_id == null && event.user_id == null)) return null
  const bot_id = String(event.self_id), kind = event.group_id != null ? 'group' : 'private'
  const outgoing = event.post_type === 'message_sent' || String(event.sender?.user_id ?? event.user_id) === bot_id
  const target = kind === 'group' ? event.group_id : outgoing ? (event.target_id ?? event.peer_id ?? event.user_id) : event.user_id
  const result = {
    id: randomUUID(), bot_id, kind, target_id: String(target), platform_id: event.message_id == null ? null : String(event.message_id),
    time: Number(event.time || Date.now() / 1000), direction: outgoing ? 'out' : 'in', status: 'sent', origin: outgoing ? 'adapter' : 'received',
    sender: { user_id: String(event.sender?.user_id ?? event.user_id ?? bot_id), nickname: String(event.sender?.card || event.sender?.nickname || event.nickname || event.user_id || ''), role: event.sender?.role || '', avatar: event.sender?.avatar || event.sender?.avatar_url },
    conversation_avatar: event.group?.avatar || (kind === 'private' ? event.friend?.avatar : ''),
    conversation_name: String(event.group_name || event.group?.name || (kind === 'private' ? event.sender?.nickname : '') || target),
    message: segments(event.message || event.raw_message),
    quote: event.source ? { id: String(event.source.message_id ?? event.source.id ?? ''), text: preview(segments(event.source.message)), user_id: String(event.source.user_id ?? '') } : null
  }
  const reply = result.message.find(item => item.type === 'reply')
  if (reply && !result.quote?.id) result.quote = { text: '', user_id: '', ...result.quote, id: reply.id }
  if (result.time > 1e12) result.time /= 1000
  if (!Number.isFinite(result.time) || result.time <= 0) result.time = Date.now() / 1000
  return result
}
export function resultState(result) {
  if (Array.isArray(result)) {
    if (!result.length) return 'unknown'
    const states = result.map(resultState)
    if (states.some(state => state === 'failed' || state === 'partial')) return states.every(state => state === 'failed') ? 'failed' : 'partial'
    return states.includes('unknown') ? 'unknown' : 'sent'
  }
  if (result === false || result === null || result?.status === 'failed' || (typeof result?.retcode === 'number' && ![0, 1].includes(result.retcode))) return 'failed'
  const errors = result?.error || result?.errors
  if (Array.isArray(errors) && errors.length) return result?.data?.length || result?.message_id?.length ? 'partial' : 'failed'
  if (result === undefined || result === true) return 'unknown'
  return 'sent'
}
export function messageIds(result) {
  if (Array.isArray(result)) return [...new Set(result.flatMap(messageIds))]
  const id = result?.message_id ?? result?.id
  const ids = (Array.isArray(id) ? id : id == null ? [] : [id]).map(String)
  if (result?.data && typeof result.data === 'object') ids.push(...messageIds(result.data))
  return [...new Set(ids)]
}
