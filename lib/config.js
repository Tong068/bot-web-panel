import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const base = '/bot-web'
export async function loadConfig() {
  const defaults = YAML.parse(await fs.readFile(path.join(root, 'config/default.yaml'), 'utf8'))
  const file = path.join(root, 'config/config.yaml')
  let user = {}
  try { user = YAML.parse(await fs.readFile(file, 'utf8')) || {} }
  catch (e) { if (e.code !== 'ENOENT') throw e; await fs.writeFile(file, YAML.stringify(defaults), { mode: 0o600 }) }
  const config = { ...defaults, ...user }
  for (const [key, min, max] of [['retentionDays', 1, 3650], ['uploadMaxMB', 1, 100], ['mediaCacheMB', 20, 102400], ['sessionHours', 1, 168]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid ${key}: ${min}-${max}`)
  }
  for (const key of ['allowedOrigins', 'mediaHosts']) if (!Array.isArray(config[key]) || config[key].some(x => typeof x !== 'string')) throw new Error(`Invalid ${key}`)
  return config
}
export function fail(status, message) { return Object.assign(new Error(message), { status }) }
