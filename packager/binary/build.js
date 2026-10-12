#!/usr/bin/env bun
/**
 * prodman: build the standalone pm2 binary with bun.
 *
 *   bun packager/binary/build.js            # this machine's platform
 *   bun packager/binary/build.js --all      # every release platform
 *   bun packager/binary/build.js linux-x64 linux-arm64
 *
 * Steps: npm pack the package (the files an npm install gets), install its production
 * dependencies from package-lock.json, pack the tree into runtime.pak, then compile entry.js,
 * which embeds runtime.pak, for each platform. Output: dist/binary/pm2-<platform>[.exe] and
 * SHA256SUMS.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '../..')
const OUT = path.join(ROOT, 'dist/binary')
const STAGE = path.join(OUT, 'stage')
const MAGIC = 'PM2PAK1\n'

// release platform -> bun target. x64 uses the baseline builds: they run on CPUs without AVX2.
const TARGETS = {
  'linux-x64': 'bun-linux-x64-baseline',
  'linux-arm64': 'bun-linux-arm64',
  'linux-x64-musl': 'bun-linux-x64-musl-baseline',
  'linux-arm64-musl': 'bun-linux-arm64-musl',
  'darwin-x64': 'bun-darwin-x64-baseline',
  'darwin-arm64': 'bun-darwin-arm64',
  'windows-x64': 'bun-windows-x64-baseline'
}

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd: cwd || ROOT, stdio: ['ignore', 'inherit', 'inherit'] })
const bun = process.env.BUN || (process.versions.bun ? process.execPath : 'bun')

function hostPlatform () {
  const os = process.platform === 'win32' ? 'windows' : process.platform
  let musl = false
  if (process.platform === 'linux') {
    try { musl = !process.report.getReport().header.glibcVersionRuntime } catch (e) {}
  }
  return `${os}-${process.arch}${musl ? '-musl' : ''}`
}

function platforms () {
  const args = process.argv.slice(2)
  if (args.includes('--all')) return Object.keys(TARGETS)
  const list = args.filter(a => !a.startsWith('-'))
  const chosen = list.length ? list : [hostPlatform()]
  for (const p of chosen) if (!TARGETS[p]) throw new Error(`unknown platform ${p} (one of ${Object.keys(TARGETS).join(', ')})`)
  return chosen
}

/** the package as npm installs it: the packed files plus production dependencies */
function stage () {
  fs.rmSync(STAGE, { recursive: true, force: true })
  fs.mkdirSync(STAGE, { recursive: true })
  const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', STAGE], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop()
  run('tar', ['-xzf', tarball], STAGE)
  const pkgDir = path.join(STAGE, 'package')
  // package-lock.json is not committed: use it when there is one
  const lock = path.join(ROOT, 'package-lock.json')
  if (fs.existsSync(lock)) fs.copyFileSync(lock, path.join(pkgDir, 'package-lock.json'))
  run('npm', [fs.existsSync(lock) ? 'ci' : 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], pkgDir)
  fs.rmSync(path.join(pkgDir, 'package-lock.json'), { force: true })
  fs.rmSync(path.join(pkgDir, 'node_modules/.package-lock.json'), { force: true })
  return pkgDir
}

function walk (dir, base, out) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name)
    const rel = base ? `${base}/${name}` : name
    const st = fs.lstatSync(full)
    if (st.isDirectory()) walk(full, rel, out)
    else if (st.isFile()) out.push({ rel, full, mode: st.mode & 0o777 })
    // symlinks (node_modules/.bin) are not needed by pm2
  }
  return out
}

/** runtime.pak: gzip of MAGIC then [u32 name length][name][u32 mode][u32 size][bytes] per file */
function pack (pkgDir) {
  const parts = [Buffer.from(MAGIC)]
  const files = walk(pkgDir, '', [])
  for (const f of files) {
    const name = Buffer.from(f.rel)
    const data = fs.readFileSync(f.full)
    const head = Buffer.alloc(4)
    head.writeUInt32LE(name.length)
    const meta = Buffer.alloc(8)
    meta.writeUInt32LE(f.mode, 0)
    meta.writeUInt32LE(data.length, 4)
    parts.push(head, name, meta, data)
  }
  const raw = Buffer.concat(parts)
  return { gz: zlib.gzipSync(raw, { level: 9 }), files: files.length, size: raw.length }
}

function gitCommit () {
  try { return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim() } catch (e) { return null }
}

function main () {
  const targets = platforms()
  const version = require(path.join(ROOT, 'package.json')).version
  console.log(`pm2 ${version}: staging the package`)
  const pkgDir = stage()
  const { gz, files, size } = pack(pkgDir)
  const hash = crypto.createHash('sha256').update(gz).digest('hex').slice(0, 12)
  console.log(`runtime.pak: ${files} files, ${(size / 1e6).toFixed(1)} MB, ${(gz.length / 1e6).toFixed(1)} MB packed, hash ${hash}`)
  fs.writeFileSync(path.join(__dirname, 'runtime.pak'), gz)
  fs.writeFileSync(path.join(__dirname, 'build-info.json'), JSON.stringify({ version, hash, commit: gitCommit(), built: new Date().toISOString() }))

  const sums = []
  for (const p of targets) {
    const file = path.join(OUT, `pm2-${p}${p.startsWith('windows') ? '.exe' : ''}`)
    console.log(`compiling ${path.basename(file)} (${TARGETS[p]})`)
    run(bun, ['build', '--compile', '--compile-autoload-package-json', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', `--target=${TARGETS[p]}`, path.join(__dirname, 'entry.js'), '--outfile', file])
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    sums.push(`${sha}  ${path.basename(file)}`)
  }
  fs.writeFileSync(path.join(OUT, 'SHA256SUMS'), sums.join('\n') + '\n')
  fs.rmSync(STAGE, { recursive: true, force: true })
  console.log(`done: ${OUT}`)
}

main()
