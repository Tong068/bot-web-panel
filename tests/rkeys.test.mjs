import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import dns from 'node:dns/promises'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { createPanel } from '../lib/server.js'
import { ntImageSource } from '../lib/rkeys.js'
import { received } from '../lib/messages.js'
import { framework, incoming, config } from './helpers.mjs'

const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMuoAAAAASUVORK5CYII=', 'base64')
const url = (file = 'image-id', appid = '1407', key = 'expired-key') => `https://multimedia.nt.qq.com.cn/download?appid=${appid}&fileid=${file}&spec=0&rkey=${key}`
const future = () => Math.floor(Date.now() / 1000) + 3600
const keys = (suffix = '') => [{ type: 'private', rkey: `private${suffix}`, created_at: future() - 3600, ttl: 3600 }, { type: 'group', rkey: `group${suffix}`, created_at: future() - 3600, ttl: 3600 }]

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-web-rkeys-'))
  const bot = framework(), errors = []
  const panel = await createPanel(bot, { config: { ...config }, dataDir: directory, testing: true, log: { info() {}, error(message) { errors.push(message) } } })
  t.after(async () => { await panel.close(); await fs.rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, []); assert.equal(bot.calls.length, 0) })
  return { panel, bot }
}
function downloads(t, respond = () => 200) {
  const urls = []
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }])
  t.mock.method(https, 'get', (url, options, callback) => {
    urls.push(new URL(url))
    const request = new EventEmitter(), response = Readable.from(photo)
    request.destroy = error => request.emit('error', error)
    response.statusCode = respond(urls.at(-1), urls.length)
    response.headers = { 'content-length': String(photo.length) }
    queueMicrotask(() => callback(response))
    return request
  })
  return urls
}

test('QQ image sources discard only rkey and deduplicate rotating keys within each bot', async t => {
  const { panel } = await setup(t)
  const first = await panel.media.register(url(), '11', 'image')
  assert.equal(await panel.media.register(url('image-id', '1407', 'another-key,file_size=155149'), '11', 'image'), first)
  assert.notEqual(await panel.media.register(url(), '22', 'image'), first)
  const saved = new URL((await panel.db.get('SELECT source FROM media WHERE id=?', [first])).source)
  assert.equal(saved.searchParams.has('rkey'), false)
  assert.deepEqual(Object.fromEntries(saved.searchParams), { appid: '1407', fileid: 'image-id', spec: '0' })
  for (const input of ['https://images.example/photo?rkey=keep', url().replace('.cn/', '.cn.example/'), url().replace('/download?', '/other?'), url('image', '999'), url().replace('fileid=', 'other='), 'not a URL']) assert.equal(ntImageSource(input), null)
  const ordinary = 'https://images.example/photo?rkey=keep'
  const other = await panel.media.register(ordinary, '11', 'photo')
  assert.equal((await panel.db.get('SELECT source FROM media WHERE id=?', [other])).source, ordinary)
})

test('old media URLs migrate without changing message references and fetch with current keys', async t => {
  const { panel, bot } = await setup(t), urls = downloads(t), id = randomUUID()
  await panel.media.record({ id, source: url(), bot_id: '11', name: 'old.png' })
  const message = received(incoming('11'))
  message.message = [{ type: 'image', media_id: id, url: `/bot-web/api/media/${id}` }]
  await panel.db.save(message)
  const before = await panel.db.get('SELECT body FROM messages WHERE id=?', [message.id])
  await panel.media.init()
  assert.equal(new URL((await panel.db.get('SELECT source FROM media WHERE id=?', [id])).source).searchParams.has('rkey'), false)
  assert.deepEqual(await panel.db.get('SELECT body FROM messages WHERE id=?', [message.id]), before)
  bot.bots['11'].sendApi = async () => ({ data: keys('-new') })
  assert.equal((await panel.media.get(id)).mime, 'image/png')
  assert.equal(urls[0].searchParams.get('rkey'), 'group-new')
  assert.equal(urls[0].searchParams.get('fileid'), 'image-id')
})

