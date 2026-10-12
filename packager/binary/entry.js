/**
 * prodman: entry point of the standalone pm2 binary (built by build.js with `bun build --compile`).
 *
 * The binary carries a packed copy of the pm2 package with its production dependencies
 * (runtime.pak). On first run it unpacks it to $PM2_HOME/runtime/<version>-<hash>, then runs the
 * CLI from there on the embedded bun. The daemon, the agent and the apps run on node (PM2_NODE,
 * else node from the PATH) from the same unpacked files, so they behave exactly as with an npm
 * install, cluster mode included, while pm2 itself no longer lives inside a node installation.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import payloadFile from './runtime.pak' with { type: 'file' }
import build from './build-info.json'

const MAGIC = 'PM2PAK1\n'
const KEEP_RUNTIMES = 3

function pm2Home () {
  return process.env.PM2_HOME || path.join(os.homedir(), '.pm2')
}

function runtimeRoot () {
  return process.env.PM2_RUNTIME_DIR || path.join(pm2Home(), 'runtime')
}

/** unpack runtime.pak into dir: records of [u32 name length][name][u32 mode][u32 size][bytes] */
function unpack (dir) {
  const buf = zlib.gunzipSync(fs.readFileSync(payloadFile))
  if (buf.toString('utf8', 0, MAGIC.length) !== MAGIC) throw new Error('corrupt runtime payload')
  let at = MAGIC.length
  while (at < buf.length) {
    const nameLen = buf.readUInt32LE(at); at += 4
    const name = buf.toString('utf8', at, at + nameLen); at += nameLen
    const mode = buf.readUInt32LE(at); at += 4
    const size = buf.readUInt32LE(at); at += 4
    const file = path.join(dir, name)
    if (!file.startsWith(dir + path.sep)) throw new Error('corrupt runtime payload: ' + name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, buf.subarray(at, at + size), { mode })
    at += size
  }
}

/** the unpacked runtime for this build, unpacking it on first use */
function ensureRuntime () {
  const root = runtimeRoot()
  const dir = path.join(root, `${build.version}-${build.hash}`)
  if (fs.existsSync(path.join(dir, '.complete'))) return dir

  fs.mkdirSync(root, { recursive: true })
  const tmp = `${dir}.tmp-${process.pid}`
  fs.rmSync(tmp, { recursive: true, force: true })
  unpack(tmp)
  fs.writeFileSync(path.join(tmp, '.complete'), JSON.stringify(build))
  try {
    fs.renameSync(tmp, dir)
  } catch (e) {
    // another pm2 command unpacked it first
    fs.rmSync(tmp, { recursive: true, force: true })
    if (!fs.existsSync(path.join(dir, '.complete'))) throw e
  }
  prune(root, dir)
  return dir
}

/**
 * Remove older runtimes, keeping the newest few: a daemon started by a previous binary still
 * starts apps from its own runtime until it restarts.
 */
function prune (root, current) {
  try {
    const now = Date.now()
    const entries = fs.readdirSync(root).map(name => {
      const full = path.join(root, name)
      return { full, name, mtime: fs.statSync(full).mtimeMs }
    })
    for (const e of entries) {
      if (e.name.includes('.tmp-') && now - e.mtime > 3600e3) fs.rmSync(e.full, { recursive: true, force: true })
    }
    entries
      .filter(e => !e.name.includes('.tmp-') && e.full !== current)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(KEEP_RUNTIMES - 1)
      .forEach(e => fs.rmSync(e.full, { recursive: true, force: true }))
  } catch (e) {}
}

let dir
try {
  dir = ensureRuntime()
} catch (e) {
  console.error(`[PM2][ERROR] cannot unpack pm2 to ${runtimeRoot()}: ${e.message}`)
  process.exit(1)
}

if (process.argv[2] === '--binary-info') {
  console.log(JSON.stringify({ version: build.version, hash: build.hash, commit: build.commit, built: build.built, bun: process.versions.bun, platform: `${process.platform}-${process.arch}`, binary: process.execPath, runtime: dir }))
  process.exit(0)
}

process.env.PM2_BINARY = process.execPath
process.env.PM2_RUNTIME = dir
createRequire(path.join(dir, 'package.json'))('./lib/binaries/CLI.js')
