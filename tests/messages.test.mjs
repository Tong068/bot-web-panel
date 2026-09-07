import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPanel } from '../lib/server.js'
import { conversationKey } from '../lib/database.js'
import { preview, received, segments } from '../lib/messages.js'
import { framework, incoming, config } from './helpers.mjs'

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-web-messages-'))
  const bot = framework(), errors = []
  const panel = await createPanel(bot, { config: { ...config }, dataDir: directory, testing: true, log: { info() {}, error(message) { errors.push(message) } } })
  t.after(async () => { await panel.close(); await fs.rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, []) })
  return { panel, bot }
}
const history = (panel, botId = '11', kind = 'group', target = '100') => panel.db.history(conversationKey(botId, kind, target))
const replyEvent = (botId = '11', kind = 'group', id = 'reply', quoted = 'original') => ({ ...incoming(botId, kind, id), message: [{ type: 'reply', data: { id: quoted } }, { type: 'text', data: { text: 'answer' } }] })

test('OneBot reply segments and ICQQ mention labels normalize without duplicate at signs', () => {
  const event = replyEvent()
  event.message.push({ type: 'at', data: { qq: 200, text: '@Alice' } }, { type: 'at', data: { qq: 'all' } })
  const data = received(event)
  assert.deepEqual(data.quote, { id: 'original', text: '', user_id: '' })
  assert.equal(preview(data.message), 'answer@Alice@全体成员')
  assert.equal(event.message[2].data.text, '@Alice')
  assert.equal(received({ ...event, source: { message_id: 0, user_id: 0, message: 'zero' } }).quote.id, '0')
  assert.equal(preview(segments({ type: 'markdown', content: 'markdown quote' })), 'markdown quote')
})

test('received mentions use group cards with numeric and string IDs and stay scoped by bot and group', async t => {
  const { panel, bot } = await setup(t)
  bot.bots['11'].gml = new Map([[100, new Map([[200, { card: 'Group card', nickname: 'Nickname' }]])], ['101', new Map([['200', { nickname: 'Other group' }]])]])
  bot.bots['22'].gml = new Map([['100', new Map([['200', { card: 'Other bot' }]])]])
  for (const [botId, groupId, label] of [['11', '100', 'Group card'], ['11', '101', 'Other group'], ['22', '100', 'Other bot']]) {
    const event = { ...incoming(botId), group_id: groupId, message: [{ type: 'at', data: { qq: 200 } }, { type: 'text', text: 'hello' }] }
    bot.emit('message', event)
    await panel.bridge.tasks
    const stored = (await history(panel, botId, 'group', groupId))[0]
    assert.equal(stored.message[0].qq, '200')
    assert.equal(stored.message[0].text, label)
    assert.equal(stored.preview, `@${label}hello`)
    assert.equal(event.message[0].data.text, undefined)
  }
  const events = await panel.db.all("SELECT body FROM events WHERE json_extract(body, '$.type')='message'")
  assert.equal(JSON.parse(events[0].body).message.message[0].text, 'Group card')
})

test('member lookups support wrapped OneBot info, ICQQ renew, cached pick info and roster fallback', async t => {
  const { panel, bot } = await setup(t)
  let infoCalls = 0, rosterCalls = 0
  bot.bots['11'].pickGroup = () => ({
    pickMember(userId) {
      if (userId === '201') return { async getInfo() { infoCalls++; return { data: { card: 'API card', nickname: 'API nickname' } } } }
      if (userId === '202') return { async renew() { return { nickname: 'ICQQ member' } } }
      if (userId === '203') return { info: { card: 'Cached pick' } }
      return {}
    },
    async getMemberMap() { rosterCalls++; return new Map([[204, { nickname: 'Roster one' }], [205, { nickname: 'Roster two' }]]) }
  })
  const event = { ...incoming('11'), message: ['201', '201', '202', '203', '204', '205'].map(qq => ({ type: 'at', qq })) }
  bot.emit('message', event); await panel.bridge.tasks
  assert.deepEqual((await history(panel))[0].message.map(part => part.text), ['API card', 'API card', 'ICQQ member', 'Cached pick', 'Roster one', 'Roster two'])
  assert.equal(infoCalls, 1); assert.equal(rosterCalls, 1)
  assert.equal(bot.calls.length, 0)
})

