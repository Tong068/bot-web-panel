import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { root } from '../lib/config.js'
const source = process.argv[2]
if (!source) throw new Error('Pass the Stapxs source directory')
const revision = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
if (!revision.startsWith('7a895b9')) throw new Error('Expected Stapxs 7a895b9')
for (const [from, to] of [
  ['LICENSE', 'LICENSE'],
  ['src/renderer/src/assets/css', 'web/src/upstream/css'],
  ['src/renderer/src/assets/img', 'web/public/img'],
  ['src/renderer/public/css', 'web/public/css'],
  ['src/renderer/src/components/FriendBody.vue', 'web/upstream-source/components/FriendBody.vue'],
]) {
  const dest = path.join(root, to); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.cp(path.join(source, from), dest, { recursive: true })
}
for (const file of ['App.vue', 'pages/Messages.vue', 'pages/Friends.vue', 'pages/Chat.vue', 'pages/options/OptView.vue', 'pages/options/OptFunction.vue', 'components/MsgBody.vue', 'components/ViewerCom.vue', 'components/FacePan.vue']) {
  const dest = path.join(root, 'web/upstream-source', file); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.copyFile(path.join(source, 'src/renderer/src', file), dest)
}
console.log(`Vendored Stapxs ${revision}`)
