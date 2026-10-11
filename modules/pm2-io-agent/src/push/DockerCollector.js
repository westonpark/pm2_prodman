'use strict'

/**
 * prodman: reports the host's Docker containers to prodman.
 *
 * Enabled by `prodman.collect_docker` in the verifyPM2 response (re-read on every poll).
 * Talks to the Docker Engine API over its Unix socket, picked by PRODMAN_DOCKER:
 *   auto (default)  DOCKER_HOST when it is unix://…, else /var/run/docker.sock
 *   unix:///path    a specific socket
 *   off             never collect
 * The PM2 user needs access to the socket (on Linux: the `docker` group).
 *
 * Every 10s it sends `docker:status`: the engine (version, or why it can't be reached) and every
 * container with state, health, restarts, uptime, ports, compose project, CPU, memory and network.
 * CPU is derived from successive one-shot stats samples, so polling stays cheap.
 *
 * While logs are collected (`prodman.collect_logs`), each running container's log stream is
 * followed and forwarded on `docker:logs`, batched every second and capped per batch like syslog.
 * A follower that ends (container stopped, daemon restarted) resumes from its last line.
 */

const fs = require('fs')
const http = require('http')
const log = require('debug')('interactor:docker')

const STATUS_MS = 10000
const FLUSH_MS = 1000
const MAX_LINES_PER_FLUSH = 500
const MAX_LINE_LENGTH = 8000
const MAX_FOLLOWERS = 100
const REQUEST_TIMEOUT = 8000
const CONCURRENCY = 4

/** The Docker socket to use, or null when collection is off / not possible. */
function socketPath (env) {
  const setting = String(env.PRODMAN_DOCKER || 'auto').trim()
  if (setting === 'off' || setting === 'false' || setting === '0') return null
  if (setting !== 'auto') return setting.replace(/^unix:\/\//, '')
  const host = env.DOCKER_HOST
  if (host) return host.startsWith('unix://') ? host.slice(7) : null // tcp:// hosts aren't supported
  return '/var/run/docker.sock'
}

/** GET a Docker API path over the socket; resolves the parsed JSON (or rejects with a clear error). */
function dockerGet (socket, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, path, method: 'GET', timeout: REQUEST_TIMEOUT }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', c => { body += c })
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`docker ${path}: HTTP ${res.statusCode} ${body.slice(0, 200)}`))
        try { resolve(JSON.parse(body)) } catch (e) { reject(new Error(`docker ${path}: invalid JSON`)) }
      })
    })
    req.on('timeout', () => req.destroy(new Error(`docker ${path}: timed out`)))
    req.on('error', reject)
    req.end()
  })
}

/** Open a streaming GET (container logs); resolves the response stream. */
function dockerStream (socket, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, path, method: 'GET' }, (res) => {
      if (res.statusCode >= 400) {
        res.resume()
        return reject(new Error(`docker ${path}: HTTP ${res.statusCode}`))
      }
      res.abort = () => req.destroy()
      resolve(res)
    })
    req.on('error', reject)
    req.end()
  })
}

/** A friendlier reason for an unreachable engine. */
function describeError (err, socket) {
  if (err && err.code === 'EACCES') return `permission denied on ${socket}: add the PM2 user to the docker group and restart PM2`
  if (err && (err.code === 'ENOENT' || err.code === 'ECONNREFUSED')) return `Docker daemon not running (${socket})`
  return (err && err.message) || String(err)
}

/**
 * Splits a container log stream into lines. Without a TTY Docker multiplexes stdout/stderr in
 * frames: [stream(1) 0 0 0 size(4, big-endian)] + payload. With a TTY the stream is raw stdout.
 */
class LogDemuxer {
  constructor (tty, onLine) {
    this.tty = tty
    this.onLine = onLine
    this.buf = Buffer.alloc(0)
    this.partial = { out: '', err: '' }
  }

  push (chunk) {
    if (this.tty) return this._text('out', chunk.toString('utf8'))
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    while (this.buf.length >= 8) {
      const size = this.buf.readUInt32BE(4)
      if (this.buf.length < 8 + size) break
      const stream = this.buf[0] === 2 ? 'err' : 'out'
      this._text(stream, this.buf.slice(8, 8 + size).toString('utf8'))
      this.buf = this.buf.slice(8 + size)
    }
  }

  _text (stream, text) {
    const parts = (this.partial[stream] + text).split('\n')
    this.partial[stream] = parts.pop()
    for (const line of parts) this.onLine(stream, line.replace(/\r$/, ''))
  }
}

/** "2026-10-11T09:12:01.123456789Z message" (timestamps=1) → { at, message } */
function parseTimestamped (line, now) {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})) ?(.*)$/.exec(line)
  if (!m) return { at: now, message: line }
  const at = Date.parse(m[1])
  return { at: Number.isFinite(at) ? at : now, message: m[2] }
}

/** Format published ports once per mapping ("8080->80/tcp"), IPv4/IPv6 duplicates merged. */
function formatPorts (ports) {
  const out = []
  for (const p of ports || []) {
    const s = p.PublicPort ? `${p.PublicPort}->${p.PrivatePort}/${p.Type}` : `${p.PrivatePort}/${p.Type}`
    if (!out.includes(s)) out.push(s)
  }
  return out
}

