import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// Reuse the running framework for static assets; every API request is intercepted.
const base = process.env.BOT_WEB_URL || 'http://localhost:2536'
const output = path.resolve('plugins/bot-web-panel/tests/output')
await fs.mkdir(output, { recursive: true })
const browser = await chromium.launch({ executablePath: path.resolve('browsers/chromium-1234/chrome-win64/chrome.exe'), headless: true })
const errors = [], checks = [], calls = []
const bots = ['11', '22'].map(id => ({ id, name: `测试机器人 ${id}`, online: true, adapter: 'OneBotv11', unread: 0, avatar: '/bot-web/img/icons/AppIcon.png' }))
const members = id => Array.from({ length: 140 }, (_, index) => ({ user_id: `${id}:member_${index}`, nickname: `测试成员 ${index}` }))
let memberHandler = async id => members(id), memberCapability = true, atCapability = true, memberRequests = 0, abortedRequests = 0
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
const page = await context.newPage()
page.setDefaultTimeout(8000)
page.on('pageerror', error => errors.push(error.message))
page.on('requestfailed', request => { if (request.postData()?.includes('get_group_member_list')) abortedRequests++ })
await page.route('**/bot-web/api/**', async route => {
  const url = new URL(route.request().url()), endpoint = url.pathname.split('/').at(-1)
  const json = body => route.fulfill({ json: body }).catch(() => {})
  if (endpoint === 'session') return json({ username: 'admin', csrf: 'test-only' })
  if (endpoint === 'settings') return json({ retentionDays: 7, uploadMaxMB: 20, mediaCacheMB: 512 })
  if (endpoint === 'bots') return json(bots)
  if (endpoint === 'events') return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' })
  if (endpoint !== 'action') { errors.push(`Unexpected API: ${endpoint}`); return route.abort() }
  const { bot_id, action, params } = route.request().postDataJSON()
  let data
  if (action === 'get_contacts') data = [{ key: `${bot_id}:group:100`, bot_id, kind: 'group', target_id: '100', name: '面板测试群', unread: 0, avatar: '/bot-web/qface/14.png', last: { time: Date.now() / 1000, preview: '测试消息' } }]
  else if (action === 'get_capabilities') data = { text: true, image: true, at: atCapability, quote: true, file: true, recall: true, members: memberCapability }
  else if (action === 'get_history') data = []
  else if (action === 'mark_read') data = true
  else if (action === 'get_group_member_list') {
    memberRequests++
    try { data = await memberHandler(bot_id) } catch { return route.fulfill({ status: 502, json: { error: '成员查询失败' } }).catch(() => {}) }
  } else if (action.startsWith('send_')) {
    calls.push({ bot_id, ...params })
    data = { id: params.request_id, seq: calls.length, bot_id, kind: 'group', target_id: params.target_id, conversation: `${bot_id}:group:100`, direction: 'out', sender: { user_id: bot_id, nickname: '测试机器人' }, time: Date.now() / 1000, status: 'sent', message: params.message, preview: '测试消息' }
  } else { errors.push(`Unexpected action: ${action}`); return route.abort() }
  return json({ data })
})
async function checkMemberHover(theme) {
  const popup = page.getByRole('dialog', { name: '@成员', exact: true }), rows = popup.locator('.member-options button')
  const colors = () => popup.evaluate(el => ({ panel: getComputedStyle(el).backgroundColor, list: getComputedStyle(el.querySelector('.member-options')).backgroundColor, rows: [...el.querySelectorAll('.member-options button')].slice(0, 3).map(row => getComputedStyle(row).backgroundColor) }))
  await popup.locator('.picker-heading').hover()
  const idle = await colors()
  await rows.nth(0).hover()
  await page.screenshot({ path: path.join(output, `composer-members-hover-${theme}.png`) })
  const first = await colors()
  assert.equal(first.panel, idle.panel, 'Hover must not recolor the panel')
  assert.equal(first.list, idle.list, 'Hover must not recolor the member list')
  assert.notEqual(first.rows[0], idle.rows[0], 'Hovered member must be highlighted')
  assert.deepEqual(first.rows.slice(1), idle.rows.slice(1), 'Other members must retain their backgrounds')
  await rows.nth(1).hover()
  const second = await colors()
  assert.equal(second.list, idle.list)
  assert.equal(second.rows[0], idle.rows[0])
  assert.notEqual(second.rows[1], idle.rows[1])
  assert.equal(second.rows[2], idle.rows[2])
  await popup.locator('.picker-heading').hover()
  assert.deepEqual(await colors(), idle, 'Leaving the member list must clear the hover highlight')
}
try {
  await page.goto(`${base}/bot-web/`)
  await page.getByRole('button', { name: /面板测试群/ }).click()
  await page.waitForFunction(() => !document.querySelector('#main-input-ex').disabled)
  for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 390, height: 360 }]) {
    await page.setViewportSize(viewport)
    for (const [name, selector] of [['表情', '.face-pan'], ['@成员', '.member-picker']]) {
      await page.getByRole('button', { name, exact: true }).click()
      if (name === '@成员') await page.locator('.member-options button').first().waitFor()
      else await page.waitForFunction(() => [...document.querySelectorAll('.face-grid img')].slice(0, 8).every(img => img.complete && img.naturalWidth > 0))
      if (name === '@成员' && viewport.width === 1440) await checkMemberHover('light')
      await page.screenshot({ path: path.join(output, `composer-${name === '表情' ? 'faces' : 'members'}-${viewport.width}-${viewport.height}.png`) })
      const layout = await page.locator(selector).evaluate(el => {
        const box = (el.closest('.composer-popover') || el).getBoundingClientRect(), toolbar = document.querySelector('.more-detail').getBoundingClientRect(), list = el.querySelector('.member-options, .face-grid')
        const rows = [...el.querySelectorAll('.member-options button')].slice(0, 3).map(row => row.getBoundingClientRect().toJSON())
        return { box: box.toJSON(), gap: toolbar.top - box.bottom, overflow: el.scrollWidth > el.clientWidth, listOverflow: list.scrollWidth > list.clientWidth, rows }
      })
      checks.push({ name, viewport, ...layout })
      await page.keyboard.press('Escape')
    }
  }
  for (const check of checks) {
    assert.ok(check.box.x >= 8 && check.box.y >= 8 && check.box.right <= check.viewport.width - 8 && check.box.bottom < check.viewport.height, JSON.stringify(check))
    assert.ok(check.gap >= 0 && check.gap <= 16, JSON.stringify(check))
    assert.equal(check.overflow || check.listOverflow, false, JSON.stringify(check))
    for (let index = 1; index < check.rows.length; index++) assert.ok(check.rows[index].top >= check.rows[index - 1].bottom, JSON.stringify(check))
  }
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.getByRole('button', { name: '表情', exact: true }).click()
  await page.getByLabel('搜索表情').fill('微笑')
  await page.getByLabel('搜索表情').press('ArrowDown'); await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.activeElement === document.querySelector('#main-input-ex'))
  assert.equal(await page.getByRole('dialog', { name: '表情', exact: true }).count(), 0)
  assert.equal(await page.locator('.mention-chip img').count(), 1)
  await page.getByRole('button', { name: '表情', exact: true }).click()
  await page.getByLabel('搜索表情').fill('无此表情检索')
  await page.getByText('没有匹配的表情', { exact: true }).waitFor()
  await page.getByLabel('消息输入框').click()
  assert.equal(await page.getByRole('dialog').count(), 0)
  await page.getByRole('button', { name: '表情', exact: true }).click()
  await page.keyboard.press('Escape')
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '表情')
  await page.getByRole('button', { name: '@成员', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.member-options button').length === 140)
  await page.getByLabel('成员名称或 ID').fill('成员 139')
  await page.getByLabel('成员名称或 ID').press('ArrowDown'); await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.activeElement === document.querySelector('#main-input-ex'))
  const mention = page.locator('.mention-chip').filter({ hasText: '@测试成员 139' })
  assert.equal(await mention.count(), 1)
  await page.getByRole('button', { name: '@成员', exact: true }).click()
  await page.getByLabel('成员名称或 ID').fill('成员 139')
  await page.getByRole('button', { name: /测试成员 139.*11:member_139/ }).click()
  assert.equal(await mention.count(), 1)
  await page.getByLabel('消息输入框').fill('面板选择测试')
  await page.getByLabel('发送消息', { exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.send-button').disabled)
  assert.equal(calls.length, 1); assert.equal(calls[0].bot_id, '11')
  assert.ok(calls[0].message.some(part => part.type === 'face' && part.id === '14'))
  assert.ok(calls[0].message.some(part => part.type === 'at' && part.qq === '11:member_139'))

  const started = Promise.withResolvers(), release = Promise.withResolvers()
  memberHandler = () => { started.resolve(); return release.promise }
  await page.getByRole('button', { name: '@成员', exact: true }).click(); await started.promise
  await page.getByText('正在加载成员', { exact: true }).waitFor()
  assert.equal(await page.locator('.member-options button').count(), 0)
  await page.getByRole('button', { name: '表情', exact: true }).click()
  await page.getByRole('dialog', { name: '表情', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  memberHandler = async id => members(id)
  await page.getByRole('button', { name: '@成员', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.member-options button').length === 140)
  release.resolve([{ user_id: 'outdated', nickname: '过期成员' }])
  await page.waitForTimeout(100)
  assert.equal(await page.getByText('过期成员', { exact: true }).count(), 0)
  assert.ok(abortedRequests >= 1)
  await page.keyboard.press('Escape')

  memberHandler = async () => { throw new Error('fixture failure') }
  await page.getByRole('button', { name: '@成员', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '成员查询失败' }).waitFor()
  memberHandler = async id => members(id)
  await page.getByLabel('重新加载成员').click()
  await page.waitForFunction(() => document.querySelectorAll('.member-options button').length === 140)
  await page.getByLabel('成员名称或 ID').fill('不存在的成员')
  await page.getByText('没有匹配的成员', { exact: true }).waitFor()
  assert.equal(await page.locator('.manual-member').count(), 0)
  await page.getByLabel('成员名称或 ID').fill('official:unknown_openid')
  await page.locator('.manual-member').click()
  assert.equal(await page.locator('.mention-chip').filter({ hasText: 'official:unknown_openid' }).count(), 1)

  const otherStarted = Promise.withResolvers(), otherRelease = Promise.withResolvers()
  memberHandler = () => { otherStarted.resolve(); return otherRelease.promise }
  await page.getByRole('button', { name: '@成员', exact: true }).click(); await otherStarted.promise
  await page.getByLabel('选择机器人').selectOption('22')
  otherRelease.resolve(members('11')); memberHandler = async id => members(id)
  await page.getByRole('button', { name: /面板测试群/ }).click()
  await page.waitForFunction(() => !document.querySelector('#main-input-ex').disabled)
  assert.equal(await page.locator('.mention-chip').count(), 0)
  await page.getByRole('button', { name: '@成员', exact: true }).click()
  await page.getByLabel('成员名称或 ID').fill('22:member_139')
  await page.getByRole('button', { name: /测试成员 139.*22:member_139/ }).click()
  await page.getByLabel('发送消息', { exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.send-button').disabled)
  assert.equal(calls.length, 2); assert.equal(calls[1].bot_id, '22')
  assert.equal(calls[1].message[0].qq, '22:member_139')

  await page.getByLabel('切换主题').click()
  for (const name of ['表情', '@成员']) {
    await page.getByRole('button', { name, exact: true }).click()
    if (name === '@成员') await page.locator('.member-options button').first().waitFor()
    if (name === '@成员') await checkMemberHover('dark')
    await page.screenshot({ path: path.join(output, `composer-${name === '表情' ? 'faces' : 'members'}-dark.png`) })
    await page.getByLabel('关闭' + name, { exact: true }).click()
  }
  memberCapability = false
  await page.reload(); await page.waitForFunction(() => !document.querySelector('#main-input-ex')?.disabled && document.querySelector('#main-input-ex'))
  const beforeRequests = memberRequests
  await page.getByRole('button', { name: '@成员', exact: true }).click()
  await page.getByText('此机器人不提供成员列表', { exact: true }).waitFor()
  assert.equal(memberRequests, beforeRequests)
  await page.getByLabel('成员名称或 ID').fill('official:manual_id')
  await page.locator('.manual-member').click()
  atCapability = false
  await page.reload(); await page.getByLabel('消息输入框').waitFor()
  assert.equal(await page.getByRole('button', { name: '@成员', exact: true }).isDisabled(), true)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ panels: checks.length, fixtureSends: calls.length, abortedRequests, errors, realMessagesSent: 0 }))
} catch (error) {
  await page.screenshot({ path: path.join(output, 'composer-failure.png') }).catch(() => {})
  throw error
} finally { await context.close(); await browser.close() }
