import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPanel } from '../lib/server.js'
import { conversationKey } from '../lib/database.js'
import { forwardNodes, received, segments } from '../lib/messages.js'
import { framework, incoming, config } from './helpers.mjs'

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-web-forwards-'))
  const bot = framework(), errors = []
  const panel = await createPanel(bot, { config: { ...config }, dataDir: directory, testing: true, log: { info() {}, error(message) { errors.push(message) } } })
  t.after(async () => { await panel.close(); await fs.rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, []) })
  return { panel, bot }
}
const forward = (botId = '11', kind = 'group', id = 'resource') => received({ ...incoming(botId, kind), message: [{ type: 'forward', data: { id } }] })
const load = (panel, message, path = [0], botId = message.bot_id) => panel.bridge.action(botId, 'get_forward_msg', { id: message.id, path })

test('OneBot nodes and ICQQ multimsg, JSON and legacy XML preserve retrieval metadata', () => {
  const id = '7682845948127089821'
  assert.deepEqual(segments({ type: 'forward', data: { id } })[0], { type: 'forward', id, content: [] })
  assert.deepEqual(segments({ type: 'multimsg', resid: 'resid/abc', filename: 'MultiMsg' })[0], { type: 'forward', id: 'resid/abc', filename: 'MultiMsg', content: [] })
  const card = { app: 'com.tencent.multimsg', meta: { detail: { resid: 'json-resid', uniseq: 'nested-file' } } }
  for (const data of [card, JSON.stringify(card), { data: JSON.stringify(card) }]) assert.equal(segments({ type: 'json', data })[0].id, 'json-resid')
  assert.equal(segments({ type: 'json', data: '{broken' })[0].type, 'json')
  assert.equal(segments({ type: 'json', data: JSON.stringify({ app: 'unrelated' }) })[0].type, 'json')
  assert.equal(segments({ type: 'xml', data: '<msg m_resid="xml-resid" m_fileName="MultiMsg"><item /></msg>' })[0].id, 'xml-resid')
  const node = { type: 'node', data: { name: 'OneBot author', content: [{ type: 'text', data: { text: 'Node text' } }] } }
  assert.deepEqual(segments(node)[0].content, [{ nickname: 'OneBot author', message: [{ type: 'text', text: 'Node text' }] }])
  assert.deepEqual(forwardNodes({ data: { messages: [node] } }), segments(node)[0].content)
  const nodes = [{ nickname: 'ICQQ author', message: [{ type: 'text', text: 'ICQQ text' }] }]
  assert.deepEqual(forwardNodes(nodes), nodes)
  assert.equal(forwardNodes(Array(120).fill(nodes[0])).length, 100)
})

