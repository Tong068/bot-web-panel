import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { createPanel } from '../lib/server.js'
import { framework, inject, config } from './helpers.mjs'

// Static assets use the running framework; all APIs use an isolated test database.
const origin = new URL(process.env.BOT_WEB_URL || 'http://localhost:2536').origin
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-web-login-browser-'))
const output = path.resolve('plugins/bot-web-panel/tests/output')
await fs.mkdir(output, { recursive: true })
const bot = framework()
bot.bots = {}; bot.uin = []; bot.adapter = []
let panel, browser
try {
  panel = await createPanel(bot, { config: { ...config }, testing: true, dataDir: directory })
  browser = await chromium.launch({ executablePath: path.resolve('browsers/chromium-1234/chrome-win64/chrome.exe'), headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
  const page = await context.newPage(), errors = [], requests = []
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  await context.route('**/bot-web/api/**', async route => {
    const request = route.request(), url = new URL(request.url())
    requests.push({ path: url.pathname, method: request.method(), hash: new URL(page.url()).hash })
    if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' })
    const response = await inject(bot.express, url.pathname, {
      method: request.method(), headers: { ...await request.allHeaders(), host: url.host },
      ...(request.postData() ? { body: request.postDataJSON() } : {})
    })
    const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, String(Array.isArray(value) ? value[0] : value)]))
    await route.fulfill({ status: response.status, headers, body: response.text })
  })
  const code = await panel.auth.createQuickLogin(), link = `${origin}/bot-web/#login=${code}`
  await page.goto(link)
  await page.locator('#base-app').waitFor()
  assert.equal(page.url(), `${origin}/bot-web/`)
  assert.equal(requests[0].path, '/bot-web/api/login/quick')
  assert.equal(requests[0].method, 'POST'); assert.equal(requests[0].hash, '')
  const cookie = (await context.cookies()).find(cookie => cookie.name === 'bot_web_session')
  assert.ok(cookie?.httpOnly); assert.equal(cookie.sameSite, 'Strict')
  await page.screenshot({ path: path.join(output, 'login-quick-desktop.png') })
  await page.reload(); await page.locator('#base-app').waitFor()
  await page.getByLabel('退出登录').click(); await page.locator('#password').waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(link)
  await page.getByRole('alert').filter({ hasText: '登录链接无效或已过期' }).waitFor()
  assert.equal(page.url(), `${origin}/bot-web/`)
  await page.screenshot({ path: path.join(output, 'login-expired-mobile.png') })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.locator('#password').fill(panel.initialPassword)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.locator('#base-app').waitFor()
  await page.getByLabel('退出登录').click(); await page.locator('#password').waitFor()
  await page.goto(`${origin}/bot-web/#login=${await panel.auth.createQuickLogin()}`)
  await page.locator('#base-app').waitFor()
  assert.equal(new URL(page.url()).hash, '')
  assert.deepEqual(errors, []); assert.deepEqual(bot.calls, [])
  console.log('Quick login passed on desktop and mobile; URL cleanup, cookie, reload, logout, expired-link error and password fallback verified.')
} finally {
  await browser?.close(); await panel?.close()
  await fs.rm(directory, { recursive: true, force: true })
}
