import fs from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import path from 'node:path'
import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileTypeFromFile } from 'file-type'
import { base, fail } from './config.js'
import { ntImageSource, ntMediaSource } from './rkeys.js'

export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0))
  }
  return isIP(address) === 6 && /^[23]/i.test(address) && !address.toLowerCase().startsWith('2001:db8:')
}
export class Media {
  constructor(db, directory, config) { this.db = db; this.directory = directory; this.config = config; this.pending = new Map(); this.queue = Promise.resolve(); this.controller = new AbortController() }
  async init() {
    await fs.mkdir(this.directory, { recursive: true })
    for (const row of await this.db.all("SELECT id,source FROM media WHERE source LIKE 'http%://multimedia.nt.qq.com.cn/%'")) {
      const source = ntImageSource(row.source)?.href
      if (source && source !== row.source) await this.db.run('UPDATE media SET source=? WHERE id=?', [source, row.id])
    }
  }
  max() { return this.config.uploadMaxMB * 1048576 }
  async record(row) {
    await this.db.run('INSERT INTO media(id,source,path,name,mime,size,created,bot_id,locator) VALUES(?,?,?,?,?,?,?,?,?)', [row.id, row.source || null, row.path || null, row.name || 'attachment', row.mime || '', row.size || 0, Date.now(), row.bot_id, row.locator || null])
    return row.id
  }
  file(id) { if (!/^[a-f0-9-]{36}$/.test(id)) throw fail(400, '无效媒体标识'); return path.join(this.directory, id) }
  async store(stream, name, bot_id, id = randomUUID()) {
    const work = this.queue.then(async () => {
      if (this.controller.signal.aborted) { stream.destroy(); throw fail(503, '消息面板已停止') }
      const file = this.file(id); let size = 0
      const limiter = new Transform({ transform: (chunk, encoding, next) => { size += chunk.length; next(size > this.max() ? fail(413, '文件超过上传大小限制') : null, chunk) } })
      try {
        await pipeline(stream, limiter, createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal: this.controller.signal })
        const type = await fileTypeFromFile(file).catch(() => null)
        await this.ensureCapacity(size)
        const row = { id, path: file, size, name: path.basename(String(name || 'attachment')).slice(0, 200), mime: type?.mime || 'application/octet-stream', bot_id }
        const existing = await this.db.get('SELECT id FROM media WHERE id=?', [id])
        if (existing) await this.db.run('UPDATE media SET path=?,size=?,mime=? WHERE id=?', [file, size, row.mime, id])
        else await this.record(row)
        return { ...row, url: `${base}/api/media/${id}` }
      } catch (e) { await fs.rm(file, { force: true }); throw e }
    })
    this.queue = work.catch(() => {}); return work
  }
  async ensureCapacity(incoming) {
    const max = this.config.mediaCacheMB * 1048576
    if (incoming > max) throw fail(413, '文件超过媒体缓存容量')
    const rows = await this.db.all('SELECT id,path,size FROM media WHERE path IS NOT NULL ORDER BY created')
    let total = rows.reduce((sum, r) => sum + r.size, incoming)
    for (const row of rows) {
      if (total <= max) break
      if (this.pending.has(row.id)) continue
      await fs.rm(this.file(row.id), { force: true }); total -= row.size
      await this.db.run('UPDATE media SET path=NULL,size=0 WHERE id=?', [row.id])
    }
    if (total > max) throw fail(503, '媒体缓存繁忙，请稍后重试')
  }
  async register(source, bot_id, name, trusted = false, locator) {
    if (locator) {
      const reference = JSON.stringify(locator)
      const old = await this.db.get('SELECT id FROM media WHERE locator=? AND bot_id=?', [reference, bot_id])
      if (old) return old.id
      const url = /^https?:\/\//i.test(source || '') ? new URL(source) : null
      if (url?.username || url?.password) return null
      return this.record({ id: randomUUID(), source: ntMediaSource(source)?.href || url?.href, bot_id, name, locator: reference })
    }
    if (typeof source !== 'string') return null
    if (/^https?:\/\//i.test(source)) {
      const url = ntImageSource(source) || new URL(source)
      if (url.username || url.password) return null
      const old = await this.db.get('SELECT id FROM media WHERE source=? AND bot_id=?', [url.href, bot_id])
      if (old) return old.id
      return this.record({ id: randomUUID(), source: url.href, bot_id, name })
    }
    if (trusted) {
      let file = source.startsWith('file://') ? (await import('node:url')).fileURLToPath(source) : source
      file = await fs.realpath(path.resolve(file)).catch(() => '')
      if (!file) return null
      const relative = path.relative(await fs.realpath(process.cwd()), file)
      if (relative.startsWith('..') || path.isAbsolute(relative)) return null
      const stat = await fs.stat(file).catch(() => null)
      if (stat?.isFile() && stat.size <= this.max()) return (await this.store(createReadStream(file), name || path.basename(file), bot_id)).id
    }
    return null
  }
  async fetch(urlString, hops = 0) {
    this.controller.signal.throwIfAborted()
    if (hops > 3) throw fail(502, '媒体重定向次数过多')
    const url = new URL(urlString)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail(400, '媒体地址不可用')
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    const addresses = await dns.lookup(hostname, { all: true })
    this.controller.signal.throwIfAborted()
    if (!addresses.length || (!this.config.mediaHosts.includes(url.host) && addresses.some(x => !publicAddress(x.address)))) throw fail(403, '媒体服务器地址不允许访问')
    const selected = addresses[0]
    const response = await new Promise((resolve, reject) => {
      const req = (url.protocol === 'https:' ? https : http).get(url, { signal: this.controller.signal, lookup: (_host, options, cb) => options.all ? cb(null, [selected]) : cb(null, selected.address, selected.family), timeout: 15000, headers: { 'User-Agent': 'Yunzai-Bot-Web-Panel/1.0', Accept: '*/*' } }, resolve)
      req.on('timeout', () => req.destroy(fail(504, '媒体下载超时'))); req.on('error', reject)
    })
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) { response.destroy(); return this.fetch(new URL(response.headers.location, url).href, hops + 1) }
    if (response.statusCode !== 200) { response.destroy(); throw Object.assign(fail(502, `媒体服务器返回 ${response.statusCode}`), { upstreamStatus: response.statusCode }) }
    if (Number(response.headers['content-length']) > this.max()) { response.destroy(); throw fail(413, '媒体超过大小限制') }
    return response
  }
  async download(row) {
    const source = ntImageSource(row.source)?.href || row.source
    if (source !== row.source) await this.db.run('UPDATE media SET source=? WHERE id=?', [source, row.id])
    const resolve = force => this.resolveSource ? this.resolveSource({ ...row, source }, force) : source
    let stream
    try { stream = await this.fetch(await resolve(false)) }
    catch (error) {
      if ((!ntMediaSource(source) && !row.locator) || ![400, 401, 403, 404, 410].includes(error.upstreamStatus)) throw error
      stream = await this.fetch(await resolve(true))
    }
    return this.store(stream, row.name, row.bot_id, row.id)
  }
  async get(id) {
    this.controller.signal.throwIfAborted()
    this.file(id)
    const row = await this.db.get('SELECT * FROM media WHERE id=?', [id])
    if (!row) throw fail(404, '媒体已过期或不存在')
    if (row.path && await fs.stat(this.file(id)).catch(() => null)) return { ...row, path: this.file(id) }
    if (!row.source && !row.locator) throw fail(410, '媒体缓存已清理')
    if (!this.pending.has(id)) this.pending.set(id, this.download(row).finally(() => this.pending.delete(id)))
    return this.pending.get(id)
  }
  async cleanup(days) {
    const rows = await this.db.all('SELECT id FROM media WHERE created<?', [Date.now() - days * 86400000])
    for (const row of rows) { if (this.pending.has(row.id)) continue; await fs.rm(this.file(row.id), { force: true }); await this.db.run('DELETE FROM media WHERE id=?', [row.id]) }
    await this.ensureCapacity(0)
  }
  async close() {
    this.controller.abort()
    await Promise.allSettled([...this.pending.values(), this.queue])
  }
}
