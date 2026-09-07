import sqlite3 from 'sqlite3'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fail } from './config.js'

export const conversationKey = (bot, kind, target) => JSON.stringify([String(bot), kind, String(target)])
export class Database {
  async open(file) {
    if (file !== ':memory:') await fs.mkdir(path.dirname(file), { recursive: true })
    this.db = await new Promise((resolve, reject) => { const db = new sqlite3.Database(file, e => e ? reject(e) : resolve(db)) })
    this.queue = Promise.resolve()
    await this.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(key TEXT PRIMARY KEY,bot_id TEXT NOT NULL,kind TEXT NOT NULL,target_id TEXT NOT NULL,name TEXT NOT NULL,avatar TEXT DEFAULT '',last_seq INTEGER DEFAULT 0,read_seq INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS conversation_preferences(key TEXT PRIMARY KEY REFERENCES conversations(key) ON DELETE CASCADE,pinned INTEGER NOT NULL DEFAULT 0,marked_unread INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,conversation TEXT NOT NULL,bot_id TEXT NOT NULL,platform_id TEXT,created INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS message_platform ON messages(conversation,platform_id) WHERE platform_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS message_conversation ON messages(conversation,seq);
      CREATE TABLE IF NOT EXISTS message_receipts(conversation TEXT NOT NULL,platform_id TEXT NOT NULL,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,PRIMARY KEY(conversation,platform_id));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,created INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY,source TEXT,path TEXT,name TEXT,mime TEXT,size INTEGER DEFAULT 0,created INTEGER NOT NULL,bot_id TEXT NOT NULL,locator TEXT);
      CREATE INDEX IF NOT EXISTS media_source ON media(bot_id,source);
      `)
    if (!(await this.all('PRAGMA table_info(media)')).some(column => column.name === 'locator')) await this.exec('ALTER TABLE media ADD COLUMN locator TEXT')
    const version = await this.get('PRAGMA user_version')
    if (version.user_version < 2) await this.exec(`
      INSERT OR IGNORE INTO message_receipts SELECT conversation,platform_id,id FROM messages WHERE platform_id IS NOT NULL;
      INSERT OR IGNORE INTO message_receipts SELECT m.conversation,CAST(j.value AS TEXT),m.id FROM messages m,json_each(m.body,'$.platform_ids') j WHERE j.value IS NOT NULL;
      PRAGMA user_version=2;`)
    return this
  }
  exec(sql) { return new Promise((resolve, reject) => this.db.exec(sql, e => e ? reject(e) : resolve())) }
  run(sql, args = []) { return new Promise((resolve, reject) => this.db.run(sql, args, function(e) { e ? reject(e) : resolve({ id: this.lastID, changes: this.changes }) })) }
  get(sql, args = []) { return new Promise((resolve, reject) => this.db.get(sql, args, (e, row) => e ? reject(e) : resolve(row))) }
  all(sql, args = []) { return new Promise((resolve, reject) => this.db.all(sql, args, (e, rows) => e ? reject(e) : resolve(rows))) }
  serialized(fn) { const work = this.queue.then(fn); this.queue = work.catch(() => {}); return work }
  async setting(key, value) {
    if (value !== undefined) await this.run('INSERT OR REPLACE INTO settings VALUES(?,?)', [key, JSON.stringify(value)])
    const row = await this.get('SELECT value FROM settings WHERE key=?', [key]); return row ? JSON.parse(row.value) : undefined
  }
  async save(message) {
    return this.serialized(async () => {
      const key = conversationKey(message.bot_id, message.kind, message.target_id)
      const sameId = await this.get('SELECT * FROM messages WHERE id=?', [message.id || ''])
      if (sameId && sameId.conversation !== key) throw fail(409, '发送请求标识已被其他会话使用')
      const ids = [...new Set([message.platform_id, ...(message.platform_ids || [])].filter(id => id != null && id !== '').map(String))]
      const reported = ids.length ? await this.all(`SELECT DISTINCT m.* FROM messages m JOIN message_receipts r ON r.message_id=m.id WHERE r.conversation=? AND r.platform_id IN (${ids.map(() => '?').join(',')})`, [key, ...ids]) : []
      const existing = sameId || reported[0]
      const old = existing ? JSON.parse(existing.body) : {}
      const body = { ...old, ...message, id: existing?.id || message.id || randomUUID(), conversation: key }
      if (existing && ['panel', 'plugin'].includes(old.origin)) body.origin = old.origin
      if (existing && message.origin === 'adapter' && ['panel', 'plugin'].includes(old.origin)) {
        for (const field of ['message', 'preview', 'time', 'sender', 'direction', 'platform_id', 'status', 'error', 'quote']) if (old[field] !== undefined) body[field] = old[field]
      }
      body.platform_ids = [...new Set([...(old.platform_ids || []), ...reported.flatMap(row => JSON.parse(row.body).platform_ids || [row.platform_id]), ...ids].filter(Boolean).map(String))]
      if (existing && !message.message?.length) body.message = old.message
      const replaced = reported.filter(row => row.id !== body.id)
      if (replaced.length) {
        body.replaced_ids = replaced.map(row => row.id)
        for (const row of replaced) await this.run('DELETE FROM messages WHERE id=?', [row.id])
      }
      await this.run(`INSERT INTO conversations(key,bot_id,kind,target_id,name,avatar) VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET name=CASE WHEN excluded.name!=excluded.target_id THEN excluded.name ELSE conversations.name END,avatar=CASE WHEN excluded.avatar!='' THEN excluded.avatar ELSE conversations.avatar END`, [key, body.bot_id, body.kind, body.target_id, body.conversation_name || body.target_id, body.conversation_avatar || ''])
      if (existing) await this.run('UPDATE messages SET body=?,platform_id=? WHERE id=?', [JSON.stringify(body), body.platform_id || null, body.id])
      else await this.run('INSERT INTO messages(id,conversation,bot_id,platform_id,created,body) VALUES(?,?,?,?,?,?)', [body.id, key, body.bot_id, body.platform_id || null, Date.now(), JSON.stringify(body)])
      for (const id of body.platform_ids) await this.run('INSERT OR REPLACE INTO message_receipts VALUES(?,?,?)', [key, id, body.id])
      const row = await this.get('SELECT seq FROM messages WHERE id=?', [body.id]); body.seq = row.seq
      await this.run('UPDATE conversations SET last_seq=MAX(last_seq,?) WHERE key=?', [body.seq, key])
      return { message: body, update: !!existing }
    })
  }
  async event(data) { const { id } = await this.run('INSERT INTO events(created,body) VALUES(?,?)', [Date.now(), JSON.stringify(data)]); return { seq: id, ...data } }
  async history(key, before, limit = 50) {
    const rows = await this.all('SELECT seq,body FROM messages WHERE conversation=? AND seq<? ORDER BY seq DESC LIMIT ?', [key, before || Number.MAX_SAFE_INTEGER, Math.min(Math.max(Number(limit) || 50, 1), 100)])
    return rows.reverse().map(row => ({ ...JSON.parse(row.body), seq: row.seq }))
  }
  async conversations(bot) {
    const rows = await this.all(`SELECT c.*,COALESCE(p.pinned,0) pinned,COALESCE(p.marked_unread,0) marked_unread,(SELECT COUNT(*) FROM messages m WHERE m.conversation=c.key AND m.seq>c.read_seq AND json_extract(m.body,'$.direction')='in') unread,(SELECT body FROM messages m WHERE m.conversation=c.key ORDER BY seq DESC LIMIT 1) last FROM conversations c LEFT JOIN conversation_preferences p ON p.key=c.key WHERE bot_id=? ORDER BY pinned DESC,last_seq DESC`, [bot])
    return rows.map(row => ({ ...row, pinned: !!row.pinned, unread: Math.max(row.unread, row.marked_unread), last: row.last ? JSON.parse(row.last) : null }))
  }
  async read(key, seq) {
    await this.serialized(async () => {
      await this.run('UPDATE conversations SET read_seq=MAX(read_seq,MIN(last_seq,?)) WHERE key=?', [seq, key])
      await this.run('UPDATE conversation_preferences SET marked_unread=0 WHERE key=?', [key])
    })
  }
  async preferences(bot, kind, target, changes) {
    const key = conversationKey(bot, kind, target)
    await this.serialized(async () => {
      await this.run('INSERT OR IGNORE INTO conversations(key,bot_id,kind,target_id,name) VALUES(?,?,?,?,?)', [key, bot, kind, target, target])
      await this.run('INSERT OR IGNORE INTO conversation_preferences(key) VALUES(?)', [key])
      if ('pinned' in changes) await this.run('UPDATE conversation_preferences SET pinned=? WHERE key=?', [Number(changes.pinned), key])
      if ('unread' in changes) {
        await this.run('UPDATE conversation_preferences SET marked_unread=? WHERE key=?', [Number(changes.unread), key])
        if (!changes.unread) await this.run('UPDATE conversations SET read_seq=last_seq WHERE key=?', [key])
      }
    })
  }
  async cleanup(days) {
    const cutoff = Date.now() - days * 86400000
    await this.serialized(async () => { await this.run('DELETE FROM messages WHERE created<?', [cutoff]); await this.run('DELETE FROM events WHERE created<?', [cutoff]) })
    await this.run('DELETE FROM sessions WHERE expires<?', [Date.now()])
  }
  async close() { await this.queue; await new Promise((resolve, reject) => this.db.close(e => e ? reject(e) : resolve())) }
}
