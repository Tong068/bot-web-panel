import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = path.join(root, 'tests/output')
const base = process.env.BOT_WEB_URL || 'http://localhost:2536'
const sample = process.argv[2]
const browser = await chromium.launch({ executablePath: path.resolve(root, '../../browsers/chromium-1234/chrome-win64/chrome.exe'), headless: true })
const sizes = { landscape: [1604, 720], wide: [2400, 600], portrait: [720, 1604], tall: [400, 2400], square: [1024, 1024], small: [80, 45] }
const errors = [], measurements = []
try {
  await fs.mkdir(output, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  const images = await page.evaluate(sizes => Object.fromEntries(Object.entries(sizes).map(([name, [width, height]]) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#80a5a0'; ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = '#e5cb78'; ctx.fillRect(width / 4, height / 4, width / 2, height / 2)
    return [name, canvas.toDataURL('image/png').split(',')[1]]
  })), sizes)
  const contact = { key: 'layout-group', bot_id: '11', kind: 'group', target_id: '100', name: '图片测试群', unread: 0, last: { time: Date.now() / 1000, preview: '[图片]' } }
  const messages = Object.keys(sizes).flatMap(name => ['in', 'out'].map(direction => ({
    id: `layout-${direction}-${name}`, seq: 0, bot_id: '11', kind: 'group', target_id: '100', conversation: contact.key,
    time: Date.now() / 1000, direction, status: 'sent', origin: direction === 'in' ? 'received' : 'panel',
    sender: { user_id: direction === 'in' ? '200' : '11', nickname: direction === 'in' ? '测试成员' : '测试机器人' },
    message: [{ type: 'image', url: `${base}/bot-web/api/media/layout-${name}`, name }], preview: '[图片]'
  })))
  messages.push({ ...messages[0], id: 'layout-mixed', quote: { id: 'source', text: '这是一条包含横图的引用回复。', user_id: '200' }, message: [{ type: 'text', text: '图片前的说明。' }, ...messages[0].message, { type: 'text', text: '图片后的说明应该紧接图片，并按气泡宽度换行。' }] })
  messages.forEach((message, index) => { message.seq = index + 1 })
  // Static assets come from the running framework; no real account APIs are used.
  await page.route('**/bot-web/api/**', async route => {
    const endpoint = new URL(route.request().url()).pathname.split('/').at(-1)
    if (endpoint.startsWith('layout-')) {
      const name = endpoint.slice(7)
      if (sample && name === 'landscape') return route.fulfill({ path: sample, contentType: 'image/jpeg' })
      return route.fulfill({ body: Buffer.from(images[name], 'base64'), contentType: 'image/png' })
    }
    if (endpoint === 'session') return route.fulfill({ json: { csrf: 'fixture' } })
    if (endpoint === 'settings') return route.fulfill({ json: { uploadMaxMB: 20, retentionDays: 7, mediaCacheMB: 512 } })
    if (endpoint === 'bots') return route.fulfill({ json: [{ id: '11', name: '测试机器人', online: true, unread: 0 }] })
    if (endpoint === 'events') return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' })
    if (endpoint === 'action') {
      const { action } = route.request().postDataJSON()
      const data = action === 'get_contacts' ? [contact] : action === 'get_history' ? messages : action === 'mark_read' ? true : action === 'get_capabilities' ? { text: true, image: true } : undefined
      if (data !== undefined) return route.fulfill({ json: { data } })
    }
    errors.push(`Unexpected API: ${endpoint}`); return route.abort()
  })
  await page.goto(`${base}/bot-web/`)
  await page.getByRole('button', { name: /图片测试群/ }).click()
  for (const viewport of [{ width: 1440, height: 960 }, { width: 800, height: 960 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport)
    for (const message of messages) {
      const img = page.locator(`#chat-${message.id} .msg-img`)
      await img.scrollIntoViewIfNeeded()
      const bounds = await img.evaluate(async img => {
        await img.decode()
        const rect = img.getBoundingClientRect(), bubble = img.parentElement.getBoundingClientRect(), row = img.closest('.message').getBoundingClientRect()
        const style = getComputedStyle(img.parentElement)
        return { width: rect.width, height: rect.height, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, bubbleWidth: bubble.width, bubbleHeight: bubble.height, paddingX: parseFloat(style.paddingLeft) + parseFloat(style.paddingRight), inside: rect.left >= bubble.left && rect.right <= bubble.right + 1 && bubble.left >= row.left && bubble.right <= row.right + 1 }
      })
      measurements.push({ viewport: viewport.width, id: message.id, ...bounds })
    }
    await page.locator('#chat-layout-in-landscape').scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(output, `image-layout-${viewport.width}.png`) })
    for (const shape of ['landscape', 'portrait']) {
      await page.locator(`#chat-layout-in-${shape} .msg-img`).click()
      const viewer = page.getByRole('dialog', { name: '图片预览' })
      await viewer.waitFor()
      const centered = async () => viewer.evaluate(async el => {
        const img = el.querySelector('.viewer-img'); await img.decode()
        const picture = img.getBoundingClientRect(), bar = el.querySelector('.viewer-tool-bar').getBoundingClientRect()
        return { x: picture.x + picture.width / 2 - innerWidth / 2, y: picture.y + picture.height / 2 - innerHeight / 2, barX: bar.x + bar.width / 2 - innerWidth / 2, barInside: bar.left >= 0 && bar.right <= innerWidth, top: picture.top, barBottom: bar.bottom, maxX: Math.max(0, (picture.width - innerWidth) / 2), maxY: Math.max(0, (picture.height - innerHeight + 144) / 2) }
      })
      const dragImage = async (x, y) => {
        await page.mouse.move(viewport.width / 2, viewport.height / 2)
        await page.mouse.down()
        assert.equal(await viewer.locator('.viewer-img').evaluate(img => getComputedStyle(img).cursor), 'grabbing')
        await page.mouse.move(x, y, { steps: 5 })
        await page.mouse.up()
        assert.equal(await viewer.count(), 1, 'Releasing a drag must not close the viewer')
        assert.equal(await viewer.locator('.dragging').count(), 0)
        return centered()
      }
      const position = await centered()
      await page.screenshot({ path: path.join(output, `image-viewer-${shape}-${viewport.width}.png`) })
      assert.ok(Math.abs(position.x) < 1 && Math.abs(position.y) < 1 && Math.abs(position.barX) < 1 && position.barInside && position.top >= position.barBottom, JSON.stringify({ viewport, shape, position }))
      await page.getByLabel('放大', { exact: true }).click()
      const zoomed = await centered()
      assert.ok(Math.abs(zoomed.x) < 1 && Math.abs(zoomed.y) < 1, JSON.stringify(zoomed))
      for (let i = 0; i < 4; i++) await page.getByLabel('放大', { exact: true }).click()
      const panned = await dragImage(viewport.width / 2 + 80, viewport.height / 2 + 60)
      assert.ok(Math.abs(panned.x) > 5 || Math.abs(panned.y) > 5, 'Zoomed image must move with the mouse')
      assert.ok(Math.abs(panned.x) <= 81 && Math.abs(panned.y) <= 61, 'Pan distance must not be multiplied by zoom')
      await page.mouse.move(5, viewport.height - 5)
      assert.deepEqual(await centered(), panned, 'Image must stop following the mouse after release')
      await page.screenshot({ path: path.join(output, `image-viewer-panned-${shape}-${viewport.width}.png`) })
      const bounded = await dragImage(viewport.width - 5, viewport.height - 5)
      assert.ok(Math.abs(bounded.x) <= bounded.maxX + 2 && Math.abs(bounded.y) <= bounded.maxY + 2, JSON.stringify(bounded))
      for (let i = 0; i < 5; i++) await page.getByLabel('缩小', { exact: true }).click()
      const shrunk = await centered()
      assert.ok(Math.abs(shrunk.x) < 1 && Math.abs(shrunk.y) < 1, 'Returning to the fitted size must recenter the image')
      assert.equal(await viewer.locator('.zoomed').count(), 0)
      await viewer.locator('.viewer-img').dblclick()
      await dragImage(viewport.width / 2 + 80, viewport.height / 2 + 60)
      await page.getByLabel('还原尺寸').click()
      const reset = await centered()
      assert.ok(Math.abs(reset.x) < 1 && Math.abs(reset.y) < 1, 'Reset must clear pan and zoom')
      await viewer.locator('.viewer-img').dblclick()
      await dragImage(viewport.width / 2 + 80, viewport.height / 2 + 60)
      await page.getByLabel('下一张').click()
      const switched = await centered()
      assert.ok(Math.abs(switched.x) < 1 && Math.abs(switched.y) < 1, JSON.stringify(switched))
      await page.getByLabel('关闭预览').click()
    }
  }
  await page.locator('#chat-layout-in-landscape .msg-img').click()
  const viewer = page.getByRole('dialog', { name: '图片预览' })
  await viewer.waitFor()
  assert.equal(await viewer.locator('img').getAttribute('src'), messages[0].message[0].url)
  await page.getByLabel('关闭预览').click()
  assert.equal(await viewer.count(), 0)
  const invalid = measurements.filter(item => !item.inside || Math.abs(item.width / item.height - item.naturalWidth / item.naturalHeight) > .01 || item.width > 321 || item.height > 321 || item.id !== 'layout-mixed' && Math.abs(item.bubbleWidth - item.width - item.paddingX) > 1)
  console.log(JSON.stringify({ sample: measurements[0], checks: measurements.length, dragViewports: [1440, 800, 390, 320], dragAndReset: 'passed', invalid }, null, 2))
  assert.deepEqual(errors, [])
  assert.equal(invalid.length, 0, 'Images must retain their aspect ratio and fit their message bubbles without excess width')
} finally { await browser.close() }
