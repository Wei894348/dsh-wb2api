// 按「npm 包产物」逐文件覆盖现场插件目录（等价于覆盖式重装，保留运行时 data/）。
// 用法: node tools/_reinstall_plugin_local.mjs [解包目录]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const SRC = (process.argv[2] || 'F:/project/dsh_chajian/dsh-wb2api/.pack155/package').replace(/\\/g, '/')
const PROFILES = ['desktop', 'web', 'wbtest']
const PKG = 'dsh-plugin-wb2api-ui'

if (!fs.existsSync(SRC)) { console.error('源目录不存在: ' + SRC); process.exit(1) }

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

function walk(root) {
  const out = []
  const rec = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) rec(p)
      else out.push(path.relative(root, p).replace(/\\/g, '/'))
    }
  }
  rec(root)
  return out.sort()
}

const files = walk(SRC)
console.log(`源: ${SRC}  (${files.length} 个文件)\n`)

let ok = 0
for (const profile of PROFILES) {
  const dstRoot = path.join(os.homedir(), '.dsh', 'profiles', profile, 'node_modules', PKG)
  if (!fs.existsSync(dstRoot)) { console.log(`[${profile}] 目标不存在，跳过`); continue }
  let added = 0, updated = 0, same = 0
  const changed = []
  for (const rel of files) {
    const s = path.join(SRC, rel)
    const d = path.join(dstRoot, rel)
    if (!fs.existsSync(d)) { added++; changed.push('+ ' + rel) }
    else if (sha(s) !== sha(d)) { updated++; changed.push('~ ' + rel) }
    else { same++; continue }
    fs.mkdirSync(path.dirname(d), { recursive: true })
    fs.copyFileSync(s, d)
  }
  console.log(`[${profile}] 新增=${added} 更新=${updated} 未变=${same} / 共 ${files.length}`)
  changed.slice(0, 15).forEach((c) => console.log('    ' + c))
  if (changed.length > 15) console.log(`    ... 另 ${changed.length - 15} 个`)
  ok++
}
console.log(`\n完成：${ok} 个 profile 已同步到包产物`)
