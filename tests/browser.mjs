import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { createReadStream } from 'node:fs'
import net from 'node:net'
import { chromium } from 'playwright'
import { createPanel } from '../lib/server.js'
import { framework, incoming, config } from './helpers.mjs'
import { checkFeatures } from './browser-features.mjs'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-web-browser-'))
const output = path.resolve('plugins/bot-web-panel/tests/output')
await fs.mkdir(output, { recursive: true })
const occupied = await new Promise(resolve => { const socket = net.connect(2536, '127.0.0.1'); socket.once('connect', () => { socket.end(); resolve(true) }); socket.once('error', () => resolve(false)) })
if (occupied) throw new Error('Framework port 2536 is already in use. Browser fixtures never replace a running bot.')
const Orangezai = (await import('../../../lib/bot.js')).default
process.removeAllListeners('unhandledRejection')
process.on('unhandledRejection', error => { console.error(error); process.exit(1) })
process.removeAllListeners('uncaughtException')
process.on('uncaughtException', error => { console.error(error); process.exit(1) })
globalThis.Bot = new Orangezai()
const fixture = framework()
fixture.bots['11'].gl.get('100').group_name = '日常交流群'
fixture.bots['22'].gl.get('100').group_name = '另一个账号的群聊'
for (const [id, bot] of Object.entries(fixture.bots)) Bot.bots[id] = bot
Bot.uin.push(...fixture.uin)
// Only the framework's existing listener is started; all accounts are local test doubles.
await Bot.serverLoad()
let panel, browser
const errors = []
let disconnecting = false
try {
  panel = await createPanel(Bot, { config: { ...config }, testing: true, dataDir: directory, log: { info() {}, error(message) { errors.push(message) } } })
  for (const [id, bot] of Object.entries(fixture.bots)) {
    const own = await panel.media.store(createReadStream('plugins/bot-web-panel/web/public/img/icons/AppIcon.png'), 'bot.png', id)
    const user = await panel.media.store(createReadStream('plugins/bot-web-panel/web/public/qface/0.png'), 'friend.png', id)
    const groupAvatar = await panel.media.store(createReadStream('plugins/bot-web-panel/web/public/qface/14.png'), 'group.png', id)
    const friend = bot.pickFriend, group = bot.pickGroup
    bot.avatar = own.url
    bot.pickFriend = target => ({ ...friend(target), getAvatarUrl: () => target === id ? own.url : user.url })
    bot.pickGroup = target => ({ ...group(target), getAvatarUrl: () => groupAvatar.url })
    bot.pickMember = () => ({ getAvatarUrl: () => user.url })
  }
  const photo = await panel.media.store(createReadStream('plugins/bot-web-panel/web/public/img/icons/AppIcon.png'), 'Stapxs.png', '11')
  for (const [index, text] of ['今晚的活动安排确认了吗？', '时间定在 20:00，大家可以提前十分钟到。', '收到，我已经发到群公告里了。', '这是新的客户端图标。'].entries()) {
    const event = { ...incoming('11', 'group', `seed-${index}`, text), group_name: '日常交流群', sender: { user_id: '100', nickname: index % 2 ? '小林' : '林间晚风' } }
    if (index === 3) event.message.push({ type: 'image', media_id: photo.id, url: photo.url })
    Bot.emit('message', event)
  }
  Bot.emit('message', { ...incoming('11', 'private', 'private-1', '明天一起确认一下活动名单。'), sender: { user_id: '100', nickname: '小林' } })
  Bot.emit('message', { ...incoming('22', 'group', 'other-bot', '这条消息来自第二个机器人。'), group_name: '另一个账号的群聊' })
  Bot.emit('message', incoming('official', 'group', 'official-1', '官机 OpenID 会话已接入。'))
  await panel.bridge.tasks
  browser = await chromium.launch({ executablePath: path.resolve('browsers/chromium-1234/chrome-win64/chrome.exe'), headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: 'light' })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('401') && !(disconnecting && /net::ERR_/.test(message.text()))) errors.push(message.text()) })
  await page.goto('http://localhost:2536/bot-web/', { waitUntil: 'networkidle' })
  await page.locator('#password').fill(panel.initialPassword)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByLabel('选择机器人').waitFor()
  await page.screenshot({ path: path.join(output, 'initial.png') })
  await page.getByRole('button', { name: /日常交流群/ }).click()
  await page.getByLabel('消息输入框').fill('收到，今晚见。')
  await page.getByLabel('发送消息', { exact: true }).click()
  await page.getByText('已发送', { exact: true }).waitFor()
  assert.equal(fixture.calls.at(-1).self_id, '11')
  await page.screenshot({ path: path.join(output, 'desktop-light.png') })
  await page.getByLabel('消息输入框').fill('账号一的草稿')
  await page.getByLabel('选择机器人').selectOption('22')
  await page.getByRole('button', { name: /另一个账号的群聊/ }).click()
  assert.equal(await page.getByLabel('消息输入框').inputValue(), '')
  await page.getByLabel('消息输入框').fill('账号二发送')
  await page.getByLabel('发送消息', { exact: true }).click()
  await page.getByText('已发送', { exact: true }).waitFor()
  assert.equal(fixture.calls.at(-1).self_id, '22')
  await page.getByLabel('选择机器人').selectOption('11')
  await page.getByLabel('消息输入框').waitFor()
  assert.equal(await page.getByLabel('消息输入框').inputValue(), '账号一的草稿')
  const oldHistoryStarted = Promise.withResolvers(), releaseOldHistory = Promise.withResolvers()
  let delayHistory = true
  await page.route('**/bot-web/api/action', async route => {
    const body = route.request().postDataJSON()
    if (delayHistory && body.action === 'get_history' && body.bot_id === '22') {
      delayHistory = false; oldHistoryStarted.resolve(); await releaseOldHistory.promise
    }
    await route.continue().catch(() => {})
  })
  await page.getByLabel('选择机器人').selectOption('22')
  await oldHistoryStarted.promise
  await page.getByLabel('选择机器人').selectOption('11')
  releaseOldHistory.resolve()
  await page.waitForFunction(() => !document.querySelector('#main-input-ex')?.disabled)
  assert.equal(await page.getByLabel('消息输入框').inputValue(), '账号一的草稿')
  assert.equal(await page.locator('#chat-pan > .info p').textContent(), '日常交流群')
  await page.unroute('**/bot-web/api/action')
  await page.getByLabel('消息输入框').fill('')
  await page.getByLabel('切换主题').click()
  await page.screenshot({ path: path.join(output, 'desktop-dark.png') })
  await page.getByLabel('切换主题').click()
  await page.getByRole('img', { name: '图片', exact: true }).click()
  await page.getByLabel('关闭预览').waitFor()
  await page.keyboard.press('Escape')
  await page.getByLabel('表情', { exact: true }).click()
  await page.getByRole('button', { name: '微笑', exact: true }).click()
  await page.getByLabel('发送消息', { exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.send-button')?.hasAttribute('disabled'))
  const quoteTarget = page.locator('.message').filter({ hasText: '收到，我已经发到群公告里了。' })
  await quoteTarget.getByLabel('消息操作').click()
  await page.getByRole('menuitem', { name: '回复', exact: true }).click()
  await page.getByLabel('@成员', { exact: true }).click()
  await page.getByRole('button', { name: /测试成员/ }).click()
  await page.locator('input[type=file][accept]').setInputFiles(path.resolve('plugins/bot-web-panel/web/public/img/icons/AppIcon.png'))
  await page.locator('.attachment').waitFor()
  const countBefore = fixture.calls.length
  await page.getByLabel('发送消息', { exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.send-button')?.hasAttribute('disabled'))
  assert.equal(fixture.calls.length, countBefore + 1)
  assert.ok(fixture.calls.at(-1).message.some(x => x.type === 'reply'))
  assert.ok(fixture.calls.at(-1).message.some(x => x.type === 'at'))
  assert.ok(fixture.calls.at(-1).message.some(x => x.type === 'image'))
  await page.locator('.message.me').last().getByLabel('消息操作').click()
  await page.getByRole('menuitem', { name: '撤回', exact: true }).click()
  await page.getByText('消息已撤回', { exact: true }).waitFor()
  const firstUploadStarted = Promise.withResolvers(), releaseUpload = Promise.withResolvers(), uploadIds = []
  await page.route('**/bot-web/api/uploads', async route => {
    uploadIds.push(route.request().headers()['x-bot-id'])
    if (uploadIds.length === 1) { firstUploadStarted.resolve(); await releaseUpload.promise }
    await route.continue()
  })
  const icon = path.resolve('plugins/bot-web-panel/web/public/img/icons/AppIcon.png')
  await page.locator('input[type=file][accept]').setInputFiles([icon, icon])
  await firstUploadStarted.promise
  await page.getByLabel('选择机器人').selectOption('22')
  releaseUpload.resolve()
  await page.waitForFunction(() => !document.querySelector('#main-input-ex')?.disabled)
  assert.equal(await page.locator('.attachment').count(), 0)
  await page.getByLabel('选择机器人').selectOption('11')
  await page.waitForFunction(() => document.querySelectorAll('.attachment').length === 2)
  assert.deepEqual(uploadIds, ['11', '11'])
  await page.unroute('**/bot-web/api/uploads')
  await page.getByLabel('移除附件').first().click(); await page.getByLabel('移除附件').first().click()
  Bot.emit('message', incoming('22', 'group', 'background-unread', '后台账号新消息'))
  await panel.bridge.tasks
  await page.waitForFunction(() => document.querySelector('option[value="22"]').textContent.includes('(1)'))
  disconnecting = true; Bot.server.closeAllConnections()
  Bot.emit('message', incoming('11', 'group', 'reconnected', '断线期间的新消息'))
  await panel.bridge.tasks
  await page.locator('#msgPan').getByText('断线期间的新消息', { exact: true }).waitFor()
  await page.getByLabel('消息输入框').fill('')
  disconnecting = false
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: path.join(output, 'mobile-chat.png') })
  const bounds = await page.evaluate(() => {
    const chat = document.querySelector('#msgPan').getBoundingClientRect(), composer = document.querySelector('.more').getBoundingClientRect()
    return { width: document.documentElement.scrollWidth, viewport: innerWidth, chatBottom: chat.bottom, composerTop: composer.top, composerBottom: composer.bottom, height: innerHeight, images: [...document.images].filter(i => i.offsetParent && (!i.complete || !i.naturalWidth)).map(i => i.src) }
  })
  assert.ok(bounds.width <= bounds.viewport, JSON.stringify(bounds)); assert.ok(bounds.chatBottom <= bounds.composerTop + 1, JSON.stringify(bounds)); assert.ok(bounds.composerBottom <= bounds.height + 1, JSON.stringify(bounds)); assert.deepEqual(bounds.images, [])
  await page.getByLabel('返回会话列表').click()
  await page.screenshot({ path: path.join(output, 'mobile-list.png') })
  const listBounds = await page.locator('.friend-body').evaluateAll(rows => rows.map(row => {
    const title = row.querySelector('p').getBoundingClientRect(), preview = row.querySelector('a:not(.time)').getBoundingClientRect(), time = row.querySelector('.time').getBoundingClientRect()
    return { titleBottom: title.bottom, previewTop: preview.top, titleLeft: title.left, previewLeft: preview.left, titleRight: title.right, timeLeft: time.left }
  }))
  for (const row of listBounds) { assert.ok(row.titleBottom <= row.previewTop + 1, JSON.stringify(row)); assert.ok(Math.abs(row.titleLeft - row.previewLeft) <= 1, JSON.stringify(row)); assert.ok(row.titleRight <= row.timeLeft, JSON.stringify(row)) }
  await page.getByLabel('切换主题').click()
  await page.getByRole('button', { name: /日常交流群/ }).click()
  await page.screenshot({ path: path.join(output, 'mobile-dark.png') })
  await page.getByLabel('返回会话列表').click()
  await page.getByLabel('切换主题').click()
  await page.getByLabel('选择机器人').selectOption('official')
  await page.getByRole('button', { name: /测试群/ }).click()
  await page.getByLabel('消息输入框').fill('官机发送测试')
  await page.getByLabel('发送消息', { exact: true }).click()
  await page.getByText('已发送', { exact: true }).waitFor()
  assert.equal(fixture.calls.at(-1).self_id, 'official')
  assert.equal(fixture.calls.at(-1).group_id, 'official:group_openid')
  await checkFeatures({ page, context, panel, bot: Bot, fixture, output })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ screenshots: output, calls: fixture.calls.length, viewportChecks: bounds, errors }))
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0]
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
    console.error(await page.locator('[role=menu]').evaluateAll(items => items.map(item => ({ box: item.getBoundingClientRect().toJSON(), style: item.getAttribute('style'), parent: item.parentElement.getBoundingClientRect().toJSON() }))).catch(() => []))
  }
  throw error
} finally {
  await browser?.close(); await panel?.close(); Bot.server.close(); Bot.server.closeAllConnections()
  assert.equal(Bot.server.listening, false)
  await fs.rm(directory, { recursive: true, force: true })
}
process.exit(0)
