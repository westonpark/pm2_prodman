/* eslint-env mocha */

'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')
const SyslogCollector = require('../../src/push/SyslogCollector')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function fakeTransport () {
  const sent = []
  return { sent, send: (channel, payload) => sent.push({ channel, payload }) }
}

describe('prodman SyslogCollector', function () {
  this.timeout(10000)

  describe('parsing', () => {
    it('parses BSD syslog lines', () => {
      const l = SyslogCollector.parseSyslogLine('Oct  9 17:41:34 nas sshd[1234]: Accepted publickey for mike', 42)
      assert.deepStrictEqual(l, { at: 42, ident: 'sshd', pid: 1234, message: 'Accepted publickey for mike' })
    })

    it('parses rsyslog high-precision lines with their own timestamp', () => {
      const l = SyslogCollector.parseSyslogLine('2026-10-09T17:41:34.500000+01:00 nas kernel: [ 12.3] usb 1-1: new device', 42)
      assert.strictEqual(l.ident, 'kernel')
      assert.strictEqual(l.pid, undefined)
      assert.strictEqual(l.message, '[ 12.3] usb 1-1: new device')
      assert.strictEqual(l.at, Date.parse('2026-10-09T16:41:34.500Z'))
    })

    it('keeps unrecognised lines verbatim', () => {
      assert.deepStrictEqual(SyslogCollector.parseSyslogLine('-- MARK --', 7), { at: 7, message: '-- MARK --' })
    })

    it('parses journald json, including byte-array messages', () => {
      const l = SyslogCollector.parseJournalEntry(JSON.stringify({ MESSAGE: 'Started nginx', PRIORITY: '6', SYSLOG_IDENTIFIER: 'systemd', _PID: '1', __REALTIME_TIMESTAMP: '1791540000123456' }), 0)
      assert.deepStrictEqual(l, { at: 1791540000123, priority: 6, ident: 'systemd', pid: 1, message: 'Started nginx' })
      const bytes = SyslogCollector.parseJournalEntry(JSON.stringify({ MESSAGE: [104, 105], _COMM: 'app' }), 5)
      assert.strictEqual(bytes.message, 'hi')
      assert.strictEqual(bytes.ident, 'app')
      assert.strictEqual(SyslogCollector.parseJournalEntry('not json', 0), null)
    })
  })

  describe('source detection', () => {
    it('is off when PRODMAN_SYSLOG=off', () => {
      const c = new SyslogCollector({}, fakeTransport(), { platform: 'linux', env: { PRODMAN_SYSLOG: 'off' } })
      assert.strictEqual(c.detectSource(), null)
      assert.strictEqual(c.start(), false)
    })

    it('is off by default on non-linux platforms', () => {
      const c = new SyslogCollector({}, fakeTransport(), { platform: 'darwin', env: {} })
      assert.strictEqual(c.detectSource(), null)
    })

    it('honours explicit file: and journald settings', () => {
      assert.deepStrictEqual(new SyslogCollector({}, null, { platform: 'darwin', env: { PRODMAN_SYSLOG: 'file:/tmp/x.log' } }).detectSource(), { type: 'file', path: '/tmp/x.log' })
      assert.deepStrictEqual(new SyslogCollector({}, null, { platform: 'linux', env: { PRODMAN_SYSLOG: 'journald' } }).detectSource(), { type: 'journald' })
    })
  })

  describe('file tailing', () => {
    let dir, file, c, transport
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-syslog-'))
      file = path.join(dir, 'syslog')
      fs.writeFileSync(file, 'Oct  9 10:00:00 host old[1]: existing line\n')
      transport = fakeTransport()
      c = new SyslogCollector({}, transport, { platform: 'linux', env: { PRODMAN_SYSLOG: `file:${file}` } })
    })
    afterEach(() => {
      c.stop()
      fs.rmSync(dir, { recursive: true, force: true })
    })

    const lines = () => transport.sent.flatMap(s => s.payload.lines)

    // polling is driven directly (c._pollFile + c.flush) so these don't depend on real timers
    const poll = () => { c._pollFile(); c.flush() }

    it('forwards only lines written after start, then follows rotation', () => {
      assert.strictEqual(c.start(), true)
      fs.appendFileSync(file, 'Oct  9 10:00:01 host cron[42]: job ran\npartial')
      poll()
      assert.deepStrictEqual(lines().map(l => l.message), ['job ran'])
      assert.strictEqual(transport.sent[0].channel, 'syslog')
      assert.strictEqual(transport.sent[0].payload.source, `file:${file}`)

      // the partial line completes on the next write
      fs.appendFileSync(file, ' line\n')
      poll()
      assert.deepStrictEqual(lines().map(l => l.message), ['job ran', 'partial line'])

      // logrotate: move the file away and create a fresh one
      fs.renameSync(file, `${file}.1`)
      fs.writeFileSync(file, 'Oct  9 10:00:02 host sshd[7]: after rotation\n')
      poll()
      assert.deepStrictEqual(lines().map(l => l.message), ['job ran', 'partial line', 'after rotation'])
    })

    it('restarts from the top when the file is truncated', () => {
      c.start()
      // logrotate copytruncate: the file is emptied, then appended to again
      fs.truncateSync(file, 0)
      poll()
      fs.appendFileSync(file, 'Oct  9 10:00:03 host app[9]: after truncate\n')
      poll()
      assert.deepStrictEqual(lines().map(l => l.message), ['after truncate'])
    })
  })

  describe('journald', () => {
    it('streams journalctl json and restarts it when it exits', async () => {
      const spawned = []
      const spawn = (cmd, args) => {
        const child = new EventEmitter()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.kill = () => {}
        spawned.push({ cmd, args, child })
        return child
      }
      const transport = fakeTransport()
      const c = new SyslogCollector({}, transport, { platform: 'linux', env: { PRODMAN_SYSLOG: 'journald' }, spawn })
      c._restartDelay = 50
      c.start()
      assert.strictEqual(spawned[0].cmd, 'journalctl')
      assert(spawned[0].args.includes('--output=json'))
      const entry = JSON.stringify({ MESSAGE: 'disk full', PRIORITY: '3', SYSLOG_IDENTIFIER: 'kernel' })
      // split across chunks to exercise line reassembly
      spawned[0].child.stdout.write(entry.slice(0, 10))
      spawned[0].child.stdout.write(entry.slice(10) + '\n')
      await wait(1200)
      assert.deepStrictEqual(transport.sent[0].payload.lines.map(l => [l.ident, l.priority, l.message]), [['kernel', 3, 'disk full']])
      c._restartDelay = 50
      spawned[0].child.emit('exit', 1)
      await wait(150)
      assert.strictEqual(spawned.length, 2)
      c.stop()
    })
  })

  describe('batching', () => {
    it('caps each batch and reports dropped lines', () => {
      const transport = fakeTransport()
      const c = new SyslogCollector({}, transport, { platform: 'linux', env: {} })
      for (let i = 0; i < 600; i++) c.push({ at: i, message: `line ${i}` })
      c.flush()
      assert.strictEqual(transport.sent[0].payload.lines.length, 500)
      assert.strictEqual(transport.sent[0].payload.dropped, 100)
      c.flush()
      assert.strictEqual(transport.sent.length, 1)
    })
  })

  describe('daemon integration', () => {
    it('toggles collection from prodman.collect_syslog on every verify poll', () => {
      const InteractorDaemon = require('../../src/InteractorDaemon')
      const calls = []
      const fake = { opts: {}, syslog: { setEnabled: v => calls.push(v) } }
      InteractorDaemon.prototype._applyProdmanSettings.call(fake, { prodman: { collect_logs: true, collect_syslog: true } })
      assert.strictEqual(fake.opts.PRODMAN_COLLECT_SYSLOG, true)
      InteractorDaemon.prototype._applyProdmanSettings.call(fake, { prodman: { collect_logs: true } })
      assert.strictEqual(fake.opts.PRODMAN_COLLECT_SYSLOG, false)
      assert.deepStrictEqual(calls, [true, false])
    })
  })
})
