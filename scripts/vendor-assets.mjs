import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { root } from '../lib/config.js'
const cache = path.resolve('temp/bot-web-vendor')
for (const [name, expected] of [['bcui', 'afc93141ba2fc67a25f60045d89ac707b773fe99'], ['qface', '8fac1fa62c16e91e3221b439ad3f9f2f5c4b1f1d']]) {
  const revision = execFileSync('git', ['-C', path.join(cache, name), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (revision !== expected) throw new Error(`Unexpected ${name} revision: ${revision}`)
}
await fs.cp(path.join(cache, 'bcui/css'), path.join(root, 'web/public/bcui/css'), { recursive: true })
await fs.copyFile(path.join(cache, 'bcui/LICENSE'), path.join(root, 'web/public/bcui/LICENSE'))
await fs.mkdir(path.join(root, 'web/public/qface'), { recursive: true })
await fs.copyFile(path.join(cache, 'qface/LICENSE'), path.join(root, 'web/public/qface/LICENSE'))
await fs.mkdir(path.join(root, 'web/src/assets/img/icons'), { recursive: true })
for (const file of ['exit.png', 'pen.png']) await fs.copyFile(path.join(root, 'web/public/img/icons', file), path.join(root, 'web/src/assets/img/icons', file))
const source = path.join(cache, 'qface/public')
const index = JSON.parse(await fs.readFile(path.join(source, 'assets/qq_emoji/_index.json'), 'utf8'))
const emoji = []
for (const item of index) {
  const asset = item.assets?.find(x => x.type === 0 && /\.png$/.test(x.path))
  if (!asset || !/^\d+$/.test(item.emojiId)) continue
  const name = `${item.emojiId}.png`
  await fs.copyFile(path.join(source, asset.path), path.join(root, 'web/public/qface', name))
  emoji.push({ id: item.emojiId, name: item.describe.replace(/^\//, ''), url: `/bot-web/qface/${name}` })
}
await fs.writeFile(path.join(root, 'web/src/emoji.json'), JSON.stringify(emoji))
console.log(`Vendored ${emoji.length} QFace PNG assets and original BCUI styles`)
