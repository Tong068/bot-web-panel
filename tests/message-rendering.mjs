import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createPanel } from '../lib/server.js'
import { framework, incoming, config } from './helpers.mjs'
import { received } from '../lib/messages.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = path.join(root, 'tests/output')
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-web-rendering-'))
const base = process.env.BOT_WEB_URL || 'http://localhost:2536'
const bot = framework(), errors = []
const panel = await createPanel(bot, { config: { ...config }, testing: true, dataDir: directory, log: { info() {}, error(message) { errors.push(message) } } })
let browser
try {
  await fs.mkdir(output, { recursive: true })
  bot.bots['11'].gml = new Map([[100, new Map([[200, { card: '小林的群名片', nickname: '小林' }]])]])
  bot.emit('message', incoming('11', 'group', 'original', '今晚八点确认活动安排。'))
  const quoted = { ...incoming('11', 'group', 'quoted'), message: [{ type: 'reply', data: { id: 'original' } }, { type: 'at', data: { qq: 200 } }, { type: 'text', text: ' 收到，按这个时间安排。' }] }
  bot.emit('message', quoted)
  bot.emit('message', { ...incoming('11', 'group', 'missing'), message: [{ type: 'reply', id: 'missing-original' }, { type: 'text', text: '这是一条原文已不可用的回复。' }] })
  await panel.bridge.tasks
  // Exercise recovery of records saved before reply and member enrichment existed.
  const old = received({ ...quoted, message_id: 'old' }); old.quote = null
  const saved = await panel.db.save(old)
  const all = await panel.bridge.action('11', 'get_history', { kind: 'group', target_id: '100' })
  const contact = (await panel.bridge.contacts('11')).find(item => item.kind === 'group')
  const reply = all.find(item => item.platform_id === 'quoted')
  const missing = all.find(item => item.platform_id === 'missing')
  browser = await chromium.launch({ executablePath: path.resolve(root, '../../browsers/chromium-1234/chrome-win64/chrome.exe'), headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  // The running framework serves only static assets; all API traffic uses fixtures.
  await page.route('**/bot-web/api/**', async route => {
    const endpoint = new URL(route.request().url()).pathname.split('/').at(-1)
    if (endpoint === 'session') return route.fulfill({ json: { csrf: 'fixture' } })
    if (endpoint === 'settings') return route.fulfill({ json: config })
    if (endpoint === 'bots') return route.fulfill({ json: [{ id: '11', name: '测试机器人', online: true, unread: 0 }] })
    if (endpoint === 'events') return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' })
    if (endpoint !== 'action') { errors.push(`Unexpected endpoint: ${endpoint}`); return route.abort() }
    const { action } = route.request().postDataJSON()
    const data = action === 'get_contacts' ? [contact] : action === 'get_history' ? all : action === 'mark_read' ? true : action === 'get_capabilities' ? panel.bridge.capabilities(bot.bots['11'].pickGroup('100'), 'group', '11') : undefined
    if (data === undefined) { errors.push(`Unexpected action: ${action}`); return route.abort() }
    return route.fulfill({ json: { data } })
  })
  await page.goto(`${base}/bot-web/`)
  await page.getByRole('button', { name: /测试群/ }).click()
  for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport)
    for (const id of [reply.id, saved.message.id]) {
      const message = page.locator(`#chat-${id}`)
      await message.locator('.msg-at').waitFor()
      assert.equal(await message.locator('.msg-at').textContent(), '@小林的群名片')
      assert.equal(await message.locator('.msg-at').getAttribute('title'), '200')
      assert.equal(await message.locator('.quote-text').count(), 1)
      assert.match(await message.locator('.quote-text').textContent(), /今晚八点确认活动安排。/)
      assert.ok(!(await message.textContent()).includes('original'))
      const bounds = await message.locator('.quote-text').evaluate(el => ({ width: el.getBoundingClientRect().width, parent: el.parentElement.getBoundingClientRect().width, scroll: el.scrollWidth, client: el.clientWidth }))
      assert.ok(bounds.width <= bounds.parent + 1 && bounds.scroll <= bounds.client + 1, JSON.stringify(bounds))
    }
    const unavailable = page.locator(`#chat-${missing.id}`)
    assert.equal(await unavailable.locator('.quote-text').count(), 1)
    assert.match(await unavailable.locator('.quote-text').textContent(), /引用内容暂不可用/)
    await page.screenshot({ path: path.join(output, `message-rendering-${viewport.width}.png`) })
  }
  assert.equal(bot.calls.length, 0)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ viewports: [1440, 390, 320], mentions: 'passed', quotes: 'passed', oldHistory: 'passed', realMessagesSent: 0 }))
} finally {
  await browser?.close()
  await panel.close()
  await fs.rm(directory, { recursive: true, force: true })
}
