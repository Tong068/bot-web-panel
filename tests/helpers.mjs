import { EventEmitter } from 'node:events'
import { Duplex } from 'node:stream'
import { IncomingMessage, ServerResponse } from 'node:http'
import express from 'express'

export function framework() {
  const bot = new EventEmitter()
  bot.bots = {}; bot.uin = []; bot.adapter = []; bot.calls = []
  bot.express = express(); bot.logs = []
  bot.express.use(express.json()).use((req, res, next) => { bot.logs.push(req.url); next() })
  bot.express.get('/existing', (req, res) => res.json({ alive: true }))
  for (const id of ['11', '22', 'official']) addBot(bot, id)
  return bot
}
export function addBot(framework, id) {
  const adapter = { id: id === 'official' ? 'QQBot' : 'QQ', name: id === 'official' ? 'QQBot' : 'OneBotv11', sep: ':',
    async sendFriendMsg(data, message) { framework.calls.push({ ...data, message }); return { message_id: `sent-${framework.calls.length}` } },
    async sendGroupMsg(data, message) { framework.calls.push({ ...data, message }); return { message_id: `sent-${framework.calls.length}` } }
  }
  const user = id === 'official' ? 'official:user_openid' : '100', group = id === 'official' ? 'official:group_openid' : '100'
  const bot = { adapter, online: true, nickname: id === 'official' ? '测试官机' : `测试机器人 ${id}`, fl: new Map([[user, { nickname: '测试好友' }]]), gl: new Map([[group, { group_name: '测试群' }]]),
    pickFriend(user_id) { return { sendMsg: msg => adapter.sendFriendMsg({ self_id: id, user_id }, msg), recallMsg: async () => true, sendFile: async () => ({ message_id: 'file-1' }) } },
    pickGroup(group_id) { return { sendMsg: msg => adapter.sendGroupMsg({ self_id: id, group_id }, msg), recallMsg: async () => true, sendFile: async () => ({ message_id: 'file-1' }), getMemberMap: async () => new Map([['200', { user_id: '200', nickname: '测试成员' }]]) } }
  }
  framework.bots[id] = bot; framework.uin.push(id); framework.adapter.push(adapter)
  return bot
}
export function incoming(bot_id, kind = 'group', id = 'm1', text = 'hello') {
  return { self_id: bot_id, post_type: 'message', message_type: kind, user_id: '100', ...(kind === 'group' ? { group_id: bot_id === 'official' ? 'official:group_openid' : '100' } : {}), message_id: id, time: Math.floor(Date.now() / 1000), sender: { user_id: '100', nickname: '测试成员' }, message: [{ type: 'text', text }] }
}
export function inject(app, url, { method = 'GET', body, headers = {}, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [], socket = new Duplex({ read() {}, write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback() } })
    socket.remoteAddress = '127.0.0.1'
    const req = new IncomingMessage(socket); req.url = url; req.method = method
    const buffer = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
    req.headers = { host: 'localhost:2536', ...(buffer ? { 'content-type': 'application/json', 'content-length': String(buffer.length) } : {}), ...headers }
    const res = new ServerResponse(req); res.assignSocket(socket)
    const result = () => { const raw = Buffer.concat(chunks).toString(); const body = raw.slice(raw.indexOf('\r\n\r\n') + 4); return { status: res.statusCode, headers: res.getHeaders(), text: body, json: () => JSON.parse(body), res, req, chunks } }
    res.on('finish', () => resolve(result())); res.on('error', reject)
    app.handle(req, res)
    req.push(buffer); if (buffer) req.push(null); req.complete = true
    if (stream) setTimeout(() => resolve(result()), 30)
  })
}
export const config = { enabled: true, retentionDays: 7, uploadMaxMB: 20, mediaCacheMB: 512, sessionHours: 24, allowedOrigins: [], mediaHosts: [] }