test('OneBot refreshes each remote download, chooses the image appid and reuses local bytes offline', async t => {
  const { panel, bot } = await setup(t), urls = downloads(t), actions = []
  let version = 1
  bot.bots['11'].sendApi = async (action, params) => { actions.push({ action, params }); return { data: keys(`-${version}`) } }
  const group = await panel.media.register(url('group'), '11', 'group.png')
  const privateImage = await panel.media.register(url('private', '1406'), '11', 'private.png')
  const first = await panel.media.get(group)
  version++
  await panel.media.get(privateImage)
  assert.equal(urls[0].searchParams.get('rkey'), 'group-1')
  assert.equal(urls[1].searchParams.get('rkey'), 'private-2')
  bot.bots['11'].online = false
  assert.equal((await panel.media.get(group)).path, first.path)
  assert.equal(actions.length, 2)
  await fs.rm(first.path)
  await assert.rejects(panel.media.get(group), /离线/)
  bot.bots['11'].online = true
  await panel.media.get(group)
  assert.equal(urls.at(-1).searchParams.get('rkey'), 'group-2')
  assert.deepEqual(actions, Array(3).fill({ action: 'get_rkey', params: {} }))
  assert.equal((await panel.db.get('SELECT source FROM media WHERE id=?', [group])).source.includes('rkey'), false)
})

test('OneBot supports native numeric and server key formats and remembers a working API', async t => {
  const { panel, bot } = await setup(t)
  for (const [method, data] of [
    ['get_rkey', keys()],
    ['get_rkey', { private_key: '&rkey=private', group_key: '&rkey=group', expired_time: future(), updated_time: '2026-09-08 02:04:30' }],
    ['nc_get_rkey', [{ type: 10, rkey: '&rkey=private', time: future() - 3600, ttl: 3600 }, { type: 20, rkey: '&rkey=group', time: future() - 3600, ttl: 3600 }]],
    ['get_rkey_server', { private_rkey: '&rkey=private', group_rkey: '&rkey=group', expired_time: future() }]
  ]) {
    panel.bridge.rkeys.methods.delete(bot.bots['11'])
    const actions = []
    bot.bots['11'].sendApi = async action => { actions.push(action); if (action !== method) return { status: 'failed', retcode: 1404 }; return { status: 'ok', retcode: 0, data } }
    assert.equal(new URL(await panel.bridge.rkeys.resolve(url(), '11')).searchParams.get('rkey'), 'group')
    const count = actions.length
    assert.equal(new URL(await panel.bridge.rkeys.resolve(url('private', '1406'), '11')).searchParams.get('rkey'), 'private')
    assert.equal(actions.length, count + 1)
    assert.equal(actions.at(-1), method)
  }
})

test('concurrent image downloads share a key lookup but never share keys across bots', async t => {
  const { panel, bot } = await setup(t), gate = Promise.withResolvers(), started = Promise.withResolvers(), urls = downloads(t), calls = []
  bot.bots['11'].sendApi = async () => { calls.push('11'); started.resolve(); await gate.promise; return { data: keys('-11') } }
  bot.bots['22'].sendApi = async () => { calls.push('22'); return { data: keys('-22') } }
  const ids = await Promise.all([panel.media.register(url('a'), '11'), panel.media.register(url('b', '1406'), '11'), panel.media.register(url('a'), '22')])
  const first = panel.media.get(ids[0]); await started.promise
  const second = panel.media.get(ids[1]), duplicate = panel.media.get(ids[0])
  await panel.media.get(ids[2]); gate.resolve()
  const [one, two, three] = await Promise.all([first, second, duplicate])
  assert.equal(one.path, three.path); assert.notEqual(one.path, two.path)
  assert.deepEqual(calls.sort(), ['11', '22'])
  assert.deepEqual(urls.map(url => url.searchParams.get('rkey')).sort(), ['group-11', 'group-22', 'private-11'])
})

