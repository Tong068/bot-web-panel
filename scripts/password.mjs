import path from 'node:path'
import fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { Database } from '../lib/database.js'
import { Auth } from '../lib/auth.js'
import { root, loadConfig } from '../lib/config.js'
const db = await new Database().open(path.join(root, 'data/panel.sqlite'))
try {
  const password = randomBytes(15).toString('base64url')
  await new Auth(db, await loadConfig()).setPassword(password)
  await fs.writeFile(path.join(root, 'data/initial-password.txt'), `admin\n${password}\n`, { mode: 0o600 })
  console.log(`admin / ${password}`)
} finally { await db.close() }