/** Map with at most `limit` promises in flight. */
async function mapLimit (items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

class DockerCollector {
  /**
   * @param {Object} opts agent opts (shared with the daemon)
   * @param {Object} transport TransporterInterface (needs send(channel, payload))
   * @param {Object} [deps] injectable env/get/stream/now/exists for tests
   */
  constructor (opts, transport, deps) {
    deps = deps || {}
    this.opts = opts
    this.transport = transport
    this.env = deps.env || process.env
    this.get = deps.get || dockerGet
    this.stream = deps.stream || dockerStream
    this.now = deps.now || Date.now
    this.exists = deps.exists || (p => fs.existsSync(p))
    this.statusMs = deps.statusMs || STATUS_MS
    this.enabled = false
    this.logsEnabled = false
    this.socket = null
    this.engine = null
    this.followers = new Map() // container id → { res, lastAt, name }
    this.prevStats = new Map() // container id → { cpu, sys, rx, tx, at }
    this.buffer = []
    this.dropped = 0
    this._pollTimer = null
    this._flushTimer = null
    this._polling = false
  }

  setEnabled (enabled) {
    if (enabled && !this.enabled) this.start()
    else if (!enabled && this.enabled) this.stop()
  }

  /** follow container logs (only while the bucket collects logs) */
  setLogsEnabled (enabled) {
    this.logsEnabled = !!enabled
    if (!this.logsEnabled) this._stopFollowers()
  }

  start () {
    this.socket = socketPath(this.env)
    if (!this.socket) {
      log('docker collection off (PRODMAN_DOCKER=%s, DOCKER_HOST=%s)', this.env.PRODMAN_DOCKER || 'auto', this.env.DOCKER_HOST || '')
      return false
    }
    // no socket at all: Docker isn't installed here, stay quiet
    if (!this.exists(this.socket)) {
      log('no docker socket at %s', this.socket)
      return false
    }
    this.enabled = true
    this.startedAt = this.now()
    log('collecting docker containers from %s', this.socket)
    this.poll()
    this._pollTimer = setInterval(() => this.poll(), this.statusMs)
    this._flushTimer = setInterval(() => this.flush(), FLUSH_MS)
    for (const t of [this._pollTimer, this._flushTimer]) if (t.unref) t.unref()
    return true
  }

  stop () {
    this.enabled = false
    if (this._pollTimer) clearInterval(this._pollTimer)
    if (this._flushTimer) clearInterval(this._flushTimer)
    this._pollTimer = this._flushTimer = null
    this._stopFollowers()
    this.flush()
  }

  /** One status cycle. Resolves the payload sent (handy for tests). */
  async poll () {
    if (this._polling) return null
    this._polling = true
    try {
      if (!this.engine) {
        const v = await this.get(this.socket, '/version')
        this.engine = { available: true, version: v.Version, apiVersion: v.ApiVersion, os: v.Os, arch: v.Arch }
      }
      const list = await this.get(this.socket, '/containers/json?all=1')
      const containers = await mapLimit(list, CONCURRENCY, c => this._describe(c))
      const payload = { at: this.now(), engine: this.engine, containers }
      this.transport.send('docker:status', payload)
      if (this.logsEnabled) this._syncFollowers(containers)
      return payload
    } catch (err) {
      this.engine = null
      const payload = { at: this.now(), engine: { available: false, error: describeError(err, this.socket) }, containers: [] }
      log('docker poll failed: %s', payload.engine.error)
      this.transport.send('docker:status', payload)
      this._stopFollowers()
      return payload
    } finally {
      this._polling = false
    }
  }

  async _describe (c) {
    const id = String(c.Id).slice(0, 12)
    const labels = c.Labels || {}
    const out = {
      id,
      name: String((c.Names && c.Names[0]) || id).replace(/^\//, ''),
      image: c.Image,
      state: c.State,
      status: c.Status,
      createdAt: c.Created ? c.Created * 1000 : null,
      ports: formatPorts(c.Ports),
      compose: labels['com.docker.compose.project'] ? { project: labels['com.docker.compose.project'], service: labels['com.docker.compose.service'] || null } : null,
      health: null,
      exitCode: null,
      oomKilled: false,
      restartCount: 0,
      restartPolicy: null,
      startedAt: null,
      tty: false,
      cpu: null,
      memory: null,
      memoryLimit: null,
      netRx: null,
      netTx: null
    }
    try {
      const i = await this.get(this.socket, `/containers/${id}/json`)
      const st = i.State || {}
      // a stopped container keeps its last health check result; it only means something while running
      out.health = (c.State === 'running' && st.Health && st.Health.Status) || null
      out.exitCode = Number.isFinite(st.ExitCode) ? st.ExitCode : null
      out.oomKilled = !!st.OOMKilled
      out.restartCount = i.RestartCount || 0
      out.restartPolicy = (i.HostConfig && i.HostConfig.RestartPolicy && i.HostConfig.RestartPolicy.Name) || null
      const started = Date.parse(st.StartedAt)
      out.startedAt = Number.isFinite(started) && started > 0 ? started : null
      out.tty = !!(i.Config && i.Config.Tty)
    } catch (e) {
      log('inspect %s failed: %s', id, e.message)
    }
    if (c.State === 'running') {
      try {
        Object.assign(out, this._usage(id, await this.get(this.socket, `/containers/${id}/stats?stream=false&one-shot=true`)))
      } catch (e) {
        log('stats %s failed: %s', id, e.message)
      }
    } else {
      this.prevStats.delete(id)
    }
    return out
  }

  /** CPU % / memory / network rates from a one-shot stats sample and the previous one */
  _usage (id, s) {
    const now = this.now()
    const cpuStats = s.cpu_stats || {}
    const cpu = cpuStats.cpu_usage ? cpuStats.cpu_usage.total_usage : null
    const sys = cpuStats.system_cpu_usage
    const cpus = cpuStats.online_cpus || (cpuStats.cpu_usage && cpuStats.cpu_usage.percpu_usage && cpuStats.cpu_usage.percpu_usage.length) || 1
    let rx = 0; let tx = 0
    for (const n of Object.values(s.networks || {})) { rx += n.rx_bytes || 0; tx += n.tx_bytes || 0 }
    const prev = this.prevStats.get(id)
    this.prevStats.set(id, { cpu, sys, rx, tx, at: now })
    const mem = s.memory_stats || {}
    const ms = mem.stats || {}
    const cache = ms.inactive_file != null ? ms.inactive_file : ms.total_inactive_file != null ? ms.total_inactive_file : (ms.cache || 0)
    const dt = prev ? (now - prev.at) / 1000 : 0
    return {
      cpu: prev && cpu != null && sys > prev.sys ? Math.round(((cpu - prev.cpu) / (sys - prev.sys)) * cpus * 1000) / 10 : null,
      memory: mem.usage != null ? Math.max(0, mem.usage - cache) : null,
      memoryLimit: mem.limit || null,
      netRx: prev && dt > 0 ? Math.max(0, Math.round((rx - prev.rx) / dt)) : null,
      netTx: prev && dt > 0 ? Math.max(0, Math.round((tx - prev.tx) / dt)) : null
    }
  }

  _syncFollowers (containers) {
    const running = new Map(containers.filter(c => c.state === 'running').map(c => [c.id, c]))
    for (const [id, f] of this.followers) {
      if (!running.has(id)) this._closeFollower(id, f)
    }
    if (this._resume) for (const id of [...this._resume.keys()]) if (!running.has(id)) this._resume.delete(id)
    for (const c of running.values()) {
      if (this.followers.has(c.id) || this.followers.size >= MAX_FOLLOWERS) continue
      this._follow(c)
    }
  }

  _follow (c) {
    const prev = this._resume && this._resume.get(c.id)
    // a container that started since we began collecting: from its start, so its first lines
    // (often the interesting ones) aren't lost; otherwise only new lines
    const since = prev || (c.startedAt && this.startedAt && c.startedAt > this.startedAt ? c.startedAt : this.now())
    const f = { res: null, lastAt: since, name: c.name, closed: false }
    this.followers.set(c.id, f)
    const path = `/containers/${c.id}/logs?follow=1&stdout=1&stderr=1&timestamps=1&since=${(since / 1000).toFixed(3)}`
    this.stream(this.socket, path).then((res) => {
      if (f.closed) return res.abort && res.abort()
      f.res = res
      const demux = new LogDemuxer(c.tty, (stream, line) => {
        const { at, message } = parseTimestamped(line, this.now())
        if (at <= f.lastAt && prev) return // already sent before the follower was reopened
        f.lastAt = Math.max(f.lastAt, at)
        this._push({ id: c.id, name: c.name, stream, at, message: message.slice(0, MAX_LINE_LENGTH) })
      })
      res.on('data', chunk => demux.push(chunk))
      const done = () => {
        if (this.followers.get(c.id) === f) this.followers.delete(c.id)
        // resume from the last line on the next poll if the container is still running
        if (!f.closed) (this._resume || (this._resume = new Map())).set(c.id, f.lastAt)
      }
      res.on('end', done)
      res.on('error', done)
    }, (err) => {
      log('follow logs of %s failed: %s', c.name, err.message)
      if (this.followers.get(c.id) === f) this.followers.delete(c.id)
    })
  }

  _closeFollower (id, f) {
    f.closed = true
    if (f.res && f.res.abort) f.res.abort()
    this.followers.delete(id)
    if (this._resume) this._resume.delete(id)
  }

  _stopFollowers () {
    for (const [id, f] of this.followers) this._closeFollower(id, f)
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
    this.transport.send('docker:logs', { at: this.now(), lines, dropped })
  }
}

DockerCollector.socketPath = socketPath
DockerCollector.LogDemuxer = LogDemuxer
DockerCollector.parseTimestamped = parseTimestamped
DockerCollector.formatPorts = formatPorts
DockerCollector.describeError = describeError
module.exports = DockerCollector
