'use strict'

/**
 * prodman: monitors popular system services (nginx, PostgreSQL, …) chosen in prodman.
 *
 * prodman sends the services to monitor (`prodman.services` in verifyPM2, or a pushed
 * `prodman:settings`). On Linux with systemd, every 10s it sends `services:status`:
 *   - available: which known services are installed here (unit files), so prodman can offer them
 *   - services:  for each monitored one, every matching unit's state, sub-state, PID, uptime,
 *                CPU %, memory, restarts and version (from `systemctl show`, no root needed)
 * While logs are collected (`collect_logs`) it follows each monitored service's journal
 * (`journalctl -u`, needs the systemd-journal group) and its usual log files when readable
 * (e.g. /var/log/nginx/*.log, needs the adm group), forwarding them on `services:logs`.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const childProcess = require('child_process')
const FileTail = require('./FileTail')
const log = require('debug')('interactor:services')

const STATUS_MS = 10000
const AVAILABLE_MS = 60000
const VERSION_MS = 3600000
const FLUSH_MS = 1000
const MAX_LINES_PER_FLUSH = 500
const MAX_LINE_LENGTH = 8000

/** Known services: unit name patterns, a version command, and their usual log files. */
const CATALOGUE = {
  nginx: { label: 'nginx', units: [/^nginx\.service$/], version: [['nginx', '-v']], files: ['/var/log/nginx/access.log', '/var/log/nginx/error.log'] },
  apache: { label: 'Apache', units: [/^apache2\.service$/, /^httpd\.service$/], version: [['apache2', '-v'], ['httpd', '-v']], files: ['/var/log/apache2/access.log', '/var/log/apache2/error.log', '/var/log/httpd/access_log', '/var/log/httpd/error_log'] },
  postgresql: { label: 'PostgreSQL', units: [/^postgresql@[^.]+\.service$/, /^postgresql(-\d+)?\.service$/], version: [['psql', '--version'], ['postgres', '--version']], files: ['/var/log/postgresql/*.log'] },
  mysql: { label: 'MySQL / MariaDB', units: [/^mysql\.service$/, /^mysqld\.service$/, /^mariadb\.service$/], version: [['mysqld', '--version'], ['mariadbd', '--version'], ['mysql', '--version']], files: ['/var/log/mysql/error.log', '/var/log/mysqld.log', '/var/log/mariadb/mariadb.log'] },
  redis: { label: 'Redis', units: [/^redis-server\.service$/, /^redis\.service$/], version: [['redis-server', '--version']], files: ['/var/log/redis/redis-server.log', '/var/log/redis/redis.log'] },
  mongodb: { label: 'MongoDB', units: [/^mongod\.service$/, /^mongodb\.service$/], version: [['mongod', '--version']], files: ['/var/log/mongodb/mongod.log'] },
  'php-fpm': { label: 'PHP-FPM', units: [/^php[\d.]*-fpm\.service$/], version: [['php', '-v']], files: ['/var/log/php*-fpm.log'] },
  haproxy: { label: 'HAProxy', units: [/^haproxy\.service$/], version: [['haproxy', '-v']], files: ['/var/log/haproxy.log'] },
  caddy: { label: 'Caddy', units: [/^caddy\.service$/], version: [['caddy', 'version']], files: [] },
  rabbitmq: { label: 'RabbitMQ', units: [/^rabbitmq-server\.service$/], version: [['rabbitmqctl', 'version']], files: ['/var/log/rabbitmq/*.log'] }
}

const PROPS = ['Id', 'Description', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'MemoryCurrent', 'CPUUsageNSec', 'NRestarts', 'ActiveEnterTimestampMonotonic', 'UnitFileState']

/** `systemctl show` output (blank-line separated blocks of Key=Value) → objects */
function parseShow (text) {
  return String(text).split(/\n\s*\n/).map(block => {
    const o = {}
    for (const line of block.split('\n')) {
      const i = line.indexOf('=')
      if (i > 0) o[line.slice(0, i)] = line.slice(i + 1)
    }
    return o
  }).filter(o => o.Id)
}

/** unit names from `systemctl list-unit-files` / `list-units` output */
function parseUnitNames (text) {
  const names = new Set()
  for (const line of String(text).split('\n')) {
    const m = /^\s*[●*]?\s*(\S+\.service)\b/.exec(line)
    if (m && !m[1].includes('@.')) names.add(m[1])
  }
  return names
}

/** "nginx version: nginx/1.24.0 (Ubuntu)" → "1.24.0" */
function parseVersion (text) {
  const m = /(\d+\.\d+(?:\.\d+)?(?:[-.~+][\w.]+)?)/.exec(String(text))
  return m ? m[1].replace(/[-~+].*$/, '') : null
}