test('explicit mention labels, all-members and unknown IDs retain usable fallbacks', async t => {
  const { panel, bot } = await setup(t)
  bot.bots['11'].pickGroup = () => ({ pickMember() { throw new Error('unsupported') } })
  bot.emit('message', { ...incoming('11'), message: [{ type: 'at', qq: '999' }, { type: 'at', qq: '200', text: '@Provided' }, { type: 'at', qq: 'all' }, { type: 'at', qq: '11' }] })
  await panel.bridge.tasks
  const stored = (await history(panel))[0]
  assert.equal(stored.message[0].qq, '999')
  assert.equal(stored.preview, '@999@Provided@全体成员@测试机器人 11')
})

test('incoming replies resolve local receipt aliases only within their bot and conversation', async t => {
  const { panel, bot } = await setup(t)
  for (const [botId, kind, text] of [['11', 'group', 'Group original'], ['11', 'private', 'Private original'], ['22', 'group', 'Other bot original']]) {
    const original = received(incoming(botId, kind, 'original', text))
    original.platform_ids = ['original', 'alias']
    await panel.bridge.record(original)
    bot.emit('message', replyEvent(botId, kind, 'reply', 'alias'))
    await panel.bridge.tasks
    const stored = (await history(panel, botId, kind))[1]
    assert.deepEqual(stored.quote, { id: 'alias', text, user_id: '100' })
    assert.equal(stored.preview, 'answer')
  }
})

test('missing local replies load adapter messages with normalized media and mentions', async t => {
  const { panel, bot } = await setup(t), calls = []
  bot.bots['11'].gml = new Map([[100, new Map([[200, { card: 'Alice' }]])]])
  bot.bots['11'].pickGroup = target => ({ async getMsg(id) {
    calls.push([target, id])
    return { data: { group_id: 100, sender: { user_id: 300 }, message: [{ type: 'at', data: { qq: '200' } }, { type: 'text', data: { text: 'photo' } }, { type: 'image', data: { file: 'unknown' } }] } }
  } })
  bot.emit('message', replyEvent()); await panel.bridge.tasks
  assert.deepEqual((await history(panel))[0].quote, { id: 'original', text: '@Alicephoto[图片]', user_id: '300' })
  assert.deepEqual(calls, [['100', 'original']])
})

test('ICQQ source content and getReply both supply received quote previews', async t => {
  const { panel, bot } = await setup(t)
  bot.emit('message', { ...incoming('11', 'group', 'inline'), source: { user_id: 200, seq: 123, message: [{ type: 'text', text: 'Inline ' }, { type: 'image', file: 'unknown' }] }, getReply() { assert.fail('Inline content needs no lookup') } })
  bot.emit('message', { ...incoming('11', 'group', 'lookup'), source: { user_id: 200, seq: 124 }, async getReply() { assert.equal(this.source.seq, 124); return { message_id: 'icqq-id', user_id: 200, message: 'Recovered ICQQ quote' } } })
  await panel.bridge.tasks
  const messages = await history(panel)
  assert.equal(messages[0].quote.text, 'Inline [图片]')
  assert.deepEqual(messages[1].quote, { id: 'icqq-id', user_id: '200', text: 'Recovered ICQQ quote' })
})

