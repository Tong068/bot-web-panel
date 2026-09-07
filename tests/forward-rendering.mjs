import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createPanel } from '../lib/server.js'
import { framework, incoming, config } from './helpers.mjs'
import { received } from '../lib/messages.js'

const root = fileURLToPath(new URL('../', import.meta.url)), output = path.join(root, 'tests/output')
const base = process.env.BOT_WEB_URL || 'http://localhost:2536'
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-web-forward-ui-'))
const bot = framework(), errors = [], calls = [], firstResponse = Promise.withResolvers()
const panel = await createPanel(bot, { config: { ...config }, testing: true, dataDir: directory, log: { info() {}, error(message) { errors.push(message) } } })
let browser, retries = 0
try {
  await fs.mkdir(output, { recursive: true })
  const photo = await panel.media.store(createReadStream(path.join(root, 'web/public/img/icons/AppIcon.png')), 'photo.png', '11')
  const nodes = [{ sender: { nickname: '转发者甲' }, content: [{ type: 'text', data: { text: '这是合并转发中的正文。' } }, { type: 'image', data: { url: photo.url, media_id: photo.id } }, { type: 'face', data: { id: '14' } }] }, { sender: { nickname: '转发者乙' }, content: [{ type: 'forward', data: { id: 'nested' } }] }]
  bot.bots['11'].sendApi = async (action, params) => {
    calls.push({ bot: '11', action, ...params })
    if (params.id === '7682845948127089821') { await firstResponse.promise; return { data: { messages: nodes } } }
    if (params.id === 'retry' && ++retries === 1) throw new Error('temporary failure')
    return { data: { messages: [{ sender: { nickname: '转发者丙' }, content: [{ type: 'text', data: { text: params.id === 'nested' ? '嵌套转发内容。' : '重试后取得的内容。' } }] }] } }
  }
  bot.bots['22'].adapter.name = 'ICQQ'
  const group = bot.bots['22'].pickGroup
  const raw = { async getForwardMsg(resid, filename) { assert.equal(this, raw); calls.push({ bot: '22', resid, filename }); return [{ nickname: 'ICQQ 转发者', message: [{ type: 'text', text: 'ICQQ 合并转发内容。' }, { type: 'at', qq: 'all' }] }] } }
  bot.bots['22'].pickGroup = id => ({ ...group(id), raw })
  const onebot = received({ ...incoming('11', 'group', 'onebot'), message: [{ type: 'forward', data: { id: '7682845948127089821' } }] })
  const retry = received({ ...incoming('11', 'group', 'retry'), message: [{ type: 'forward', data: { id: 'retry' } }] })
  const icqq = received({ ...incoming('22', 'group', 'icqq'), message: [{ type: 'multimsg', resid: 'icqq-resid', filename: 'MultiMsg' }] })
  for (const message of [onebot, retry, icqq]) await panel.db.save(message)
  browser = await chromium.launch({ executablePath: path.resolve(root, '../../browsers/chromium-1234/chrome-win64/chrome.exe'), headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message))
  // Only static assets use the running framework. API and media responses come from local fixtures.
  await page.route('**/bot-web/api/**', async route => {
    const url = new URL(route.request().url()), endpoint = url.pathname.split('/').at(-1)
    if (url.pathname.includes('/api/media/')) { const file = await panel.media.get(endpoint); return route.fulfill({ path: file.path, contentType: file.mime }) }
    if (endpoint === 'session') return route.fulfill({ json: { csrf: 'fixture' } })
    if (endpoint === 'settings') return route.fulfill({ json: config })
    if (endpoint === 'bots') return route.fulfill({ json: (await panel.bridge.bots()).filter(item => item.id !== 'official') })
    if (endpoint === 'events') return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' })
    if (endpoint !== 'action') { errors.push(`Unexpected endpoint: ${endpoint}`); return route.abort() }
    const { action, bot_id, params } = route.request().postDataJSON()
    if (!['get_contacts', 'get_history', 'get_capabilities', 'get_forward_msg', 'mark_read'].includes(action)) { errors.push(`Unexpected action: ${action}`); return route.abort() }
    try { return route.fulfill({ json: { data: await panel.bridge.action(bot_id, action, params) } }) }
    catch (error) { return route.fulfill({ status: error.status || 500, json: { error: error.message } }) }
  })
  await page.goto(`${base}/bot-web/`)
  await page.getByRole('button', { name: /测试群/ }).click()
  const forward = page.locator(`#chat-${onebot.id} > .message-body > div > details`)
  await forward.locator(':scope > summary').click()
  await forward.getByRole('status').waitFor()
  assert.equal(calls.length, 1)
  firstResponse.resolve()
  await forward.getByText('这是合并转发中的正文。', { exact: true }).waitFor()
  await forward.locator('.msg-img').evaluate(img => img.decode())
  assert.equal(await forward.locator('.msg-face').count(), 1)
  await forward.locator('details > summary').click()
  await forward.getByText('嵌套转发内容。', { exact: true }).waitFor()
  await forward.locator('.msg-img').click()
  await page.getByRole('dialog', { name: '图片预览' }).waitFor()
  await page.getByLabel('关闭预览').click()
  const failed = page.locator(`#chat-${retry.id} .msg-forward`)
  await failed.locator('summary').click(); await failed.getByRole('alert').waitFor()
  await failed.getByLabel('重新加载转发消息').click()
  await failed.getByText('重试后取得的内容。', { exact: true }).waitFor()
  for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport)
    await forward.scrollIntoViewIfNeeded()
    const bounds = await forward.evaluate(el => [el, ...el.querySelectorAll('.forward-node-content, .msg-forward')].map(node => ({ width: node.getBoundingClientRect().width, scroll: node.scrollWidth, client: node.clientWidth, viewport: innerWidth })))
    assert.ok(bounds.every(node => node.scroll <= node.client + 1 && node.width < node.viewport), JSON.stringify(bounds))
    await page.screenshot({ path: path.join(output, `forward-onebot-${viewport.width}.png`) })
  }
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.getByLabel('选择机器人').selectOption('22')
  await page.getByRole('button', { name: /测试群/ }).click()
  await page.locator(`#chat-${icqq.id} summary`).click()
  await page.getByText('ICQQ 合并转发内容。', { exact: true }).waitFor()
  assert.equal(await page.locator(`#chat-${icqq.id} .msg-at`).textContent(), '@全体成员')
  assert.deepEqual(calls.at(-1), { bot: '22', resid: 'icqq-resid', filename: 'MultiMsg' })
  await page.screenshot({ path: path.join(output, 'forward-icqq.png') })
  const count = calls.length
  await page.reload()
  await page.getByLabel('选择机器人').selectOption('22')
  await page.locator(`#chat-${icqq.id} summary`).click()
  await page.getByText('ICQQ 合并转发内容。', { exact: true }).waitFor()
  assert.equal(calls.length, count, 'Loaded forwards must persist across reloads')
  assert.equal(bot.calls.length, 0); assert.deepEqual(errors, [])
  console.log(JSON.stringify({ onebot: 'passed', icqq: 'passed', nested: 'passed', media: 'passed', retry: 'passed', persisted: 'passed', realMessagesSent: 0 }))
} finally {
  firstResponse.resolve()
  await browser?.close(); await panel.close(); await fs.rm(directory, { recursive: true, force: true })
}