/** expand "/var/log/postgresql/*.log" (a * in the file name only) */
function expandGlob (pattern, readdir) {
  if (!pattern.includes('*')) return [pattern]
  const dir = path.dirname(pattern)
  const re = new RegExp('^' + path.basename(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
  try { return readdir(dir).filter(n => re.test(n) && !/\.(gz|\d+)$/.test(n)).map(n => path.join(dir, n)) } catch (e) { return [] }
}

const num = v => { const n = Number(v); return Number.isFinite(n) && v !== '' && v !== '[not set]' && n < 1.8e19 ? n : null }

class ServiceCollector {
  /**
   * @param {Object} opts agent opts
   * @param {Object} transport needs send(channel, payload)
   * @param {Object} [deps] exec/spawn/platform/now/readdir/readable for tests
   */
  constructor (opts, transport, deps) {
    deps = deps || {}
    this.opts = opts
    this.transport = transport
    this.platform = deps.platform || process.platform
    this.now = deps.now || Date.now
    this.exec = deps.exec || ((cmd, args) => new Promise((resolve) => {
      childProcess.execFile(cmd, args, { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }))
    }))
    this.spawn = deps.spawn || childProcess.spawn
    this.readdir = deps.readdir || (d => fs.readdirSync(d))
    this.readable = deps.readable || (f => { try { fs.accessSync(f, fs.constants.R_OK); return fs.statSync(f).isFile() } catch (e) { return false } })
    this.uptimeMs = deps.uptimeMs || (() => os.uptime() * 1000)
    this.statusMs = deps.statusMs || STATUS_MS
    this.services = [] // keys prodman asked to monitor
    this.logsEnabled = false
    this.available = null // key → [units]
    this.availableAt = 0
    this.versions = new Map() // key → { version, at }
    this.prevCpu = new Map() // unit → { ns, at }
    this.followers = new Map() // key → { journal, tails: [] }
    this.buffer = []
    this.dropped = 0
    this._timer = null
    this._flushTimer = null
    this._polling = false
  }

  get supported () { return this.platform === 'linux' }

  /** services to monitor (keys of CATALOGUE); starts/stops polling and log followers */
  setServices (keys) {
    const next = (Array.isArray(keys) ? keys : []).filter(k => CATALOGUE[k])
    const changed = next.join(',') !== this.services.join(',')
    this.services = next
    if (!this._timer) this.start()
    if (changed) {
      this._syncFollowers()
      this.poll()
    }
  }

  setLogsEnabled (enabled) {
    this.logsEnabled = !!enabled
    this._syncFollowers()
  }

  start () {
    if (this._timer || !this.supported) return false
    this._timer = setInterval(() => this.poll(), this.statusMs)
    this._flushTimer = setInterval(() => this.flush(), FLUSH_MS)
    for (const t of [this._timer, this._flushTimer]) if (t.unref) t.unref()
    this.poll()
    return true
  }

  stop () {
    if (this._timer) clearInterval(this._timer)
    if (this._flushTimer) clearInterval(this._flushTimer)
    this._timer = this._flushTimer = null
    for (const key of [...this.followers.keys()]) this._stopFollower(key)
    this.flush()
  }

  /** installed known services → { key: [unit, …] } (cached for a minute) */
  async detect (force) {
    if (!force && this.available && this.now() - this.availableAt < AVAILABLE_MS) return this.available
    const [files, units] = await Promise.all([
      this.exec('systemctl', ['list-unit-files', '--type=service', '--no-legend', '--no-pager']),
      this.exec('systemctl', ['list-units', '--type=service', '--all', '--no-legend', '--no-pager'])
    ])
    const names = new Set([...parseUnitNames(files.stdout), ...parseUnitNames(units.stdout)])
    const out = {}
    for (const [key, def] of Object.entries(CATALOGUE)) {
      const matched = [...names].filter(n => def.units.some(re => re.test(n))).sort()
      // postgresql.service is only a wrapper when versioned instances exist
      const real = key === 'postgresql' && matched.some(u => u.includes('@')) ? matched.filter(u => u.includes('@')) : matched
      if (real.length) out[key] = real
    }
    this.available = out
    this.availableAt = this.now()
    return out
  }

  async version (key) {
    const cached = this.versions.get(key)
    if (cached && this.now() - cached.at < VERSION_MS) return cached.version
    let version = null
    for (const [cmd, ...args] of CATALOGUE[key].version) {
      const r = await this.exec(cmd, args)
      version = parseVersion(r.stdout + '\n' + r.stderr)
      if (version) break
    }
    this.versions.set(key, { version, at: this.now() })
    return version
  }

  /** one status cycle; resolves the payload sent */
  async poll () {
    if (!this.supported || this._polling) return null
    this._polling = true
    try {
      const available = await this.detect()
      const units = this.services.flatMap(k => (available[k] || []).map(u => ({ key: k, unit: u })))
      const shown = units.length ? parseShow((await this.exec('systemctl', ['show', ...units.map(u => u.unit), '--no-pager', `--property=${PROPS.join(',')}`])).stdout) : []
      const byUnit = new Map(shown.map(s => [s.Id, s]))
      const bootAt = this.now() - this.uptimeMs()
      const services = []
      for (const { key, unit } of units) {
        const s = byUnit.get(unit) || {}
        const cpuNs = num(s.CPUUsageNSec)
        const prev = this.prevCpu.get(unit)
        const at = this.now()
        if (cpuNs !== null) this.prevCpu.set(unit, { ns: cpuNs, at })
        const since = num(s.ActiveEnterTimestampMonotonic)
        services.push({
          key,
          label: CATALOGUE[key].label,
          unit,
          description: s.Description || null,
          active: s.ActiveState || 'unknown',
          sub: s.SubState || null,
          enabled: s.UnitFileState || null,
          pid: num(s.MainPID) || null,
          since: since && s.ActiveState === 'active' ? Math.round(bootAt + since / 1000) : null,
          memory: num(s.MemoryCurrent),
          cpu: prev && cpuNs !== null && at > prev.at ? Math.round(((cpuNs - prev.ns) / 1e6 / (at - prev.at)) * 1000) / 10 : null,
          restarts: num(s.NRestarts) || 0,
          version: await this.version(key),
          logs: this._logSources(key, unit)
        })
      }
      // monitored but not installed: say so, prodman shows it as missing
      const missing = this.services.filter(k => !available[k])
      const payload = {
        at: this.now(),
        supported: true,
        available: Object.entries(available).map(([key, u]) => ({ key, label: CATALOGUE[key].label, units: u })),
        services,
        missing
      }
      this.transport.send('services:status', payload)
      return payload
    } catch (err) {
      log('services poll failed: %s', err.message)
      return null
    } finally {
      this._polling = false
    }
  }

  _logSources (key, unit) {
    return ['journal'].concat(CATALOGUE[key].files.flatMap(f => expandGlob(f, this.readdir)).filter(this.readable))
  }

  // --- logs --------------------------------------------------------------

  _syncFollowers () {
    const want = this.logsEnabled && this.supported ? new Set(this.services) : new Set()
    for (const key of [...this.followers.keys()]) if (!want.has(key)) this._stopFollower(key)
    for (const key of want) if (!this.followers.has(key)) this._startFollower(key)
  }

  async _startFollower (key) {
    const f = { journal: null, tails: [], stopped: false }
    this.followers.set(key, f)
    const available = await this.detect().catch(() => ({}))
    if (f.stopped) return
    const units = available[key] || []
    if (units.length) {
      const args = ['-f', '-o', 'json', '-n', '0', '--no-pager'].concat(...units.map(u => ['-u', u]))
      try {
        const child = this.spawn('journalctl', args, { stdio: ['ignore', 'pipe', 'ignore'] })
        f.journal = child
        let partial = ''
        child.stdout.on('data', (chunk) => {
          const parts = (partial + chunk.toString('utf8')).split('\n')
          partial = parts.pop()
          for (const line of parts) this._journalLine(key, line)
        })
        child.on('error', e => log('journalctl for %s: %s', key, e.message))
      } catch (e) {
        log('cannot follow journal for %s: %s', key, e.message)
      }
    }
    for (const file of CATALOGUE[key].files.flatMap(p => expandGlob(p, this.readdir)).filter(this.readable)) {
      const unit = units[0] || null
      f.tails.push(new FileTail(file, line => this._push({
        key, unit, source: `file:${file}`, stream: /error|err\.log/i.test(path.basename(file)) ? 'err' : 'out', at: this.now(), message: line.slice(0, MAX_LINE_LENGTH)
      })).start())
    }
  }

  _journalLine (key, json) {
    let e
    try { e = JSON.parse(json) } catch (err) { return }
    let message = e.MESSAGE
    if (Array.isArray(message)) message = Buffer.from(message).toString('utf8')
    if (typeof message !== 'string') return
    const usec = Number(e.__REALTIME_TIMESTAMP)
    const priority = Number(e.PRIORITY)
    this._push({
      key,
      unit: e._SYSTEMD_UNIT || null,
      source: 'journal',
      stream: Number.isFinite(priority) && priority <= 3 ? 'err' : 'out',
      priority: Number.isFinite(priority) ? priority : undefined,
      at: Number.isFinite(usec) ? Math.floor(usec / 1000) : this.now(),
      message: message.slice(0, MAX_LINE_LENGTH)
    })
  }

  _stopFollower (key) {
    const f = this.followers.get(key)
    if (!f) return
    f.stopped = true
    if (f.journal) try { f.journal.kill() } catch (e) {}
    for (const t of f.tails) t.stop()
    this.followers.delete(key)
  }

  _push (line) {
    if (this.buffer.length >= MAX_LINES_PER_FLUSH) { this.dropped++; return }
    this.buffer.push(line)
  }

  flush () {
    if (!this.buffer.length && !this.dropped) return
    const lines = this.buffer
    const dropped = this.dropped
    this.buffer = []
    this.dropped = 0
    this.transport.send('services:logs', { at: this.now(), lines, dropped })
  }
}

ServiceCollector.CATALOGUE = CATALOGUE
ServiceCollector.parseShow = parseShow
ServiceCollector.parseUnitNames = parseUnitNames
ServiceCollector.parseVersion = parseVersion
ServiceCollector.expandGlob = expandGlob
module.exports = ServiceCollector
