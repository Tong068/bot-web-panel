import { networkInterfaces } from 'node:os'
import { isIP } from 'node:net'
import { base } from './config.js'
import { publicAddress } from './media.js'

const ipServices = {
  4: [
    { url: 'https://v4.ip.zxinc.org/info.php?type=json', read: async response => { const result = await response.json(); return result.code === 0 ? result.data?.myip : '' } },
    { url: 'https://api.ipify.org?format=json', read: async response => (await response.json()).ip }
  ],
  6: [
    { url: 'https://api6.ipify.org?format=json', read: async response => (await response.json()).ip },
    { url: 'https://6.ipw.cn', read: async response => (await response.text()).trim() }
  ]
}

export function createPublicIpLookup({ fetcher = globalThis.fetch, now = Date.now } = {}) {
  const cache = new Map(), pending = new Map()
  const lookup = async family => {
    if (cache.get(family)?.expires > now()) return cache.get(family).address
    if (pending.has(family)) return pending.get(family)
    const task = (async () => {
      let address = ''
      for (const service of ipServices[family]) {
        try {
          const response = await fetcher(service.url, { signal: AbortSignal.timeout(3000), redirect: 'error' })
          if (!response.ok) { await response.body?.cancel(); continue }
          const value = await service.read(response)
          if (isIP(value) === family && publicAddress(value)) { address = value; break }
        } catch { /* Try the next provider; address discovery must not block login. */ }
      }
      cache.set(family, { address, expires: now() + (address ? 600000 : 60000) })
      return address
    })().finally(() => pending.delete(family))
    pending.set(family, task)
    return task
  }
  return async (families = [4, 6]) => (await Promise.all(families.map(lookup))).filter(Boolean)
}

const lookupPublicIps = createPublicIpLookup()

export async function panelAddresses(bot, config, { interfaces, publicIps = lookupPublicIps } = {}) {
  const groups = { custom: new Set(), local: new Set(), remote: new Set(), ipv6: new Set() }
  const add = (group, value) => {
    try {
      const url = new URL(`${base}/`, value)
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) groups[group].add(url.href)
    } catch { /* Ignore unusable advertised addresses. */ }
  }
  for (const value of [config.publicUrl || [], config.allowedOrigins || []].flat()) add('custom', value)
  const address = bot.server?.address?.()
  if (address && typeof address === 'object') {
    const host = address.address, family = isIP(host)
    const wildcard = ['0.0.0.0', '::'].includes(host), loopback = host === '::1' || host.startsWith('127.')
    const addIp = ip => {
      const version = isIP(ip)
      if (version === 4) add(publicAddress(ip) ? 'remote' : 'local', `http://${ip}:${address.port}`)
      else if (version === 6 && !ip.includes('%') && !/^(?:fe[89ab]|ff)/i.test(ip) && ip !== '::') add('ipv6', `http://[${ip}]:${address.port}`)
    }
    if (wildcard) {
      add('local', `http://localhost:${address.port}`)
      try { interfaces ??= networkInterfaces() } catch { interfaces = {} }
      for (const entries of Object.values(interfaces)) for (const entry of entries || []) {
        if (!entry.internal && (host === '::' || isIP(entry.address) === 4)) addIp(entry.address)
      }
    } else if (loopback) add('local', `http://${family === 6 ? `[${host}]` : host}:${address.port}`)
    else addIp(host)
    if (!loopback) {
      const families = host === '::' ? [4, 6] : [family]
      try { for (const ip of await publicIps(families)) if (families.includes(isIP(ip)) && publicAddress(ip)) addIp(ip) }
      catch { /* Local and custom links remain available when discovery fails. */ }
    }
  }
  return Object.fromEntries(Object.entries(groups).map(([key, values]) => [key, [...values]]))
}
