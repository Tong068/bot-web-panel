import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Server } from 'node:net'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import dns from 'node:dns/promises'
import { createPanel } from '../lib/server.js'
import { Database, conversationKey } from '../lib/database.js'
import { publicAddress } from '../lib/media.js'
import { resultState } from '../lib/messages.js'
import { framework, incoming, inject, config, addBot } from './helpers.mjs'

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-web-test-'))
  const bot = framework(), log = { info() {}, error() {} }
  const original = bot.bots['11'].adapter.sendGroupMsg
  const panel = await createPanel(bot, { config: { ...config }, dataDir: directory, testing: true, log })
  t.after(async () => { await panel.close(); assert.equal(bot.bots['11'].adapter.sendGroupMsg, original); await fs.rm(directory, { recursive: true, force: true }) })
  return { panel, bot, directory }
}
async function login(bot, panel) {
  const response = await inject(bot.express, '/bot-web/api/login', { method: 'POST', body: { username: 'admin', password: panel.initialPassword }, headers: { origin: 'http://localhost:2536' } })
  assert.equal(response.status, 200, response.text)
  const value = response.headers['set-cookie']
  return { cookie: (Array.isArray(value) ? value[0] : value).split(';')[0], 'x-csrf-token': response.json().csrf, origin: 'http://localhost:2536' }
}
test('mount shares Express, adds no listener, protects APIs before framework logs and restores hooks', async t => {
  const listen = t.mock.method(Server.prototype, 'listen', () => assert.fail('No new port allowed'))
  const { panel, bot } = await setup(t)
  assert.equal(listen.mock.callCount(), 0)
  assert.equal((await inject(bot.express, '/existing')).status, 200)
  assert.equal((await inject(bot.express, '/bot-web/api/bots')).status, 401)
  const headers = await login(bot, panel)
  assert.equal((await inject(bot.express, '/bot-web/api/bots', { headers })).json().length, 3)
  assert.deepEqual(bot.logs, ['/existing'])
  assert.equal((await inject(bot.express, '/bot-web')).status, 302)
})
test('same IDs across bots and conversation types stay isolated and persisted', async t => {
  const { panel, bot, directory } = await setup(t)
  for (const id of ['11', '22', 'official']) for (const kind of ['group', 'private']) bot.emit('message', incoming(id, kind, 'same-id'))
  await panel.bridge.tasks
  assert.equal((await panel.db.all('SELECT * FROM messages')).length, 6)
  assert.equal((await panel.db.history(conversationKey('11', 'group', '100')))[0].bot_id, '11')
  const second = await new Database().open(path.join(directory, 'panel.sqlite'))
  assert.equal((await second.all('SELECT * FROM messages')).length, 6); await second.close()
})
test('selected bot sends only once for concurrent duplicate requests; group and private IDs do not collide', async t => {
  const { panel, bot } = await setup(t), headers = await login(bot, panel)
  const body = { bot_id: '22', action: 'send_group_msg', params: { target_id: '100', request_id: randomUUID(), message: [{ type: 'text', text: 'selected account' }] } }
  const responses = await Promise.all([inject(bot.express, '/bot-web/api/action', { method: 'POST', headers, body }), inject(bot.express, '/bot-web/api/action', { method: 'POST', headers, body })])
  assert.equal(responses[0].status, 200, responses[0].text)
  assert.equal(bot.calls.length, 1); assert.equal(bot.calls[0].self_id, '22')
  assert.equal(responses[0].json().data.status, 'sent')
  const replay = await inject(bot.express, '/bot-web/api/action', { method: 'POST', headers, body }); assert.equal(replay.status, 200); assert.equal(bot.calls.length, 1)
})
test('automatic replies are observed without replacing promises and duplicate reports are merged', async t => {
  const { panel, bot } = await setup(t)
  await bot.bots['11'].pickGroup('100').sendMsg('auto reply'); await panel.bridge.tasks
  bot.emit('message', { ...incoming('11', 'group', 'sent-1', 'auto reply'), user_id: '11', sender: { user_id: '11', nickname: 'bot' } }); await panel.bridge.tasks
  assert.equal((await panel.db.all('SELECT * FROM messages')).length, 1)
  const rows = await panel.db.history(conversationKey('11', 'group', '100')); assert.equal(rows[0].direction, 'out')
})
test('new bot connections get hooks, offline and unsupported actions fail explicitly', async t => {
  const { panel, bot } = await setup(t)
  addBot(bot, '33'); bot.emit('connect', { self_id: '33' }); await bot.bots['33'].pickFriend('100').sendMsg('new'); await panel.bridge.tasks
  assert.equal((await panel.db.conversations('33')).length, 1)
  bot.bots['22'].online = false
  await assert.rejects(panel.bridge.send('22', { kind: 'group', target_id: '100', request_id: randomUUID(), message: [{ type: 'text', text: 'no' }] }), /离线/)
  await assert.rejects(panel.bridge.action('11', 'eval', {}), /未开放/)
  await assert.rejects(panel.bridge.action(undefined, 'get_contacts'), /必须指定/)
})
test('quote, at, file, recall, partial/failed/unknown send states', async t => {
  const { panel, bot } = await setup(t)
  bot.emit('message', incoming('11')); await panel.bridge.tasks
  const original = (await panel.db.history(conversationKey('11', 'group', '100')))[0]
  const result = await panel.bridge.send('11', { kind: 'group', target_id: '100', request_id: randomUUID(), quote_id: original.id, message: [{ type: 'at', qq: '200' }, { type: 'text', text: 'quoted' }] })
  assert.equal(bot.calls[0].message[0].type, 'reply'); assert.equal(bot.calls[0].message[1].qq, '200')
  assert.equal((await panel.bridge.action('11', 'delete_msg', { id: result.id })).recalled, true)
  assert.equal(resultState({ error: ['failure'], data: [{}] }), 'partial'); assert.equal(resultState(false), 'failed'); assert.equal(resultState(undefined), 'unknown')
})
test('auth rejects CSRF/cross-origin, rate limits login, password changes invalidate sessions', async t => {
  const { panel, bot } = await setup(t), headers = await login(bot, panel)
  assert.equal((await inject(bot.express, '/bot-web/api/action', { method: 'POST', headers: { ...headers, 'x-csrf-token': '' }, body: {} })).status, 403)
  assert.equal((await inject(bot.express, '/bot-web/api/action', { method: 'POST', headers: { ...headers, origin: 'http://evil.test' }, body: {} })).status, 403)
  for (let n = 0; n < 5; n++) assert.equal((await inject(bot.express, '/bot-web/api/login', { method: 'POST', headers, body: { username: 'admin', password: 'wrong' } })).status, 401)
  assert.equal((await inject(bot.express, '/bot-web/api/login', { method: 'POST', headers, body: { username: 'admin', password: 'wrong' } })).status, 429)
  await panel.auth.setPassword('a-strong-new-password'); assert.equal((await inject(bot.express, '/bot-web/api/session', { headers })).status, 401)
})
test('binary uploads are scoped and image sending rejects non-images; path and address validation', async t => {
  const { panel, bot } = await setup(t), headers = await login(bot, panel)
  const upload = await inject(bot.express, '/bot-web/api/uploads', { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-bot-id': '11', 'x-file-name': 'test.txt' }, body: Buffer.from('file contents') })
  assert.equal(upload.status, 200, upload.text)
  const id = upload.json().id
  await assert.rejects(panel.bridge.send('22', { kind: 'group', target_id: '100', request_id: randomUUID(), message: [{ type: 'file', media_id: id }] }), /其他机器人/)
  await assert.rejects(panel.bridge.send('11', { kind: 'group', target_id: '100', request_id: randomUUID(), message: [{ type: 'image', media_id: id }] }), /有效图片/)
  assert.equal((await panel.bridge.send('11', { kind: 'group', target_id: '100', request_id: randomUUID(), message: [{ type: 'file', media_id: id }] })).status, 'sent')
  await assert.rejects(panel.media.get('../../secret'), /无效/)
  for (const address of ['127.0.0.1', '10.0.0.2', '169.254.169.254', '::1', '::ffff:127.0.0.1']) assert.equal(publicAddress(address), false)
  assert.equal(publicAddress('8.8.8.8'), true)
})
test('retention and read markers survive, expired sessions are rejected', async t => {
  const { panel, bot } = await setup(t), headers = await login(bot, panel)
  bot.emit('message', incoming('11')); await panel.bridge.tasks
  const key = conversationKey('11', 'group', '100'), message = (await panel.db.history(key))[0]
  assert.equal((await panel.db.conversations('11'))[0].unread, 1)
  await panel.db.read(key, message.seq); assert.equal((await panel.db.conversations('11'))[0].unread, 0)
  await panel.db.run('UPDATE messages SET created=?', [Date.now() - 8 * 86400000]); await panel.db.cleanup(7)
  assert.equal((await panel.db.history(key)).length, 0)
  await panel.db.run('UPDATE sessions SET expires=0'); assert.equal((await inject(bot.express, '/bot-web/api/session', { headers })).status, 401)
})
test('SSE uses the same router and replays event cursor on reconnect', async t => {
  const { panel, bot } = await setup(t), headers = await login(bot, panel)
  bot.emit('message', incoming('11')); await panel.bridge.tasks
  const last = (await panel.db.get('SELECT MAX(seq) seq FROM events')).seq
  bot.emit('message', incoming('22', 'group', 'm2')); await panel.bridge.tasks
  const response = await inject(bot.express, '/bot-web/api/events', { headers: { ...headers, 'last-event-id': String(last) }, stream: true })
  assert.equal(response.status, 200); assert.match(Buffer.concat(response.chunks).toString(), /"bot_id":"22"/); response.res.end()
})
test('echo before send receipt merges with pending row, preserves panel ID and unread count', async t => {
  const { panel, bot } = await setup(t)
  bot.bots['11'].pickGroup = group_id => ({ async sendMsg(message) {
    bot.emit('message', { ...incoming('11', 'group', 'early-echo'), user_id: '11', sender: { user_id: '11' }, message })
    await panel.bridge.tasks
    return { message_id: 'early-echo' }
  } })
  const request_id = randomUUID(), result = await panel.bridge.send('11', { kind: 'group', target_id: '100', request_id, message: [{ type: 'text', text: 'one delivery' }] })
  assert.equal(result.id, request_id)
  assert.equal((await panel.db.all('SELECT * FROM messages')).length, 1)
  assert.equal((await panel.db.conversations('11'))[0].unread, 0)
})
test('ICQQ central send and direct SDK-compatible framework methods are recorded', async t => {
  const { panel, bot } = await setup(t)
  const original = async (id, pick, msg) => ({ message_id: 'icqq-auto' })
  const adapter = { id: 'QQ', name: 'ICQQ', sendMsg: original }
  const instance = { adapter, online: true, nickname: 'ICQQ', fl: new Map(), gl: new Map(), sendGroupMsg: async () => ({ message_id: 'icqq-direct' }), pickGroup: group_id => ({ group_id, sendMsg: msg => adapter.sendMsg('icqq', { group_id }, msg) }) }
  bot.bots.icqq = instance; bot.uin.push('icqq'); bot.emit('connect', { self_id: 'icqq' })
  assert.equal((await panel.bridge.action('icqq', 'get_capabilities', { kind: 'group', target_id: '100' })).quote, true)
  await instance.pickGroup('100').sendMsg('auto'); await instance.sendGroupMsg('200', 'direct'); await panel.bridge.tasks
  assert.equal((await panel.db.conversations('icqq')).length, 2)
  await panel.close(); assert.equal(adapter.sendMsg, original)
})
test('text success followed by file failure records partial delivery, not a wholly failed send', async t => {
  const { panel, bot } = await setup(t)
  const upload = await panel.media.store(Readable.from('file'), 'file.txt', '11')
  bot.bots['11'].pickGroup = () => ({ sendMsg: async () => ({ message_id: 'text-ok' }), sendFile: async () => { throw new Error('file rejected') } })
  const result = await panel.bridge.send('11', { kind: 'group', target_id: '100', request_id: randomUUID(), message: [{ type: 'text', text: 'delivered' }, { type: 'file', media_id: upload.id }] })
  assert.equal(result.status, 'partial'); assert.equal(result.platform_id, 'text-ok')
})
test('upload limits, cache eviction and expiry remove bytes without deleting message records', async t => {
  const { panel, bot } = await setup(t), headers = await login(bot, panel)
  panel.config.uploadMaxMB = 1
  const response = await inject(bot.express, '/bot-web/api/uploads', { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-bot-id': '11', 'content-length': String(2 * 1048576) }, body: Buffer.from('small') })
  assert.equal(response.status, 413)
  panel.config.mediaCacheMB = .001
  const first = await panel.media.store(Readable.from(Buffer.alloc(700)), 'first.bin', '11')
  const second = await panel.media.store(Readable.from(Buffer.alloc(700)), 'second.bin', '11')
  await assert.rejects(fs.stat(first.path), { code: 'ENOENT' })
  assert.equal((await fs.stat(second.path)).size, 700)
  await panel.db.run('UPDATE media SET created=0'); await panel.media.cleanup(7)
  assert.equal((await panel.db.all('SELECT * FROM media')).length, 0)
})
test('plugin dispose and reattach retain one router and one observer', async t => {
  const { panel, bot, directory } = await setup(t)
  const listeners = bot.listenerCount('message'), layers = bot.express._router.stack.length
  await panel.close()
  const next = await createPanel(bot, { dataDir: directory, config: { ...config }, testing: true, log: { info() {}, error() {} } })
  try {
    assert.equal(bot.listenerCount('message'), listeners); assert.equal(bot.express._router.stack.length, layers)
    bot.emit('message', incoming('11')); await next.bridge.tasks
    assert.equal((await next.db.all('SELECT * FROM messages')).length, 1)
  } finally { await next.close() }
})

test('split receipts deduplicate early and late reports without losing the complete send', async t => {
  const { panel, bot } = await setup(t)
  bot.bots['11'].pickGroup = () => ({ async sendMsg(message) {
    for (const id of ['split-1', 'split-2']) bot.emit('message_sent', { ...incoming('11', 'group', id, id), post_type: 'message_sent', user_id: '11', sender: { user_id: '11' } })
    await panel.bridge.tasks
    return [{ message_id: 'split-1' }, { message_id: 'split-2' }]
  } })
  const result = await panel.bridge.send('11', { kind: 'group', target_id: '100', request_id: randomUUID(), message: [{ type: 'text', text: 'complete message' }] })
  assert.equal(result.replaced_ids.length, 2)
  for (const id of ['split-2', 'split-1']) bot.emit('message_sent', { ...incoming('11', 'group', id, 'one part'), post_type: 'message_sent', user_id: '11', sender: { user_id: '11' } })
  await panel.bridge.tasks
  const history = await panel.db.history(conversationKey('11', 'group', '100'))
  assert.equal(history.length, 1); assert.equal(history[0].id, result.id)
  assert.equal(history[0].message[0].text, 'complete message')
  assert.equal(history[0].preview, 'complete message')
  assert.deepEqual(history[0].platform_ids, ['split-1', 'split-2'])
  bot.emit('notice', { ...incoming('11', 'group', 'split-2'), notice_type: 'group_recall' }); await panel.bridge.tasks
  assert.equal((await panel.db.history(conversationKey('11', 'group', '100')))[0].recalled, true)
})

test('official auto replies retain prefixed IDs and returned promise identity', async t => {
  const { panel, bot } = await setup(t)
  const instance = bot.bots.official, receipt = Promise.resolve({ message_id: 'official-auto' })
  const original = function(...args) { assert.equal(this, instance.adapter); assert.equal(args.length, 3); return receipt }
  instance.adapter.sendGroupMsg = original; panel.bridge.scan()
  assert.equal(instance.adapter.sendGroupMsg({ self_id: 'official', group_id: 'unknown_openid' }, 'auto', { event_id: 'e' }), receipt)
  await receipt; await panel.bridge.tasks
  assert.equal((await panel.db.history(conversationKey('official', 'group', 'official:unknown_openid'))).length, 1)
  await panel.close(); assert.equal(instance.adapter.sendGroupMsg, original)
})

test('stdin and Satori retain their distinct send signatures', async t => {
  const { panel, bot } = await setup(t)
  const stdin = { id: 'stdin', name: '标准输入', sendMsg: async () => ({ message_id: 'stdin-auto' }) }
  bot.bots.stdin = { adapter: stdin, online: true, pickFriend: () => ({ sendMsg: msg => stdin.sendMsg(msg) }) }
  const satori = { id: 'Satori', async sendGroupMsg(data, msg) { assert.equal(data.group_id, 'satori-group'); return [{ id: 'satori-auto' }] } }
  const direct = msg => satori.sendGroupMsg(msg, msg.message)
  bot.bots.satori = { adapter: satori, online: true, sendGroupMsg: direct }
  panel.bridge.scan()
  assert.equal(bot.bots.satori.sendGroupMsg, direct)
  await stdin.sendMsg('standard input'); await direct({ self_id: 'satori', group_id: 'satori-group', message: 'Satori' }); await panel.bridge.tasks
  assert.equal((await panel.db.history(conversationKey('stdin', 'private', 'stdin'))).length, 1)
  assert.equal((await panel.db.history(conversationKey('satori', 'group', 'satori-group')))[0].platform_id, 'satori-auto')
})

test('unload aborts remote media waiting for headers without creating any listener', async t => {
  const { panel } = await setup(t)
  const started = Promise.withResolvers()
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }])
  t.mock.method(http, 'get', (url, options) => {
    const request = new EventEmitter()
    request.destroy = error => request.emit('error', error)
    options.signal.addEventListener('abort', () => request.destroy(new Error('request aborted')), { once: true })
    started.resolve()
    return request
  })
  const id = await panel.media.register('http://media.example.test/photo.png', '11', 'photo')
  const download = panel.media.get(id), rejected = assert.rejects(download, /aborted/)
  await started.promise; await panel.close(); await rejected
  assert.equal(panel.media.pending.size, 0)
})

test('concurrent reuse of one request ID across bots cannot overwrite another conversation', async t => {
  const { panel, bot } = await setup(t), request_id = randomUUID()
  const params = { kind: 'group', target_id: '100', request_id, message: [{ type: 'text', text: 'isolated' }] }
  const results = await Promise.allSettled([panel.bridge.send('11', params), panel.bridge.send('22', params)])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(bot.calls.length, 1)
  const row = (await panel.db.all('SELECT * FROM messages'))[0]
  assert.equal(JSON.parse(row.body).bot_id, row.bot_id)
  assert.equal(JSON.parse(row.body).conversation, row.conversation)
})

test('send timeout records unknown and a late receipt updates the same record', async t => {
  const { panel, bot } = await setup(t), started = Promise.withResolvers(), receipt = Promise.withResolvers()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  bot.bots['11'].pickGroup = () => ({ sendMsg() { started.resolve(); return receipt.promise } })
  const sending = panel.bridge.send('11', { kind: 'group', target_id: '100', request_id: randomUUID(), message: [{ type: 'text', text: 'delayed' }] })
  await started.promise; t.mock.timers.tick(30000)
  const result = await sending
  assert.equal(result.status, 'unknown')
  receipt.resolve({ message_id: 'late-receipt' })
  await new Promise(setImmediate); await panel.bridge.tasks
  const messages = await panel.db.history(conversationKey('11', 'group', '100'))
  assert.equal(messages.length, 1); assert.equal(messages[0].id, result.id); assert.equal(messages[0].status, 'sent')
})

test('adapter avatar methods resolve distinct bot, friend, group and member media including old history', async t => {
  const { panel, bot } = await setup(t)
  for (const id of ['11', '22', 'official']) {
    const instance = bot.bots[id], friend = instance.pickFriend, group = instance.pickGroup
    instance.pickFriend = target => ({ ...friend(target), getAvatarUrl: () => `https://avatars.example/${id}/private/${target}.png` })
    instance.pickGroup = target => ({ ...group(target), getAvatarUrl: async () => `https://avatars.example/${id}/group/${target}.png` })
    instance.pickMember = (group, target) => ({ getAvatarUrl: () => `https://avatars.example/${id}/member/${group}/${target}.png` })
    for (const kind of ['private', 'group']) {
      const data = incoming(id, kind, `avatar-${kind}`)
      bot.emit('message', data)
    }
  }
  await panel.bridge.tasks
  const avatars = []
  for (const id of ['11', '22', 'official']) {
    const contacts = await panel.bridge.contacts(id)
    for (const contact of contacts.filter(contact => contact.last)) {
      assert.match(contact.avatar, /^\/bot-web\/api\/media\//)
      const row = await panel.db.get('SELECT * FROM media WHERE id=?', [contact.avatar.split('/').at(-1)])
      assert.equal(row.bot_id, id); assert.ok(row.source.includes(`/${contact.kind}/`)); avatars.push(contact.avatar)
    }
  }
  assert.equal(new Set(avatars).size, avatars.length)
  const key = conversationKey('11', 'group', '100'), stored = (await panel.db.history(key))[0]
  assert.ok((await panel.db.get('SELECT source FROM media WHERE id=?', [stored.sender.avatar.split('/').at(-1)])).source.includes('/member/100/100.png'))
  delete stored.sender.avatar
  await panel.db.run('UPDATE messages SET body=? WHERE id=?', [JSON.stringify(stored), stored.id])
  assert.match((await panel.bridge.action('11', 'get_history', { kind: 'group', target_id: '100' }))[0].sender.avatar, /^\/bot-web\/api\/media\//)
  const oldContact = (await panel.bridge.contacts('11')).find(contact => contact.kind === 'group')
  bot.bots['11'].gl.clear()
  await panel.db.run('DELETE FROM media WHERE id=?', [oldContact.avatar.split('/').at(-1)])
  panel.bridge.avatars.cache.clear()
  const refreshed = (await panel.bridge.contacts('11')).find(contact => contact.kind === 'group')
  assert.match(refreshed.avatar, /^\/bot-web\/api\/media\//)
  assert.notEqual(refreshed.avatar, oldContact.avatar)
  assert.ok(await panel.db.get('SELECT id FROM media WHERE id=?', [refreshed.avatar.split('/').at(-1)]))
})

test('avatar failure does not stop recording and concurrent lookups share one adapter call', async t => {
  const { panel, bot } = await setup(t)
  const source = bot.bots['11'].pickFriend, lookups = []
  bot.bots['11'].pickFriend = target => ({ ...source(target), getAvatarUrl() { lookups.push(target); return Promise.reject(new Error('unavailable')) } })
  assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => panel.bridge.avatars.resolve('11', 'private', '100'))), Array(8).fill(''))
  assert.equal(lookups.length, 1)
  bot.emit('message', incoming('11', 'private', 'avatar-failed', 'text survives')); await panel.bridge.tasks
  const history = await panel.db.history(conversationKey('11', 'private', '100'))
  assert.equal(history[0].message[0].text, 'text survives'); assert.equal(history[0].sender.avatar, '')
  const foreign = await panel.media.register('https://avatars.example/foreign.png', '22', 'avatar')
  assert.equal(await panel.bridge.avatars.resolve('11', 'private', '100', `/bot-web/api/media/${foreign}`), '')
})

test('conversation pin and manual read state persist with bot and conversation isolation', async t => {
  const { panel, bot, directory } = await setup(t)
  for (const id of ['11', '22']) for (const kind of ['group', 'private']) bot.emit('message', incoming(id, kind))
  await panel.bridge.tasks
  await panel.bridge.action('11', 'set_conversation_preferences', { kind: 'group', target_id: '100', pinned: true, unread: false })
  let contacts = await panel.bridge.contacts('11')
  assert.equal(contacts.find(row => row.kind === 'group').pinned, true)
  assert.equal(contacts.find(row => row.kind === 'group').unread, 0)
  assert.equal(contacts.find(row => row.kind === 'private').pinned, false)
  assert.equal((await panel.bridge.contacts('22')).find(row => row.kind === 'group').pinned, false)
  await panel.bridge.action('11', 'set_conversation_preferences', { kind: 'group', target_id: '100', unread: true })
  const second = await new Database().open(path.join(directory, 'panel.sqlite'))
  try { const row = (await second.conversations('11')).find(row => row.kind === 'group'); assert.equal(row.pinned, true); assert.equal(row.unread, 1) } finally { await second.close() }
  await panel.bridge.action('11', 'mark_read', { kind: 'group', target_id: '100', seq: 9999 })
  contacts = await panel.bridge.contacts('11'); assert.equal(contacts.find(row => row.kind === 'group').unread, 0)
  await panel.bridge.action('11', 'set_conversation_preferences', { kind: 'group', target_id: '100', pinned: false })
  assert.equal((await panel.bridge.contacts('11')).find(row => row.kind === 'group').pinned, false)
  await assert.rejects(panel.bridge.action('11', 'set_conversation_preferences', { kind: 'group', target_id: '100', pinned: 'false' }), /无效会话设置/)
  assert.equal(bot.calls.length, 0)
})
