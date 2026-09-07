import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const base = process.env.BOT_WEB_URL || 'http://localhost:2536'
for (const resource of ['/bot-web/', '/bot-web/bcui/css/style.css', '/bot-web/bcui/css/color-light.css', '/status', '/guoba/']) {
  const response = await fetch(`${base}${resource}`)
  assert.equal(response.status, 200, resource)
  await response.arrayBuffer()
}
assert.equal((await fetch(`${base}/bot-web/api/bots`)).status, 401)
assert.equal((await fetch(`${base}/bot-web/data/initial-password.txt`)).status, 404)
const password = process.env.BOT_WEB_PASSWORD || (await fs.readFile(new URL('../data/initial-password.txt', import.meta.url), 'utf8')).trim().split(/\r?\n/)[1]
const response = await fetch(`${base}/bot-web/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ username: 'admin', password }) })
assert.equal(response.status, 200)
const session = await response.json(), cookie = response.headers.get('set-cookie').split(';')[0]
try {
  const response = await fetch(`${base}/bot-web/api/bots`, { headers: { Cookie: cookie } })
  assert.equal(response.status, 200)
  const bots = await response.json()
  assert.ok(Array.isArray(bots))
  const avatars = { contacts: 0, registered: 0, downloaded: 0, bytes: 0 }, samples = []
  for (const bot of bots) {
    const response = await fetch(`${base}/bot-web/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie, 'X-CSRF-Token': session.csrf }, body: JSON.stringify({ bot_id: bot.id, action: 'get_contacts' }), signal: AbortSignal.timeout(30000) })
    assert.equal(response.status, 200)
    const { data } = await response.json()
    assert.ok(Array.isArray(data)); avatars.contacts += data.length
    for (const contact of data) {
      if (!contact.avatar) continue
      assert.match(contact.avatar, /^\/bot-web\/api\/media\/[a-f0-9-]{36}$/)
      avatars.registered++
      if (samples.length < 3) samples.push(contact.avatar)
    }
  }
  for (const url of samples) {
    assert.equal((await fetch(`${base}${url}`)).status, 401)
    const response = await fetch(`${base}${url}`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(20000) })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^image\//)
    const bytes = (await response.arrayBuffer()).byteLength
    assert.ok(bytes > 0); avatars.downloaded++; avatars.bytes += bytes
  }
  console.log(JSON.stringify({ url: `${base}/bot-web/`, bots: bots.map(bot => ({ adapter: bot.adapter, online: bot.online })), count: bots.length, avatars, routes: 'ok', authentication: 'ok', realMessagesSent: 0 }))
} finally {
  const response = await fetch(`${base}/bot-web/api/logout`, { method: 'POST', headers: { Origin: base, Cookie: cookie, 'X-CSRF-Token': session.csrf } })
  assert.equal(response.status, 200)
}
