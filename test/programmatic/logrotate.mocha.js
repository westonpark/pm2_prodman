/* eslint-env mocha */

'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const LogRotate = require('../../lib/LogRotate.js')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

describe('prodman built-in log rotation', function () {
  let dir

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-rot-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  /** a fake daemon with one fork-mode app writing to out/err logs */
  function setup (conf, extra) {
    const out = path.join(dir, 'app-out.log')
    const err = path.join(dir, 'app-error.log')
    const pm2Log = path.join(dir, 'pm2.log')
    const reopened = []
    const proc = {
      pm2_env: { name: 'app', exec_mode: 'fork_mode', pm_out_log_path: out, pm_err_log_path: err },
      _reloadLogs: cb => { reopened.push('app'); cb() }
    }
    const God = { clusters_db: { 0: proc, ...(extra || {}) } }
    const lines = []
    const rot = new LogRotate(God, { pm2Log, getConfig: () => conf, reopenDelay: 0, log: m => lines.push(m) })
    return { rot, God, out, err, pm2Log, reopened, lines }
  }

  it('parses sizes, booleans and settings', () => {
    assert.strictEqual(LogRotate.parseSize('10M'), 10 * 1024 * 1024)
    assert.strictEqual(LogRotate.parseSize('1.5G'), 1.5 * 1024 * 1024 * 1024)
    assert.strictEqual(LogRotate.parseSize('500k'), 500 * 1024)
    assert.strictEqual(LogRotate.parseSize('2048'), 2048)
    assert.strictEqual(LogRotate.parseSize('lots'), null)
    // pmx autocasts "true" to true; both must work (the module ignored the boolean)
    for (const v of [true, 'true', 1, '1', 'yes']) assert.strictEqual(LogRotate.parseBool(v, false), true)
    for (const v of [false, 'false', 0, '0', 'no']) assert.strictEqual(LogRotate.parseBool(v, true), false)
    const c = LogRotate.readConfig({ max_size: '50M', retain: '7', compress: true, workerInterval: '30' })
    assert.deepStrictEqual([c.maxSize, c.retain, c.compress, c.workerInterval, c.enabled], [50 * 1024 * 1024, 7, true, 30000, true])
    assert.strictEqual(LogRotate.readConfig({ retain: 'all' }).retain, Infinity)
    assert.strictEqual(LogRotate.readConfig(null).maxSize, 10 * 1024 * 1024)
    assert.strictEqual(LogRotate.readConfig({ enabled: 'false' }).enabled, false)
  })

  it('formats the date suffix, optionally in a time zone', () => {
    const d = new Date(Date.UTC(2026, 9, 10, 23, 5, 9, 7))
    assert.strictEqual(LogRotate.formatDate(d, 'YYYY-MM-DD_HH-mm-ss.SSS', 'UTC'), '2026-10-10_23-05-09.007')
    assert.strictEqual(LogRotate.formatDate(d, 'YYYY-MM-DD_HH-mm', 'Europe/London'), '2026-10-11_00-05')
  })

  it('renames a full app log, reopens it, compresses the copy and keeps the app writing', async () => {
    const t = setup({ max_size: '1K', compress: true })
    fs.writeFileSync(t.out, 'x'.repeat(2000) + '\n')
    fs.writeFileSync(t.err, 'small\n')
    t.rot.check()
    await t.rot.idle()
    await wait(10)
    assert.deepStrictEqual(t.reopened, ['app'])
    assert.strictEqual(fs.existsSync(t.out), false, 'renamed away; the app recreates it on reopen')
    const copies = LogRotate.rotatedCopies(t.out)
    assert.strictEqual(copies.length, 1)
    assert.match(copies[0], /app-out__\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.log\.gz$/)
    assert.strictEqual(zlib.gunzipSync(fs.readFileSync(copies[0])).toString(), 'x'.repeat(2000) + '\n')
    assert.strictEqual(fs.readFileSync(t.err, 'utf8'), 'small\n', 'small logs are left alone')
  })

  it('copies and truncates pm2.log, which the daemon cannot reopen', async () => {
    const t = setup({ max_size: '1K', compress: false })
    fs.writeFileSync(t.pm2Log, 'y'.repeat(3000))
    t.rot.check()
    await t.rot.idle()
    assert.strictEqual(fs.statSync(t.pm2Log).size, 0)
    const copies = LogRotate.rotatedCopies(t.pm2Log)
    assert.strictEqual(copies.length, 1)
    assert.strictEqual(fs.readFileSync(copies[0], 'utf8'), 'y'.repeat(3000))
  })

  it('never starts a second rotation of a file while one is in progress', async () => {
    const t = setup({ max_size: '1K', compress: false })
    fs.writeFileSync(t.pm2Log, 'z'.repeat(5 * 1024 * 1024))
    t.rot.check(); t.rot.check(); t.rot.check()
    await t.rot.idle()
    assert.strictEqual(LogRotate.rotatedCopies(t.pm2Log).length, 1)
  })

  it('keeps only the newest `retain` copies, compressed or not', async () => {
    const t = setup({ max_size: '1', compress: false, retain: 2, dateFormat: 'YYYY-MM-DD_HH-mm-ss-SSS' })
    const old = path.join(dir, 'app-out__2020-01-01_00-00-00.log.gz')
    fs.writeFileSync(old, 'old')
    fs.utimesSync(old, new Date(2020, 0, 1), new Date(2020, 0, 1))
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(t.out, 'line ' + i + '\n')
      t.rot.check()
      await t.rot.idle()
      await wait(15)
    }
    const copies = LogRotate.rotatedCopies(t.out)
    assert.strictEqual(copies.length, 2)
    assert.deepStrictEqual(copies.map(f => fs.readFileSync(f, 'utf8')), ['line 2\n', 'line 1\n'])
  })

  it('rotates every non-empty log when forced (the daily schedule)', async () => {
    const t = setup({ max_size: '10M', compress: false })
    fs.writeFileSync(t.out, 'a\n')
    fs.writeFileSync(t.err, '')
    t.rot.check(true)
    await t.rot.idle()
    assert.strictEqual(LogRotate.rotatedCopies(t.out).length, 1)
    assert.strictEqual(LogRotate.rotatedCopies(t.err).length, 0)
  })

  it('reopens cluster workers by message', async () => {
    const sent = []
    const worker = {
      pm2_env: { name: 'web', exec_mode: 'cluster_mode', pm_out_log_path: path.join(dir, 'web-out.log') },
      isConnected: () => true,
      send: m => sent.push(m)
    }
    const t = setup({ max_size: '1', compress: false }, { 1: worker })
    fs.writeFileSync(worker.pm2_env.pm_out_log_path, 'hello\n')
    t.rot.check()
    await t.rot.idle()
    assert.deepStrictEqual(sent, [{ type: 'log:reload' }])
  })

  it('pauses while the pm2-logrotate module is installed, and when disabled', () => {
    const module = { pm2_env: { name: 'pm2-logrotate', pmx_module: true } }
    const t = setup({ max_size: '1' }, { 9: module })
    fs.writeFileSync(t.out, 'data\n')
    assert.strictEqual(t.rot.check(), null)
    assert.match(t.lines[0], /pm2 uninstall pm2-logrotate/)
    const off = setup({ max_size: '1', enabled: false })
    assert.strictEqual(off.rot.check(), null)
    assert.strictEqual(fs.readFileSync(t.out, 'utf8'), 'data\n')
  })

  it('compresses leftover copies and removes unfinished .gz.tmp files once per start', async () => {
    const t = setup({ max_size: '10M', compress: true })
    const left = path.join(dir, 'app-out__2026-10-10_11-01-37.log')
    const tmp = path.join(dir, 'app-error__2026-10-10_11-01-37.log.gz.tmp')
    fs.writeFileSync(left, 'left over\n')
    fs.writeFileSync(tmp, 'partial')
    t.rot.check()
    await t.rot.idle()
    assert.strictEqual(fs.existsSync(left), false)
    assert.strictEqual(fs.existsSync(tmp), false)
    assert.strictEqual(zlib.gunzipSync(fs.readFileSync(left + '.gz')).toString(), 'left over\n')
  })

  it('skips module logs when rotateModule is off', () => {
    const module = { pm2_env: { name: 'some-module', pmx_module: true, pm_out_log_path: path.join(dir, 'mod.log') } }
    const t = setup({ rotateModule: false }, { 2: module })
    assert.strictEqual(t.rot.targets(LogRotate.readConfig({ rotateModule: false }))[module.pm2_env.pm_out_log_path], undefined)
  })
})