test('ICQQ uses the SDK receiver and forces one refresh after a rejected image download', async t => {
  const { panel, bot } = await setup(t), calls = [], urls = downloads(t, (url, count) => count === 1 ? 403 : 200)
  const sdk = { async refreshNTPicRkey(force) {
    assert.equal(this, sdk); calls.push(force)
    return { 10: { rkey: '&rkey=private-sdk', expire_time: future() }, 20: { rkey: force ? '&rkey=refreshed-sdk' : '&rkey=initial-sdk', expire_time: future() } }
  } }
  bot.bots['11'].adapter.name = 'ICQQ'; bot.bots['11'].sdk = sdk
  bot.bots['11'].refreshNTPicRkey = () => { throw new Error('Do not invoke the unbound adapter method') }
  const id = await panel.media.register(url(), '11', 'image.png')
  await panel.media.get(id)
  assert.deepEqual(calls, [false, true])
  assert.deepEqual(urls.map(url => url.searchParams.get('rkey')), ['initial-sdk', 'refreshed-sdk'])
  assert.equal(new URL(await panel.bridge.rkeys.resolve(url('private', '1406'), '11')).searchParams.get('rkey'), 'private-sdk')
})

test('ICQQ contact API fallback accepts prefixed keys and expired keys are rejected', async t => {
  const { panel, bot } = await setup(t), contact = { async getNTPicRkey() { assert.equal(this, contact); return { offNTPicRkey: '&rkey=private', groupNTPicRkey: '&rkey=group' } } }
  bot.bots['11'].adapter.name = 'ICQQ'
  bot.bots['11'].sdk = { pickFriend: () => ({ raw: contact }) }
  assert.equal(new URL(await panel.bridge.rkeys.resolve(url(), '11')).searchParams.get('rkey'), 'group')
  bot.bots['11'].sdk = { refreshNTPicRkey: async () => ({ 20: { rkey: 'expired', expire_time: 1 } }) }
  await assert.rejects(panel.bridge.rkeys.resolve(url(), '11'), /无法获取有效/)
})

test('OneBot retry is bounded and a later access can recover; ordinary URLs bypass key lookup', async t => {
  const { panel, bot } = await setup(t)
  let available = false, lookups = 0
  const urls = downloads(t, () => available ? 200 : 404)
  bot.bots['11'].sendApi = async () => ({ data: keys(`-${++lookups}`) })
  const id = await panel.media.register(url(), '11', 'image.png')
  await assert.rejects(panel.media.get(id), /404/)
  assert.equal(lookups, 2); assert.equal(urls.length, 2)
  assert.equal(panel.media.pending.size, 0)
  available = true
  await panel.media.get(id)
  assert.equal(urls.at(-1).searchParams.get('rkey'), 'group-3')
  const ordinary = await panel.media.register('https://images.example/photo?rkey=ordinary', '11', 'photo.png')
  await panel.media.get(ordinary)
  assert.equal(lookups, 3)
  assert.equal(urls.at(-1).searchParams.get('rkey'), 'ordinary')
})

test('missing and stale OneBot keys are not used to download images', async t => {
  const { panel, bot } = await setup(t), urls = downloads(t)
  const id = await panel.media.register(url(), '11', 'image.png')
  bot.bots['11'].sendApi = async () => ({ data: [{ type: 'group', rkey: 'expired', created_at: 1, ttl: 1 }] })
  await assert.rejects(panel.media.get(id), /无法获取有效/)
  assert.equal(urls.length, 0)
  assert.equal(panel.bridge.rkeys.pending.size, 0)
})

test('rkey timeouts leave message recording available and unload aborts pending lookups', async t => {
  const { panel, bot } = await setup(t), started = Promise.withResolvers()
  const id = await panel.media.register(url(), '11', 'image.png')
  bot.bots['11'].sendApi = () => { started.resolve(); return new Promise(() => {}) }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const waiting = panel.media.get(id), rejected = assert.rejects(waiting, /超时/)
  await started.promise
  bot.emit('message', incoming('11', 'group', 'during-rkey', 'recorded')); await panel.bridge.tasks
  assert.equal((await panel.db.all('SELECT id FROM messages')).length, 1)
  t.mock.timers.tick(5000); await rejected
  assert.equal(panel.media.pending.size, 0)
  const pending = Promise.withResolvers()
  bot.bots['11'].sendApi = () => { pending.resolve(); return new Promise(() => {}) }
  const aborted = assert.rejects(panel.media.get(id), /aborted/)
  await pending.promise; await panel.close(); await aborted
  assert.equal(panel.bridge.rkeys.pending.size, 0)
})
