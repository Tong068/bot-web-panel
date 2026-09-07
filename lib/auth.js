import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { fail } from './config.js'
const scrypt = promisify(scryptCallback)
const token = () => randomBytes(32).toString('hex')
const digest = value => createHash('sha256').update(value).digest('hex')
export const cookieName = 'bot_web_session'
export const quickLoginLifetime = 3 * 60 * 1000
export class Auth {
  constructor(db, config) { this.db = db; this.config = config; this.attempts = new Map() }
  async init() {
    if (await this.db.setting('admin')) return
    const password = randomBytes(15).toString('base64url')
    await this.setPassword(password)
    return password
  }
  async setPassword(password) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw fail(400, '密码长度必须为 12 至 128 个字符')
    const salt = token(); const hash = (await scrypt(password, salt, 64)).toString('hex')
    await this.db.serialized(async () => {
      await this.db.setting('admin', { username: 'admin', salt, hash })
      await this.db.run('DELETE FROM sessions')
      await this.db.run('DELETE FROM quick_logins')
    })
  }
  async verify(password) {
    if (typeof password !== 'string' || password.length > 128) return false
    const admin = await this.db.setting('admin'); if (!admin) return false
    return timingSafeEqual(await scrypt(password, admin.salt, 64), Buffer.from(admin.hash, 'hex'))
  }
  async login(username, password, ip) {
    const now = Date.now(); const attempt = this.attempts.get(ip)
    if (attempt?.until > now && attempt.count >= 5) throw fail(429, '登录失败次数过多，请 15 分钟后重试')
    this.attempts.set(ip, { count: (attempt?.until > now ? attempt.count : 0) + 1, until: now + 900000 })
    if (this.attempts.size > 10000) for (const [key, value] of this.attempts) if (value.until < now) this.attempts.delete(key)
    return this.db.serialized(async () => {
      if (!await this.verify(password) || username !== 'admin') throw fail(401, '账号或密码错误')
      this.attempts.delete(ip)
      return this.createSession()
    })
  }
  async createQuickLogin() {
    const code = token(), expires = Date.now() + quickLoginLifetime
    await this.db.run('DELETE FROM quick_logins WHERE expires<=?', [Date.now()])
    await this.db.run('INSERT INTO quick_logins VALUES(?,?)', [digest(code), expires])
    return code
  }
  async revokeQuickLogin(code) { await this.db.run('DELETE FROM quick_logins WHERE id=?', [digest(code)]) }
  async quickLogin(code) {
    if (typeof code !== 'string' || !/^[a-f0-9]{64}$/.test(code)) throw fail(401, '登录链接无效或已过期，请重新发送 #面板登录')
    return this.db.serialized(async () => {
      // Consume atomically and finish the session before a password reset can revoke it.
      const { changes } = await this.db.run('DELETE FROM quick_logins WHERE id=? AND expires>?', [digest(code), Date.now()])
      if (!changes) throw fail(401, '登录链接无效或已过期，请重新发送 #面板登录')
      return this.createSession()
    })
  }
  async createSession() {
    const id = token(), csrf = token(), expires = Date.now() + this.config.sessionHours * 3600000
    await this.db.run('INSERT INTO sessions VALUES(?,?,?)', [digest(id), csrf, expires])
    return { id, csrf, expires }
  }
  async session(req) {
    const id = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
    if (!id || !/^[a-f0-9]{64}$/.test(id)) return null
    const session = await this.db.get('SELECT * FROM sessions WHERE id=? AND expires>?', [digest(id), Date.now()])
    return session || null
  }
  checkOrigin(req) {
    const origin = req.headers.origin
    const same = `${req.protocol}://${req.headers.host}`
    if (!origin || (origin !== same && !this.config.allowedOrigins.includes(origin))) throw fail(403, '请求来源不受信任')
  }
  async logout(session) { if (session) await this.db.run('DELETE FROM sessions WHERE id=?', [session.id]) }
}
