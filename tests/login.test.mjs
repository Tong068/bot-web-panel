import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createPanel } from '../lib/server.js'
import { Auth, quickLoginLifetime } from '../lib/auth.js'
import { framework, inject, config } from './helpers.mjs'

globalThis.plugin = class {
  constructor(options) { Object.assign(this, options) }
  reply(...args) { return this.e.reply(...args) }
}
const { PanelCommand, stateKey } = await import('../lib/commands.js')
const origin = 'http://localhost:2536'
async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-web-login-'))
  const bot = framework()
  bot.makeForwardMsg = nodes => ({ type: 'node', data: nodes })
  bot.server = { address: () => ({ address: '127.0.0.1', port: 2536 }) }
  const panel = await createPanel(bot, { config: { ...config }, dataDir: directory, testing: true })
  globalThis.Bot = bot; globalThis[stateKey] = panel
  t.after(async () => { delete globalThis[stateKey]; delete globalThis.Bot; await panel.close(); await fs.rm(directory, { recursive: true, force: true }) })
  const exchange = (code, requestOrigin = origin) => inject(bot.express, '/bot-web/api/login/quick', { method: 'POST', headers: { origin: requestOrigin }, body: { code } })
  return { panel, bot, exchange }
}
function command(bot, overrides = {}) {
  const replies = [], instance = new PanelCommand()
  instance.e = { isMaster: true, user_id: '100', self_id: '11', bot: bot.bots['11'], async reply(text) { replies.push(text); return true }, ...overrides }
  return { instance, replies }
}
const messageText = message => typeof message === 'string' ? message : message.data.map(node => node.message).join('\n')
const codeFrom = message => new URL(messageText(message).split('\n').find(line => line.startsWith('http'))).hash.slice('#login='.length)

test('quick login exchanges a hashed single-use code for the existing cookie and CSRF session', async t => {
  const { panel, bot, exchange } = await setup(t)
  const code = await panel.auth.createQuickLogin()
  const row = await panel.db.get('SELECT * FROM quick_logins')
  assert.equal(row.id, createHash('sha256').update(code).digest('hex'))
  assert.ok(row.expires > Date.now() && row.expires <= Date.now() + quickLoginLifetime)
  assert.equal((await exchange(code, 'http://untrusted.test')).status, 403)
  const responses = await Promise.all([exchange(code), exchange(code)])
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 401])
  const success = responses.find(r => r.status === 200), value = success.headers['set-cookie']
  const cookie = Array.isArray(value) ? value[0] : value
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Path=\/bot-web\//)
  const headers = { cookie: cookie.split(';')[0], origin }
  const session = await inject(bot.express, '/bot-web/api/session', { headers })
  assert.equal(session.status, 200); assert.equal(session.json().csrf, success.json().csrf)
  assert.equal((await inject(bot.express, '/bot-web/api/logout', { method: 'POST', headers, body: {} })).status, 403)
  assert.equal((await inject(bot.express, '/bot-web/api/logout', { method: 'POST', headers: { ...headers, 'x-csrf-token': success.json().csrf }, body: {} })).status, 200)
  assert.equal((await inject(bot.express, '/bot-web/api/session', { headers })).status, 401)
  assert.deepEqual(bot.logs, [])
})

test('expired, malformed, revoked and password-reset login codes are rejected', async t => {
  const { panel, exchange } = await setup(t)
  for (const code of [undefined, null, {}, '', 'x'.repeat(64), 'a'.repeat(64)]) assert.equal((await exchange(code)).status, 401)
  const expired = await panel.auth.createQuickLogin()
  await panel.db.run('UPDATE quick_logins SET expires=0')
  assert.equal((await exchange(expired)).status, 401)
  const revoked = await panel.auth.createQuickLogin()
  await panel.auth.revokeQuickLogin(revoked)
  assert.equal((await exchange(revoked)).status, 401)
  const reset = await panel.auth.createQuickLogin()
  const session = await panel.auth.quickLogin(await panel.auth.createQuickLogin())
  await new Auth(panel.db, panel.config).setPassword('replacement-admin-password')
  assert.equal((await exchange(reset)).status, 401)
  assert.equal(await panel.auth.session({ headers: { cookie: `bot_web_session=${session.id}` } }), null)
})

test('master command supports aliases and privately returns a usable login link', async t => {
  const { panel, bot, exchange } = await setup(t), { instance, replies } = command(bot)
  const rule = instance.rule.find(rule => rule.fnc === 'login'), pattern = new RegExp(rule.reg)
  for (const value of ['#面板登录', '#消息面板登录', '#面板登陆', '消息面板登陆']) assert.match(value, pattern)
  assert.doesNotMatch('#锅巴登录', pattern); assert.equal(rule.permission, 'master')
  instance.e.isMaster = false
  assert.equal(await instance.login(), false); assert.equal(replies.length, 0)
  assert.equal((await panel.db.all('SELECT * FROM quick_logins')).length, 0)
  instance.e.isMaster = true
  assert.equal(await instance.login(), true)
  assert.equal(replies[0].type, 'node')
  for (const label of ['自定义地址', '内网地址', '外网地址', 'IPv6 地址']) assert.ok(replies[0].data.some(node => node.message.startsWith(`${label}：`)))
  assert.equal((await exchange(codeFrom(replies[0]))).status, 200)
})

test('group login uses the triggering bot for private delivery and never replies with the link in the group', async t => {
  const { bot, exchange } = await setup(t), messages = []
  let builtForFriend = false
  bot.bots['22'].pickFriend = id => ({
    async makeForwardMsg(nodes) { builtForFriend = true; return { type: 'node', data: nodes } },
    async sendMsg(message) { messages.push({ id, message }); return true }
  })
  const { instance, replies } = command(bot, { isGroup: true, self_id: '22', bot: bot.bots['22'] })
  await instance.login()
  assert.equal(builtForFriend, true)
  assert.equal(messages[0].message.type, 'node')
  assert.ok(messages[0].message.data.every(node => node.user_id === '22'))
  assert.equal(messages.length, 1); assert.equal(messages[0].id, '100')
  assert.ok(replies.every(reply => !reply.includes('#login=')))
  assert.equal((await exchange(codeFrom(messages[0].message))).status, 200)
})

test('failed private delivery revokes the link and disabled panels do not issue one', async t => {
  const { panel, bot, exchange } = await setup(t)
  let undelivered
  bot.bots['11'].pickFriend = () => ({ async sendMsg(message) { undelivered = codeFrom(message); return false } })
  const { instance, replies } = command(bot, { message_type: 'group' })
  await instance.login()
  assert.equal((await exchange(undelivered)).status, 401)
  assert.ok(replies.every(reply => !reply.includes('#login=')))
  assert.equal((await panel.db.all('SELECT * FROM quick_logins')).length, 0)
  globalThis[stateKey] = { close: async () => {} }
  await instance.login()
  assert.match(replies.at(-1), /未启用/)
})

test('forward construction failure revokes the code without leaking it into a group', async t => {
  const { panel, bot } = await setup(t)
  bot.makeForwardMsg = () => { throw new Error('Adapter cannot build forwards') }
  const { instance, replies } = command(bot, { isGroup: true })
  await instance.login()
  assert.equal((await panel.db.all('SELECT * FROM quick_logins')).length, 0)
  assert.ok(replies.every(reply => !reply.includes('#login=')))
  assert.match(replies.at(-1), /发送失败/)
})