test('old history restores mentions and replies without adding messages or unread events', async t => {
  const { panel, bot } = await setup(t)
  const original = received(incoming('11', 'group', 'original', 'Old original'))
  const old = received(replyEvent())
  old.quote = null
  old.message.push({ type: 'at', qq: '200', text: '@200' })
  await panel.db.save(original); await panel.db.save(old)
  const before = await panel.db.conversations('11')
  const messages = await panel.bridge.action('11', 'get_history', { kind: 'group', target_id: '100' })
  assert.equal(messages[1].quote.text, 'Old original')
  assert.equal(messages[1].message[2].text, '测试成员')
  assert.equal(messages[1].preview, 'answer@测试成员')
  assert.equal((await panel.db.conversations('11'))[0].unread, before[0].unread)
  assert.equal((await history(panel)).length, 2)
  assert.equal(bot.calls.length, 0)
})

test('outgoing plugin reply segments are enriched without changing sent payloads', async t => {
  const { panel, bot } = await setup(t)
  bot.emit('message', incoming('11', 'group', 'original', 'Question')); await panel.bridge.tasks
  const message = [{ type: 'reply', id: 'original' }, { type: 'at', qq: '200' }, { type: 'text', text: 'Answer' }]
  await bot.bots['11'].pickGroup('100').sendMsg(message); await panel.bridge.tasks
  const stored = (await history(panel))[1]
  assert.equal(stored.quote.text, 'Question')
  assert.equal(stored.message[1].text, '测试成员')
  assert.equal(stored.direction, 'out')
  assert.equal(bot.calls[0].message, message)
  assert.equal(message[1].text, undefined)
})

test('failed and stalled lookups preserve messages and allow the recording queue to continue', async t => {
  const { panel, bot } = await setup(t)
  bot.bots['11'].pickGroup = () => ({ async getMsg() { throw new Error('deleted') } })
  bot.emit('message', replyEvent('11', 'group', 'failed', 'missing')); await panel.bridge.tasks
  assert.equal((await history(panel))[0].quote.text, '')
  const memberStarted = Promise.withResolvers(), quoteStarted = Promise.withResolvers()
  bot.bots['11'].pickGroup = () => ({
    pickMember: () => ({ getInfo() { memberStarted.resolve(); return new Promise(() => {}) } }),
    getMsg() { quoteStarted.resolve(); return new Promise(() => {}) }
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const event = replyEvent('11', 'group', 'stalled', 'stalled-original')
  event.message.push({ type: 'at', qq: '999' })
  bot.emit('message', event)
  bot.emit('message', incoming('11', 'group', 'after', 'After stalled lookup'))
  await Promise.all([memberStarted.promise, quoteStarted.promise]); t.mock.timers.tick(1500)
  await panel.bridge.tasks
  const messages = await history(panel)
  assert.equal(messages[1].preview, 'answer@999')
  assert.equal(messages[1].quote.text, '')
  assert.equal(messages[2].preview, 'After stalled lookup')
})

test('adapter replies belonging to a different group or bot are not displayed', async t => {
  const { panel, bot } = await setup(t)
  bot.bots['11'].pickGroup = () => ({ async getMsg(id) { return { self_id: id === 'wrong-bot' ? '22' : '11', group_id: id === 'wrong-group' ? '101' : '100', message: 'Wrong context' } } })
  for (const id of ['wrong-group', 'wrong-bot']) bot.emit('message', replyEvent('11', 'group', id, id))
  await panel.bridge.tasks
  for (const message of await history(panel)) assert.equal(message.quote.text, '')
})

test('private adapter replies resolve both incoming and outgoing originals without crossing peers', async t => {
  const { panel, bot } = await setup(t)
  bot.bots['11'].pickFriend = () => ({ async getMsg(id) {
    return { sender: { user_id: id === 'outgoing' ? '11' : id === 'foreign' ? '999' : '100' }, target_id: id === 'outgoing' ? '100' : '11', message: `${id} original` }
  } })
  for (const id of ['incoming', 'outgoing', 'foreign']) bot.emit('message', replyEvent('11', 'private', id, id))
  await panel.bridge.tasks
  const messages = await history(panel, '11', 'private')
  assert.equal(messages[0].quote.text, 'incoming original')
  assert.equal(messages[1].quote.text, 'outgoing original')
  assert.equal(messages[2].quote.text, '')
})
