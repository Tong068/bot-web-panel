import express from 'express'
import path from 'node:path'
import fs from 'node:fs/promises'
import YAML from 'yaml'
import { Database } from './database.js'
import { Auth, cookieName } from './auth.js'
import { Media } from './media.js'
import { Bridge } from './bridge.js'
import { base, root, loadConfig, fail } from './config.js'

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
export async function createPanel(bot, options = {}) {
  if (!bot.express?._router && !bot.express?.use) throw new Error('Bot.express is required; no separate server will be started')
  const config = options.config || await loadConfig()
  if (!config.enabled) return { close: async () => {} }
  const dataDir = options.dataDir || path.join(root, 'data')
  const db = await new Database().open(path.join(dataDir, 'panel.sqlite'))
  const auth = new Auth(db, config), initialPassword = await auth.init()
  if (initialPassword && !options.testing) {
    await fs.writeFile(path.join(dataDir, 'initial-password.txt'), `admin\n${initialPassword}\n`, { mode: 0o600 })
    ;(options.log || globalThis.logger || console).info(`[BotWeb] 初始登录 admin / ${initialPassword}，首次登录后请修改密码。`)
  }
  const media = new Media(db, path.join(dataDir, 'media'), config); await media.init()
  const clients = new Map(), inflight = new Map()
  const log = options.log || globalThis.logger || console
  let closed = false
  const writeEvent = (res, entry) => {
    if (res.destroyed || res.writableEnded) return
    if (res.writableLength > 1048576) { res.end(); return }
    res.write(`id: ${entry.seq}\ndata: ${JSON.stringify(entry)}\n\n`)
  }
  const publish = async data => {
    if (closed) return
    const entry = await db.event(data)
    for (const [res, client] of clients) {
      if (client.replaying) { client.buffer.push(entry); if (client.buffer.length > 2000) res.end() }
      else if (entry.seq > client.cursor) { writeEvent(res, entry); client.cursor = entry.seq }
    }
    return entry
  }
  const bridge = new Bridge(bot, db, media, publish, log)
  media.resolveSource = (row, force) => bridge.mediaLinks.resolve(row, force)
  const router = express.Router()
  router.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'")
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store')
    next()
  })
  router.use('/api', express.json({ limit: '128kb' }))
  const cookieOptions = req => ({ httpOnly: true, sameSite: 'strict', secure: req.secure || config.allowedOrigins.includes(req.headers.origin) && req.headers.origin?.startsWith('https:'), path: `${base}/`, maxAge: config.sessionHours * 3600000 })
  router.post('/api/login', asyncRoute(async (req, res) => {
    auth.checkOrigin(req)
    const session = await auth.login(req.body?.username, req.body?.password, req.socket.remoteAddress)
    res.cookie(cookieName, session.id, cookieOptions(req)); res.json({ csrf: session.csrf, username: 'admin', expires: session.expires })
  }))
  router.use('/api', asyncRoute(async (req, res, next) => {
    req.panelSession = await auth.session(req)
    if (!req.panelSession) throw fail(401, '请先登录')
    if (!['GET', 'HEAD'].includes(req.method)) {
      auth.checkOrigin(req)
      if (req.headers['x-csrf-token'] !== req.panelSession.csrf) throw fail(403, '会话校验失败，请重新登录')
    }
    next()
  }))
  router.get('/api/session', (req, res) => res.json({ username: 'admin', csrf: req.panelSession.csrf, expires: req.panelSession.expires }))
  const closeSessions = id => { for (const [res, client] of clients) if (!id || client.session.id === id) res.end() }
  router.post('/api/logout', asyncRoute(async (req, res) => { await auth.logout(req.panelSession); closeSessions(req.panelSession.id); res.clearCookie(cookieName, { path: `${base}/` }); res.json({ ok: true }) }))
  router.post('/api/password', asyncRoute(async (req, res) => {
    if (!await auth.verify(req.body?.current)) throw fail(400, '当前密码错误')
    await auth.setPassword(req.body?.password); await fs.rm(path.join(dataDir, 'initial-password.txt'), { force: true }); closeSessions()
    res.clearCookie(cookieName, { path: `${base}/` }); res.json({ ok: true })
  }))
  router.get('/api/bots', asyncRoute(async (req, res) => res.json(await bridge.bots())))
  const publicSettings = () => Object.fromEntries(['retentionDays', 'uploadMaxMB', 'mediaCacheMB', 'sessionHours'].map(key => [key, config[key]]))
  router.get('/api/settings', (req, res) => res.json(publicSettings()))
  router.post('/api/settings', asyncRoute(async (req, res) => {
    for (const [key, min, max] of [['retentionDays', 1, 3650], ['uploadMaxMB', 1, 100], ['mediaCacheMB', 20, 102400]]) {
      if (!Number.isInteger(req.body?.[key]) || req.body[key] < min || req.body[key] > max) throw fail(400, `${key}: ${min}-${max}`)
    }
    const updated = { ...config, retentionDays: req.body.retentionDays, uploadMaxMB: req.body.uploadMaxMB, mediaCacheMB: req.body.mediaCacheMB }
    if (!options.testing) await fs.writeFile(path.join(root, 'config/config.yaml'), YAML.stringify(updated), { mode: 0o600 })
    Object.assign(config, updated); res.json(publicSettings())
  }))
  router.post('/api/action', asyncRoute(async (req, res) => {
    const { bot_id, action, params = {}, echo } = req.body || {}
    if (typeof action !== 'string' || !params || typeof params !== 'object' || Array.isArray(params)) throw fail(400, '无效请求')
    let data
    if (action.startsWith('send_')) {
      const key = JSON.stringify([bot_id, params.request_id])
      const fingerprint = JSON.stringify([action, params])
      if (inflight.has(key) && inflight.get(key).fingerprint !== fingerprint) throw fail(409, '发送请求标识已被使用')
      if (!inflight.has(key)) inflight.set(key, { fingerprint, promise: bridge.action(bot_id, action, params).finally(() => inflight.delete(key)) })
      data = await inflight.get(key).promise
    } else data = await bridge.action(bot_id, action, params)
    res.json({ status: 'ok', retcode: 0, echo, bot_id, data })
  }))
  router.post('/api/uploads', asyncRoute(async (req, res) => {
    const botId = req.headers['x-bot-id']; bridge.get(botId, true)
    if (req.headers['content-type'] !== 'application/octet-stream') throw fail(415, '请选择二进制文件上传')
    if (Number(req.headers['content-length']) > media.max()) throw fail(413, '文件超过上传大小限制')
    const name = decodeURIComponent(req.headers['x-file-name'] || 'attachment')
    const file = await media.store(req, name, botId)
    res.json({ id: file.id, name: file.name, size: file.size, mime: file.mime, url: file.url })
  }))
  router.get('/api/media/:id', asyncRoute(async (req, res) => {
    const file = await media.get(req.params.id)
    const inline = /^(image\/(png|jpeg|gif|webp|avif)|audio\/|video\/)/.test(file.mime)
    res.setHeader('Content-Type', inline ? file.mime : 'application/octet-stream')
    res.setHeader('Content-Disposition', `${inline && !req.query.download ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`)
    res.sendFile(file.path)
  }))
  router.get('/api/events', asyncRoute(async (req, res) => {
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    res.flushHeaders()
    const cursor = Number(req.headers['last-event-id'] || req.query.cursor || 0)
    const client = { cursor: Number.isSafeInteger(cursor) && cursor > 0 ? cursor : 0, session: req.panelSession, replaying: true, buffer: [] }
    clients.set(res, client); res.on('close', () => clients.delete(res))
    const bounds = await db.get('SELECT MIN(seq) first,MAX(seq) last FROM events')
    const last = bounds.last || 0
    if (client.cursor && client.cursor >= (bounds.first || 0) - 1 && client.cursor <= last) {
      const rows = await db.all('SELECT seq,body FROM events WHERE seq>? AND seq<=? ORDER BY seq LIMIT 2001', [client.cursor, last])
      if (rows.length > 2000) writeEvent(res, { seq: last, type: 'reset' })
      else for (const row of rows) writeEvent(res, { ...JSON.parse(row.body), seq: row.seq })
    } else writeEvent(res, { seq: last, type: 'reset' })
    client.cursor = last; client.replaying = false
    for (const entry of client.buffer) if (entry.seq > client.cursor) { writeEvent(res, entry); client.cursor = entry.seq }
    client.buffer = []
    res.write(': connected\n\n')
  }))
  router.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }))
  router.get('/', (req, res, next) => { if (req.originalUrl.split('?')[0] === base) res.redirect(`${base}/`); else next() })
  router.use(express.static(options.staticDir || path.join(root, 'web/dist'), { index: 'index.html', fallthrough: true, dotfiles: 'deny' }))
  router.use((req, res) => res.status(404).send('页面资源不存在，请先构建前端。'))
  router.use((error, req, res, next) => {
    if (res.headersSent) { res.end(); return }
    const status = error.status || (error.type === 'entity.too.large' ? 413 : 500)
    if (status >= 500) log.error?.(`[BotWeb] 请求失败: ${error.message}`)
    res.status(status).json({ error: status >= 500 ? '操作失败，请检查机器人日志' : error.message })
  })
  const app = bot.express
  app.use(base, router)
  const stack = app._router.stack, layer = stack.pop()
  // Express initializes req/res before this router; framework body parsers and logging follow it.
  const init = stack.findIndex(item => item.name === 'expressInit')
  stack.splice(init >= 0 ? init + 1 : 0, 0, layer)
  bridge.start()
  const heartbeat = setInterval(async () => {
    for (const [res, client] of clients) {
      if (client.session.expires <= Date.now()) { res.end(); continue }
      try { if (!await db.get('SELECT id FROM sessions WHERE id=?', [client.session.id])) res.end(); else res.write(': heartbeat\n\n') } catch { res.end() }
    }
  }, 20000); heartbeat.unref?.()
  const cleanup = async () => { try { await db.cleanup(config.retentionDays); await media.cleanup(config.retentionDays) } catch (e) { log.error?.(`[BotWeb] 清理失败: ${e.message}`) } }
  const cleanupTimer = setInterval(cleanup, 3600000); cleanupTimer.unref?.()
  await cleanup()
  // A crash may leave a send without a receipt. Never silently retry it.
  for (const row of await db.all("SELECT body FROM messages WHERE json_extract(body,'$.status')='sending'")) await bridge.record({ ...JSON.parse(row.body), status: 'unknown' })
  return { db, auth, media, bridge, router, initialPassword, config,
    async close() {
      if (closed) return
      closed = true; clearInterval(heartbeat); clearInterval(cleanupTimer); closeSessions()
      const index = stack.indexOf(layer); if (index >= 0) stack.splice(index, 1)
      const recording = bridge.close()
      await media.close(); await recording; await db.close()
    }
  }
}
