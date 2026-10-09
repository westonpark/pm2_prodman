'use strict'

/**
 * prodman: forwards the host's system log to prodman on the `syslog` channel.
 *
 * Enabled by `prodman.collect_syslog` in the verifyPM2 response (re-read on every
 * poll). The source is picked by PRODMAN_SYSLOG:
 *   auto (default)    journald if journalctl exists, else /var/log/syslog, else /var/log/messages
 *   journald          `journalctl -f -o json` (the agent's user needs the systemd-journal or adm group)
 *   file:/path/to/log tail a classic text syslog file (handles rotation/truncation)
 *   off               never collect
 *
 * Lines are batched every second and capped per batch; excess lines are counted
 * in `dropped` so a log storm cannot saturate the WebSocket.
 */

const fs = require('fs')
const path = require('path')
const childProcess = require('child_process')
const log = require('debug')('interactor:syslog')

const FLUSH_MS = 1000
const POLL_MS = 1000
const MAX_LINES_PER_FLUSH = 500
const MAX_LINE_LENGTH = 8000
const MAX_READ_BYTES = 1024 * 1024
const FILE_CANDIDATES = ['/var/log/syslog', '/var/log/messages']

// "Oct  9 17:41:34 host ident[123]: message"  (BSD / RFC 3164)
const BSD_RE = /^[A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \S+ ([^\s:[]+)(?:\[(\d+)\])?: ?(.*)$/
// "2026-10-09T17:41:34.123456+01:00 host ident[123]: message"  (rsyslog high-precision)
const ISO_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})) \S+ ([^\s:[]+)(?:\[(\d+)\])?: ?(.*)$/

/** Parse one text syslog line into {at, ident, pid, message}. */
function parseSyslogLine (line, now) {
  let m = ISO_RE.exec(line)
  if (m) {
    const at = Date.parse(m[1])
    return { at: Number.isFinite(at) ? at : now, ident: m[2], pid: m[3] ? Number(m[3]) : undefined, message: m[4] }
  }
  m = BSD_RE.exec(line)
  // BSD timestamps have no year/zone; the line was just written, so use receive time
  if (m) return { at: now, ident: m[1], pid: m[2] ? Number(m[2]) : undefined, message: m[3] }
  return { at: now, message: line }
}

/** Convert one `journalctl -o json` record into a line. */
function parseJournalEntry (json, now) {
  let entry
  try { entry = JSON.parse(json) } catch (e) { return null }
  let message = entry.MESSAGE
  // binary-safe journald fields arrive as byte arrays
  if (Array.isArray(message)) message = Buffer.from(message).toString('utf8')
  if (typeof message !== 'string') return null
  const usec = Number(entry.__REALTIME_TIMESTAMP)
  const priority = Number(entry.PRIORITY)
  return {
    at: Number.isFinite(usec) ? Math.floor(usec / 1000) : now,
    priority: Number.isFinite(priority) ? priority : undefined,
    ident: entry.SYSLOG_IDENTIFIER || entry._COMM || undefined,
    pid: entry._PID ? Number(entry._PID) : undefined,
    message
  }
}

function which (bin, env) {
  const dirs = String((env && env.PATH) || '').split(path.delimiter).concat(['/usr/bin', '/bin', '/usr/sbin'])
  for (const dir of dirs) {
    if (!dir) continue
    const full = path.join(dir, bin)
    try {
      fs.accessSync(full, fs.constants.X_OK)
      return full
    } catch (e) {}
  }
  return null
}

function isReadable (file) {
  try {
    fs.accessSync(file, fs.constants.R_OK)
    return fs.statSync(file).isFile()
  } catch (e) {
    return false
  }
}

module.exports = class SyslogCollector {
  /**
   * @param {Object} opts agent opts (shared with the daemon)
   * @param {Object} transport TransporterInterface (needs send(channel, payload))
   * @param {Object} [deps] injectable platform/env/spawn for tests
   */
  constructor (opts, transport, deps) {
    deps = deps || {}
    this.opts = opts
    this.transport = transport
    this.platform = deps.platform || process.platform
    this.env = deps.env || process.env
    this.spawn = deps.spawn || childProcess.spawn
    this.enabled = false
    this.source = null
    this.buffer = []
    this.dropped = 0
    this._flushTimer = null
    this._child = null
    this._restartTimer = null
    this._restartDelay = 5000
    this._file = null
  }

  /** Resolve the configured source, or null when collection isn't possible. */
  detectSource () {
    const setting = String(this.env.PRODMAN_SYSLOG || 'auto').trim()
    if (setting === 'off' || setting === 'false' || setting === '0') return null
    if (setting.startsWith('file:')) return { type: 'file', path: setting.slice(5) }
    if (setting === 'journald') return { type: 'journald' }
    // auto: macOS's unified log has no stable text file, so it is opt-in via file:
    if (this.platform !== 'linux') return null
    if (which('journalctl', this.env) && fs.existsSync('/run/systemd/journal')) return { type: 'journald' }
    const file = FILE_CANDIDATES.find(isReadable)
    return file ? { type: 'file', path: file } : null
  }

  setEnabled (enabled) {
    if (enabled && !this.enabled) this.start()
    else if (!enabled && this.enabled) this.stop()
  }

  start () {
    const source = this.detectSource()
    if (!source) {
      log('syslog collection requested but no source is available (PRODMAN_SYSLOG=%s, platform %s)', this.env.PRODMAN_SYSLOG || 'auto', this.platform)
      return false
    }
    this.enabled = true
    this.source = source
    log('collecting syslog from %s', this.describeSource())
    if (source.type === 'journald') this._startJournald()
    else this._startFile(source.path)
    this._flushTimer = setInterval(() => this.flush(), FLUSH_MS)
    return true
  }

  stop () {
    this.enabled = false
    if (this._flushTimer) clearInterval(this._flushTimer)
    if (this._restartTimer) clearTimeout(this._restartTimer)
    this._flushTimer = this._restartTimer = null
    if (this._child) {
      this._child.removeAllListeners('exit')
      try { this._child.kill() } catch (e) {}
      this._child = null
    }
    if (this._file) {
      clearInterval(this._file.timer)
      try { fs.closeSync(this._file.fd) } catch (e) {}
      this._file = null
    }
    this.flush()
    this.buffer = []
  }

  describeSource () {
    if (!this.source) return 'none'
    return this.source.type === 'journald' ? 'journald' : `file:${this.source.path}`
  }

  push (line) {
    if (!line || !line.message) return
    if (this.buffer.length >= MAX_LINES_PER_FLUSH) {
      this.dropped++
      return
    }
    if (line.message.length > MAX_LINE_LENGTH) line.message = line.message.slice(0, MAX_LINE_LENGTH)
    this.buffer.push(line)
  }

  flush () {
    if (!this.buffer.length && !this.dropped) return
    const lines = this.buffer
    const dropped = this.dropped
    this.buffer = []
    this.dropped = 0
    try {
      this.transport.send('syslog', { at: Date.now(), source: this.describeSource(), lines, dropped })
    } catch (e) {
      log('failed to send syslog batch: %s', e.message)
    }
  }

  // --- journald ---------------------------------------------------------

  _startJournald () {
    let child
    try {
      child = this.spawn('journalctl', ['--follow', '--lines=0', '--output=json', '--no-pager'], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      log('cannot spawn journalctl: %s', e.message)
      return this._scheduleRestart()
    }
    this._child = child
    let partial = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      const parts = (partial + chunk).split('\n')
      partial = parts.pop()
      const now = Date.now()
      for (const json of parts) if (json) this.push(parseJournalEntry(json, now))
    })
    if (child.stderr) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (msg) => log('journalctl: %s', String(msg).trim()))
    }
    child.on('error', (e) => log('journalctl error: %s', e.message))
    child.on('exit', (code) => {
      log('journalctl exited with %s', code)
      this._child = null
      this._scheduleRestart()
    })
    this._restartDelay = 5000
  }

  _scheduleRestart () {
    if (!this.enabled || this._restartTimer) return
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null
      if (this.enabled) this._startJournald()
    }, this._restartDelay)
    this._restartDelay = Math.min(this._restartDelay * 2, 60000)
  }

  // --- text file --------------------------------------------------------

  _startFile (file) {
    const state = { path: file, fd: null, ino: null, pos: 0, partial: '', timer: null }
    this._file = state
    const open = (fromStart) => {
      try {
        if (state.fd !== null) fs.closeSync(state.fd)
      } catch (e) {}
      state.fd = null
      try {
        const st = fs.statSync(file)
        state.fd = fs.openSync(file, 'r')
        state.ino = st.ino
        // start at the end the first time so we only forward new lines
        state.pos = fromStart ? 0 : st.size
        state.partial = ''
      } catch (e) {
        log('cannot open %s: %s', file, e.message)
      }
    }
    open(false)
    // exposed so tests can drive polling without timers
    this._pollFile = () => {
      let st
      try { st = fs.statSync(file) } catch (e) { return }
      // rotated (new inode) or truncated: start reading the new file from the top.
      // (A truncate followed by a larger rewrite inside one poll interval looks like
      // growth and is not detected; logrotate copytruncate appends gradually.)
      if (state.fd === null || st.ino !== state.ino || st.size < state.pos) open(true)
      if (state.fd === null || st.size <= state.pos) return
      const length = Math.min(st.size - state.pos, MAX_READ_BYTES)
      const buf = Buffer.alloc(length)
      let read = 0
      try { read = fs.readSync(state.fd, buf, 0, length, state.pos) } catch (e) { return }
      state.pos += read
      const parts = (state.partial + buf.slice(0, read).toString('utf8')).split('\n')
      state.partial = parts.pop()
      const now = Date.now()
      for (const line of parts) if (line) this.push(parseSyslogLine(line, now))
    }
    state.timer = setInterval(this._pollFile, POLL_MS)
  }
}

module.exports.parseSyslogLine = parseSyslogLine
module.exports.parseJournalEntry = parseJournalEntry
