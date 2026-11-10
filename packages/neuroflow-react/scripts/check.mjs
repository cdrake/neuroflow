// Pre-publish check: node packages/neuroflow-react/scripts/check.mjs (after lib:build).
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = fileURLToPath(new URL('..', import.meta.url))
const dist = join(pkg, 'dist')
const fail = (msg) => { console.error(`lib:check FAILED: ${msg}`); process.exit(1) }

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])

if (!existsSync(dist)) fail('dist/ is missing (run npm run lib:build)')
for (const f of ['index.js', 'lib.d.ts', 'style.css']) {
  if (!existsSync(join(dist, f))) fail(`dist/${f} is missing`)
}
const files = walk(dist)
for (const f of files) {
  if (/(^|\/)(host|execution|gallery)\.d\.ts$/.test(f)) fail(`leaked declaration ${f}`)
  if (/@tauri-apps|gallery\/tools|\.tool\.json/.test(readFileSync(f, 'utf8'))) fail(`${f} references Tauri or the gallery`)
}

const tmp = mkdtempSync(join(tmpdir(), 'nf-check-'))
let failure = null
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })
try {
  const out = execFileSync('npm', ['pack', '--pack-destination', tmp, '--json'], { cwd: pkg }).toString()
  const tgz = join(tmp, JSON.parse(out)[0].filename)
  const consumer = join(tmp, 'consumer')
  cpSync(join(pkg, 'test/consumer'), consumer, { recursive: true, filter: (s) => !s.includes('node_modules') })
  run('npm', ['install', '--no-audit', '--no-fund', tgz], consumer)
  run('npx', ['tsc', '--noEmit'], consumer)
  run('npx', ['vite', 'build'], consumer)
} catch (e) {
  failure = e.message
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
if (failure) fail(failure)
console.log('lib:check OK')
