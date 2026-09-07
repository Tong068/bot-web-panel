import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import sqlite3 from 'sqlite3'
import { createPanel } from '../lib/server.js'
import { Database } from '../lib/database.js'
import { received } from '../lib/messages.js'
import { framework, incoming, config } from './helpers.mjs'

const videoUrl = key => `https://multimedia.nt.qq.com.cn/download?appid=1415&format=1&orgfmt=1&spec=0&rkey=${key}`
const voiceUrl = key => `https://multimedia.nt.qq.com.cn/download?appid=1403&fileid=voice-id&format=1&rkey=${key}`
async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-web-media-links-')), bot = framework(), errors = [], urls = []
  const panel = await createPanel(bot, { config: { ...config }, dataDir: directory, testing: true, log: { info() {}, error(message) { errors.push(message) } } })
  t.mock.method(panel.media, 'fetch', async source => { urls.push(new URL(source)); return Readable.from(Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex')) })
  t.after(async () => { await panel.close(); await fs.rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, []); assert.equal(bot.calls.length, 0) })
  return { panel, bot, urls }
}
async function record(panel, type = 'video', botId = '11', extra = {}) {
  const msg = received({ ...incoming(botId, 'group', randomUUID()), message: [{ type, data: { file: `${type}.file`, url: type === 'video' ? videoUrl('old') : voiceUrl('old'), ...extra } }] })
  return panel.bridge.record(msg)
}
async function oldMedia(panel, nested = false) {
  const id = randomUUID(), message = received(incoming('11', 'group', randomUUID()))
  await panel.media.record({ id, source: videoUrl('expired'), bot_id: '11', name: 'video' })
  const part = { type: 'video', name: 'video', media_id: id, url: `/bot-web/api/media/${id}` }
  message.message = nested ? [{ type: 'forward', id: 'forward-outer', content: [{ nickname: 'Author', message: [{ type: 'forward', id: 'forward-inner', content: [{ nickname: 'Author', message: [part] }] }] }] }] : [part]
  await panel.db.save(message)
  return { id, message }
}

test('OneBot video and voice locators survive recording, rotating links and cached file removal', async t => {
  const { panel, bot, urls } = await setup(t), calls = []
  let version = 0
  bot.bots['11'].sendApi = async (action, params) => {
    calls.push({ action, params }); assert.equal(action, 'get_file'); assert.equal(params.download, false)
    return { data: { url: params.file === 'video.file' ? videoUrl(`video-${++version}`) : voiceUrl(`voice-${++version}`) } }
  }
  const video = await record(panel), voice = await record(panel, 'record')
  assert.equal(calls.length, 0)
  const videoId = video.message[0].media_id, voiceId = voice.message[0].media_id
  for (const id of [videoId, voiceId]) {
    const row = await panel.db.get('SELECT * FROM media WHERE id=?', [id])
    assert.equal(new URL(row.source).searchParams.has('rkey'), false)
    assert.equal(JSON.parse(row.locator).target_id, '100')
  }
  assert.equal(video.message[0].file, undefined)
  const file = await panel.media.get(videoId)
  await panel.media.get(voiceId)
  await panel.media.get(videoId); assert.equal(calls.length, 2)
  await fs.rm(file.path); await panel.media.get(videoId)
  assert.deepEqual(urls.map(url => url.searchParams.get('rkey')), ['video-1', 'voice-2', 'video-3'])
  const second = await record(panel, 'video', '11', { file: 'other-video.file' })
  assert.notEqual(second.message[0].media_id, videoId, 'Videos without fileid in their URL must not merge')
})

test('ICQQ video and voice refresh use raw contacts and retain SDK metadata', async t => {
  const { panel, bot, urls } = await setup(t), calls = []
  bot.bots['11'].adapter.name = 'ICQQ'
  const contact = {
    async getVideoUrl(elem) { assert.equal(this, contact); calls.push(elem); return videoUrl('icqq-video') },
    async getPttUrl(elem) { assert.equal(this, contact); calls.push(elem); return voiceUrl('icqq-voice') }
  }
  bot.bots['11'].pickGroup = () => ({ raw: contact })
  const extra = { nt: true, file: 'protobuf://serialized-sdk-file', fid: 'file-uuid', md5: 'a'.repeat(32), sha1: 'b'.repeat(40), size: 12345, seconds: 7 }
  for (const type of ['video', 'record']) {
    const message = await record(panel, type, '11', extra)
    await panel.media.get(message.message[0].media_id)
    assert.deepEqual(calls.at(-1), { type, name: type, ...extra })
  }
  assert.deepEqual(urls.map(url => url.searchParams.get('rkey')), ['icqq-video', 'icqq-voice'])
})

test('historical video restores its file locator from get_msg without changing the message', async t => {
  const { panel, bot, urls } = await setup(t), { id, message } = await oldMedia(panel), actions = []
  const before = await panel.db.get('SELECT body FROM messages WHERE id=?', [message.id])
  bot.bots['11'].sendApi = async (action, params) => {
    actions.push(action)
    if (action === 'get_msg') { assert.equal(params.message_id, message.platform_id); return { data: { message_id: message.platform_id, group_id: '100', message: [{ type: 'video', data: { file: 'recovered.mp4', url: videoUrl('from-message') } }] } } }
    assert.deepEqual(params, { file: 'recovered.mp4', download: false })
    return { data: { url: videoUrl('from-file') } }
  }
  const cached = await panel.media.get(id)
  assert.deepEqual(actions, ['get_msg'])
  const row = await panel.db.get('SELECT source,locator FROM media WHERE id=?', [id])
  assert.equal(JSON.parse(row.locator).segment.file, 'recovered.mp4')
  assert.equal(new URL(row.source).searchParams.has('rkey'), false)
  await fs.rm(cached.path); await panel.media.get(id)
  assert.deepEqual(actions, ['get_msg', 'get_file'])
  assert.deepEqual(urls.map(url => url.searchParams.get('rkey')), ['from-message', 'from-file'])
  assert.deepEqual(await panel.db.get('SELECT body FROM messages WHERE id=?', [message.id]), before)
})

test('historical nested forwards restore media from the closest stored forward identifier', async t => {
  const { panel, bot, urls } = await setup(t), { id } = await oldMedia(panel, true), actions = []
  bot.bots['11'].sendApi = async (action, params) => {
    actions.push(action); assert.equal(action, 'get_forward_msg'); assert.equal(params.id, 'forward-inner')
    return { data: { messages: [{ sender: { nickname: 'Author' }, content: [{ type: 'video', data: { file: 'forward.mp4', url: videoUrl('forward-current') } }] }] } }
  }
  await panel.media.get(id)
  assert.deepEqual(actions, ['get_forward_msg'])
  assert.equal(urls[0].searchParams.get('rkey'), 'forward-current')
  assert.equal(JSON.parse((await panel.db.get('SELECT locator FROM media WHERE id=?', [id])).locator).segment.file, 'forward.mp4')
})

test('OneBot get_file local-only responses fall back to a refreshed original message URL', async t => {
  const { panel, bot, urls } = await setup(t), message = await record(panel), calls = []
  bot.bots['11'].sendApi = async action => {
    calls.push(action)
    if (action === 'get_file') return { data: { url: 'C:\\adapter\\video.mp4' } }
    return { data: { message_id: message.platform_id, group_id: '100', message: [{ type: 'video', data: { file: 'video.file', url: videoUrl('refreshed-original') } }] } }
  }
  await panel.media.get(message.message[0].media_id)
  assert.deepEqual(calls, ['get_file', 'get_msg'])
  assert.equal(urls[0].searchParams.get('rkey'), 'refreshed-original')
})

test('private ICQQ video refresh preserves binary checksums for the SDK', async t => {
  const { panel, bot } = await setup(t), calls = []
  bot.bots['11'].adapter.name = 'ICQQ'
  const contact = { async getVideoUrl(element) { assert.equal(this, contact); calls.push(element); return videoUrl('private-sdk') } }
  bot.bots['11'].pickFriend = () => ({ raw: contact })
  const message = received({ ...incoming('11', 'private'), message: [{ type: 'video', fid: 'legacy-fid', md5: Buffer.alloc(16, 1), url: videoUrl('expired') }] })
  const recorded = await panel.bridge.record(message)
  await panel.media.get(recorded.message[0].media_id)
  assert.equal(calls[0].md5, '01'.repeat(16))
  assert.equal(calls[0].fid, 'legacy-fid')
})

test('new forward media keeps renewable locators when forward content is first fetched', async t => {
  const { panel, bot, urls } = await setup(t)
  bot.bots['11'].sendApi = async action => action === 'get_forward_msg' ? { data: { messages: [{ content: [{ type: 'video', data: { file: 'node.mp4', url: videoUrl('old') } }] }] } } : { data: { url: videoUrl('renewed') } }
  const message = received({ ...incoming('11'), message: [{ type: 'forward', data: { id: 'new-forward' } }] })
  await panel.db.save(message)
  const loaded = await panel.bridge.forwards.load('11', { id: message.id, path: [0] })
  const part = loaded.message[0].content[0].message[0]
  assert.equal(JSON.parse((await panel.db.get('SELECT locator FROM media WHERE id=?', [part.media_id])).locator).segment.file, 'node.mp4')
  await panel.media.get(part.media_id)
  assert.equal(urls[0].searchParams.get('rkey'), 'renewed')
})

test('video refresh rejects local paths, isolates bots and retries expired download URLs once', async t => {
  const { panel, bot } = await setup(t), calls = [], urls = []
  for (const botId of ['11', '22']) bot.bots[botId].sendApi = async (action, params) => { calls.push(botId); return { data: { file: 'C:\\private\\secret.mp4', url: videoUrl(`bot-${botId}-${calls.length}`) } } }
  const first = await record(panel), second = await record(panel, 'video', '22')
  assert.notEqual(first.message[0].media_id, second.message[0].media_id)
  panel.media.fetch = async source => {
    urls.push(new URL(source))
    if (urls.length === 1) throw Object.assign(new Error('expired'), { upstreamStatus: 403 })
    return Readable.from('video')
  }
  await panel.media.get(first.message[0].media_id)
  await panel.media.get(second.message[0].media_id)
  assert.deepEqual(calls, ['11', '11', '22'])
  assert.deepEqual(urls.map(url => url.searchParams.get('rkey')), ['bot-11-1', 'bot-11-2', 'bot-22-3'])
  bot.bots['11'].sendApi = async () => ({ data: { url: 'file:///C:/private/secret.mp4' } })
  const third = await record(panel, 'video', '11', { file: 'third.mp4' })
  await assert.rejects(panel.media.get(third.message[0].media_id), /无法刷新/)
  assert.equal(urls.length, 3)
})

test('legacy recovery rejects another conversation and keeps an original URL as a fallback', async t => {
  const { panel, bot, urls } = await setup(t), { id } = await oldMedia(panel)
  bot.bots['11'].sendApi = async () => ({ data: { group_id: 'different', message: [{ type: 'video', data: { file: 'wrong.mp4', url: videoUrl('wrong') } }] } })
  await panel.media.get(id)
  assert.equal(urls[0].searchParams.get('rkey'), 'expired')
  assert.equal((await panel.db.get('SELECT locator FROM media WHERE id=?', [id])).locator, null)
})

test('adding media locators migrates existing SQLite databases without losing rows', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-web-media-schema-')), file = path.join(directory, 'old.sqlite')
  let old, db
  try {
    old = new sqlite3.Database(file)
    await new Promise((resolve, reject) => old.exec("CREATE TABLE media(id TEXT PRIMARY KEY,source TEXT,path TEXT,name TEXT,mime TEXT,size INTEGER,created INTEGER,bot_id TEXT); INSERT INTO media VALUES('old','https://example.test/file',NULL,'file','',0,0,'11');", e => e ? reject(e) : resolve()))
    await new Promise((resolve, reject) => old.close(e => e ? reject(e) : resolve())); old = null
    db = await new Database().open(file)
    const row = await db.get('SELECT * FROM media WHERE id=?', ['old'])
    assert.equal(row.source, 'https://example.test/file'); assert.equal(row.locator, null)
  } finally { if (old) await new Promise(resolve => old.close(resolve)); await db?.close(); await fs.rm(directory, { recursive: true, force: true }) }
})
