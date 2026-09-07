import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPublicIpLookup, panelAddresses } from '../lib/login-addresses.js'

const listener = (address = '::', port = 7777) => ({ server: { address: () => ({ address, port }) } })
const interfaces = { ethernet: [
  { address: '192.168.1.5', internal: false }, { address: '10.0.0.2', internal: false },
  { address: '192.168.1.5', internal: false }, { address: '127.0.0.1', internal: true },
  { address: '240e:1234::1', internal: false }, { address: 'fd12:3456::1', internal: false },
  { address: 'fe80::1', internal: false }, { address: 'fe80::1%eth0', internal: false },
  { address: 'ff02::1', internal: false }, { address: '::1', internal: true }
] }

test('custom, LAN, external IPv4 and IPv6 links coexist and are deduplicated', async () => {
  const groups = await panelAddresses(listener(), { publicUrl: ['https://panel.example.com/bot-web/', 'https://other.example.com:8443'], allowedOrigins: ['https://panel.example.com'] }, {
    interfaces, publicIps: async families => { assert.deepEqual(families, [4, 6]); return ['8.8.8.8', '240e:1234::1', '240e:1234::2'] }
  })
  assert.deepEqual(groups, {
    custom: ['https://panel.example.com/bot-web/', 'https://other.example.com:8443/bot-web/'],
    local: ['http://localhost:7777/bot-web/', 'http://192.168.1.5:7777/bot-web/', 'http://10.0.0.2:7777/bot-web/'],
    remote: ['http://8.8.8.8:7777/bot-web/'],
    ipv6: ['http://[240e:1234::1]:7777/bot-web/', 'http://[fd12:3456::1]:7777/bot-web/', 'http://[240e:1234::2]:7777/bot-web/']
  })
})

test('IPv4 and loopback listeners do not advertise unbound IPv6 or LAN interfaces', async () => {
  const groups = await panelAddresses(listener('0.0.0.0'), {}, { interfaces, publicIps: async families => { assert.deepEqual(families, [4]); return ['8.8.8.8', '240e:1234::1'] } })
  assert.deepEqual(groups.ipv6, [])
  assert.deepEqual(groups.remote, ['http://8.8.8.8:7777/bot-web/'])
  const local = await panelAddresses(listener('::1', 8888), {}, { interfaces, publicIps: async () => assert.fail('No public lookup for loopback') })
  assert.deepEqual(local, { custom: [], local: ['http://[::1]:8888/bot-web/'], remote: [], ipv6: [] })
})

test('custom and interface links survive public discovery failures and a missing listener', async () => {
  const groups = await panelAddresses(listener(), { publicUrl: 'https://panel.example.com' }, { interfaces, publicIps: async () => { throw new Error('Offline') } })
  assert.equal(groups.custom.length, 1); assert.equal(groups.local.length, 3); assert.equal(groups.ipv6.length, 2)
  assert.deepEqual(groups.remote, [])
  assert.deepEqual(await panelAddresses({}, { publicUrl: 'https://panel.example.com' }), { custom: ['https://panel.example.com/bot-web/'], local: [], remote: [], ipv6: [] })
})

test('public IP queries fall back, share pending requests, cache success and expire', async () => {
  let now = 0
  const calls = []
  const lookup = createPublicIpLookup({ now: () => now, fetcher: async (url, options) => {
    calls.push(url); assert.ok(options.signal instanceof AbortSignal)
    if (url.includes('zxinc') || url.includes('api6.')) throw new Error('Provider unavailable')
    return url.includes('api.ipify') ? Response.json({ ip: '8.8.8.8' }) : new Response('240e:1234::1\n')
  } })
  const results = await Promise.all([lookup(), lookup()])
  for (const result of results) assert.deepEqual(result, ['8.8.8.8', '240e:1234::1'])
  assert.equal(calls.length, 4)
  await lookup(); assert.equal(calls.length, 4)
  now += 600001
  await lookup([4]); assert.equal(calls.length, 6)
})

test('IP discovery rejects invalid/private/family-mismatched responses and caches failure briefly', async () => {
  let now = 0, calls = 0
  const lookup = createPublicIpLookup({ now: () => now, fetcher: async url => {
    calls++
    if (url.includes('zxinc')) return Response.json({ code: 0, data: { myip: '192.168.1.1' } })
    if (url.includes('api6.')) return Response.json({ ip: '8.8.8.8' })
    if (url.includes('api.ipify')) return Response.json({ ip: '192.168.1.1' })
    return new Response('<html>unavailable</html>')
  } })
  assert.deepEqual(await lookup(), []); assert.equal(calls, 4)
  await lookup(); assert.equal(calls, 4)
  now += 60001
  await lookup(); assert.equal(calls, 8)
})

test('Guoba public IPv4 response is decoded and avoids a redundant fallback', async () => {
  let calls = 0
  const lookup = createPublicIpLookup({ fetcher: async url => {
    calls++; assert.equal(new URL(url).hostname, 'v4.ip.zxinc.org')
    return Response.json({ code: 0, data: { myip: '8.8.4.4' } })
  } })
  assert.deepEqual(await lookup([4]), ['8.8.4.4']); assert.equal(calls, 1)
})
