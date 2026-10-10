'use strict'

/**
 * prodman: describes how each PM2 process is run — language runtime and version,
 * interpreter path/arguments, virtualenv, script, launch options — for the
 * `runtime` field of status entries.
 *
 * Versions:
 *  - Node.js processes report their own `process.versions.node` to PM2
 *    (pm2_env.node_version), which is exact per process, so that is used as-is.
 *  - Other runtimes are asked `<interpreter> --version` (execFile, no shell,
 *    3s timeout), run from the process's working directory with its PATH, because
 *    version-manager shims (asdf, pyenv) choose the version by directory. Results
 *    are cached per interpreter path + directory, refreshed when the binary changes
 *    or after an hour. Probing is asynchronous: describe()
 *    never blocks the status loop, so the first status after a start may carry
 *    `version: null` until the probe returns.
 *  - Only well-known interpreters are probed — never the app script, never a
 *    `none`/binary process, never an unrecognised custom interpreter.
 */

const fs = require('fs')
const path = require('path')
const childProcess = require('child_process')

const PROBE_TIMEOUT_MS = 3000
const CACHE_TTL_MS = 60 * 60 * 1000
const VERSION_RE = /(\d+\.\d+(?:\.\d+)?)/

/** basename pattern → runtime kind. Order matters (first match wins). */
const KINDS = [
  [/^(node|nodejs)(\d+)?$/, 'node'],
  [/^(ts-node|tsx)$/, 'node'],
  [/^python(\d+(\.\d+)?)?$/, 'python'],
  [/^pypy(\d+)?$/, 'python'],
  [/^bun$/, 'bun'],
  [/^deno$/, 'deno'],
  [/^(bash|sh|zsh|dash|ksh)$/, 'shell'],
  [/^ruby$/, 'ruby'],
  [/^php(\d+(\.\d+)?)?$/, 'php'],
  [/^perl$/, 'perl'],
  [/^java$/, 'java'],
  [/^dotnet$/, 'dotnet']
]
/** kinds whose interpreter is safe to ask for its version */
const PROBEABLE = new Set(['node', 'python', 'bun', 'deno', 'shell', 'ruby', 'php', 'perl', 'java', 'dotnet'])

function kindOf (interpreter) {
  if (!interpreter || interpreter === 'none') return 'binary'
  const base = path.basename(String(interpreter).split('@')[0])
  for (const [re, kind] of KINDS) if (re.test(base)) return kind
  return base || 'unknown'
}

/** One searchPath-style lookup, without spawning `which`. */
function resolveExecutable (cmd, searchPath, fsImpl) {
  if (!cmd || cmd === 'none') return null
  if (cmd.includes('/') || cmd.includes(path.sep)) return cmd
  for (const dir of String(searchPath || '').split(path.delimiter)) {
    if (!dir) continue
    const full = path.join(dir, cmd)
    try {
      fsImpl.accessSync(full, fsImpl.constants.X_OK)
      return full
    } catch (e) {}
  }
  return null
}

/** `<venv>/bin/python` → `<venv>` when `<venv>/pyvenv.cfg` exists. */
function virtualenvOf (interpreterPath, fsImpl) {
  if (!interpreterPath) return null
  const root = path.dirname(path.dirname(interpreterPath))
  try {
    if (fsImpl.existsSync(path.join(root, 'pyvenv.cfg'))) return root
  } catch (e) {}
  return null
}

const asList = (v) => Array.isArray(v) ? v : (v === undefined || v === null || v === '' ? [] : [v])

module.exports = class RuntimeInspector {
  /**
   * @param {Object} [deps] injectable fs / execFile / env for tests
   */
  constructor (deps) {
    deps = deps || {}
    this.fs = deps.fs || fs
    this.execFile = deps.execFile || childProcess.execFile
    this.env = deps.env || process.env
    this.cache = new Map() // resolved path → { version, mtimeMs, at }
    this.pending = new Set()
  }

  /**
   * Runtime description for one process (pm2_env). Synchronous, uses cached probes.
   * @param {Object} env pm2_env
   */
  describe (env) {
    env = env || {}
    const interpreter = env.exec_interpreter || null
    const kind = kindOf(interpreter)
    const searchPath = (env.env && env.env.PATH) || env.PATH || this.env.PATH
    const interpreterPath = kind === 'binary' ? null : resolveExecutable(interpreter, searchPath, this.fs)

    let version = null
    let versionSource = null
    if (kind === 'node' && env.node_version) {
      version = String(env.node_version).replace(/^v/, '')
      versionSource = 'process'
    } else if (interpreterPath && PROBEABLE.has(kind)) {
      version = this._cachedVersion(interpreterPath, env.pm_cwd || null, searchPath)
      versionSource = version ? 'interpreter' : null
    }

    return {
      kind,
      version,
      versionSource,
      interpreter,
      interpreterPath,
      interpreterArgs: asList(env.interpreter_args),
      nodeArgs: asList(env.node_args),
      virtualenv: kind === 'python' ? virtualenvOf(interpreterPath, this.fs) : null,
      script: env.pm_exec_path || null,
      args: asList(env.args),
      cwd: env.pm_cwd || null,
      execMode: env.exec_mode || null,
      instances: env.instances !== undefined ? env.instances : null,
      user: env.username || null,
      nodeEnv: env.NODE_ENV || (env.env && env.env.NODE_ENV) || null,
      watch: env.watch !== undefined ? !!env.watch : false,
      autorestart: env.autorestart !== undefined ? !!env.autorestart : true,
      maxMemoryRestart: env.max_memory_restart || null,
      killTimeout: env.kill_timeout || null,
      cronRestart: env.cron_restart || null,
      mergeLogs: !!env.merge_logs
    }
  }

  _isDir (p) {
    try { return this.fs.statSync(p).isDirectory() } catch (e) { return false }
  }

  _cachedVersion (interpreterPath, cwd, searchPath) {
    let mtimeMs = 0
    try { mtimeMs = this.fs.statSync(interpreterPath).mtimeMs } catch (e) { return null }
    const key = `${interpreterPath}\0${cwd || ''}`
    const hit = this.cache.get(key)
    const fresh = hit && hit.mtimeMs === mtimeMs && Date.now() - hit.at < CACHE_TTL_MS
    if (!fresh) this._probe(key, interpreterPath, cwd, searchPath, mtimeMs)
    return hit ? hit.version : null
  }

  _probe (key, interpreterPath, cwd, searchPath, mtimeMs) {
    if (this.pending.has(key)) return
    this.pending.add(key)
    const done = (version) => {
      this.pending.delete(key)
      this.cache.set(key, { version, mtimeMs, at: Date.now() })
    }
    const opts = { timeout: PROBE_TIMEOUT_MS, windowsHide: true, env: { ...this.env, PATH: searchPath || this.env.PATH } }
    if (cwd && this._isDir(cwd)) opts.cwd = cwd
    try {
      this.execFile(interpreterPath, ['--version'], opts, (err, stdout, stderr) => {
        // python 2 and java print their version on stderr
        const out = `${stdout || ''}\n${stderr || ''}`
        const m = err ? null : VERSION_RE.exec(out)
        done(m ? m[1] : null)
      })
    } catch (e) {
      done(null)
    }
  }
}

module.exports.kindOf = kindOf