test('OneBot forwards load on demand, share concurrent requests and persist sanitized media', async t => {
  const { panel, bot } = await setup(t), calls = []
  const message = forward('11', 'group', '7682845948127089821')
  bot.bots['11'].sendApi = async (action, params) => {
    calls.push({ action, params })
    return { data: { messages: [{ sender: { nickname: 'Original author' }, content: [{ type: 'text', data: { text: 'Forward text' } }, { type: 'image', data: { url: 'https://images.example/photo.jpg' } }] }] } }
  }
  await panel.bridge.record(message)
  const before = (await panel.db.conversations('11'))[0]
  assert.equal(calls.length, 0)
  const [first, second] = await Promise.all([load(panel, message), load(panel, message)])
  assert.deepEqual(first, second)
  assert.deepEqual(calls, [{ action: 'get_forward_msg', params: { id: '7682845948127089821', message_id: '7682845948127089821' } }])
  const node = first.message[0].content[0]
  assert.equal(node.nickname, 'Original author'); assert.equal(node.message[0].text, 'Forward text')
  assert.match(node.message[1].url, /^\/bot-web\/api\/media\//)
  assert.equal(node.message[1].file, undefined)
  const media = await panel.db.get('SELECT bot_id FROM media WHERE id=?', [node.message[1].media_id]); assert.equal(media.bot_id, '11')
  await load(panel, message); assert.equal(calls.length, 1)
  const history = await panel.bridge.action('11', 'get_history', { kind: 'group', target_id: '100' })
  assert.equal(history.length, 1); assert.equal(history[0].message[0].content[0].message[0].text, 'Forward text')
  const after = (await panel.db.conversations('11'))[0]
  assert.equal(after.unread, before.unread); assert.equal(after.last_seq, before.last_seq)
  assert.equal(bot.calls.length, 0)
})

test('ICQQ uses raw contact receiver and passes resid plus filename in groups and private chats', async t => {
  const { panel, bot } = await setup(t), instance = bot.bots['11'], calls = []
  instance.adapter.name = 'ICQQ'
  for (const kind of ['group', 'private']) {
    const contact = { async getForwardMsg(resid, filename) { assert.equal(this, contact); calls.push([kind, resid, filename]); return [{ nickname: 'ICQQ sender', message: [{ type: 'text', text: kind }] }] } }
    instance[kind === 'group' ? 'pickGroup' : 'pickFriend'] = () => new Proxy({}, { get: (target, prop) => prop === 'raw' ? contact : contact[prop] })
    const message = received({ ...incoming('11', kind), message: [{ type: 'multimsg', resid: `${kind}-resid`, filename: 'nested-file' }] })
    await panel.db.save(message)
    const result = await load(panel, message)
    assert.equal(result.message[0].content[0].message[0].text, kind)
  }
  assert.deepEqual(calls, [['group', 'group-resid', 'nested-file'], ['private', 'private-resid', 'nested-file']])
})

test('adapter getForwardMsg fallback and nested forward paths use stored identifiers', async t => {
  const { panel, bot } = await setup(t), calls = []
  bot.bots['11'].pickGroup = () => ({ async getForwardMsg(id) {
    calls.push(id)
    return [{ nickname: 'Author', message: id === 'resource' ? [{ type: 'text', text: 'Outer' }, { type: 'forward', data: { id: 'nested' } }] : [{ type: 'text', text: 'Inner' }] }]
  } })
  const message = forward(); await panel.db.save(message)
  await load(panel, message)
  const result = await load(panel, message, [0, 0, 1])
  assert.equal(result.message[0].content[0].message[1].content[0].message[0].text, 'Inner')
  assert.deepEqual(calls, ['resource', 'nested'])
  await assert.rejects(load(panel, message, [0, 0, 0]), /不存在/)
  await assert.rejects(load(panel, message, [0], '22'), /不存在/)
  for (const path of [[], [0, 0], [-1], ['0'], Array(17).fill(0)]) await assert.rejects(load(panel, message, path), /无效/)
  assert.deepEqual(calls, ['resource', 'nested'])
})

test('forward failures can retry and late fetches do not overwrite recalls', async t => {
  const { panel, bot } = await setup(t)
  const message = forward(); await panel.db.save(message)
  let attempts = 0
  bot.bots['11'].pickGroup = () => ({ async getForwardMsg() { if (++attempts === 1) throw new Error('unavailable'); return [{ nickname: 'A', message: 'Recovered' }] } })
  await assert.rejects(load(panel, message), /无法读取/)
  assert.equal((await load(panel, message)).message[0].content[0].message[0].text, 'Recovered')
  const second = { ...forward(), id: 'another-message', platform_id: 'another-platform' }; await panel.db.save(second)
  const started = Promise.withResolvers(), response = Promise.withResolvers()
  bot.bots['11'].pickGroup = () => ({ getForwardMsg() { started.resolve(); return response.promise } })
  const loading = load(panel, second), rejected = assert.rejects(loading, /已撤回/)
  await started.promise
  await panel.db.save({ ...second, recalled: true })
  response.resolve([{ nickname: 'A', message: 'Late' }]); await rejected
  const saved = (await panel.db.history(conversationKey('11', 'group', '100'))).find(item => item.id === second.id)
  assert.equal(saved.recalled, true); assert.equal(saved.message[0].content.length, 0)
})

test('a slow forward request times out while ordinary messages continue recording', async t => {
  const { panel, bot } = await setup(t), started = Promise.withResolvers()
  const message = forward(); await panel.db.save(message)
  bot.bots['11'].pickGroup = () => ({ getForwardMsg() { started.resolve(); return new Promise(() => {}) } })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const loading = load(panel, message), rejected = assert.rejects(loading, /超时/)
  await started.promise
  bot.emit('message', incoming('11', 'group', 'following', 'Still recording')); await panel.bridge.tasks
  assert.equal((await panel.db.history(conversationKey('11', 'group', '100'))).length, 2)
  t.mock.timers.tick(10000); await rejected
  assert.equal(panel.bridge.forwards.pending.size, 0)
})
