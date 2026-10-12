/* eslint-env mocha */

'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')
const ServiceCollector = require('../../src/push/ServiceCollector')
const FileTail = require('../../src/push/FileTail')
const AgentUpdater = require('../../src/reverse/AgentUpdater')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const BOOT_AT = 1_000_000_000 - 3_600_000

const SHOW = `Id=nginx.service
Description=A high performance web server
LoadState=loaded
ActiveState=active
SubState=running
MainPID=976
MemoryCurrent=16777216
CPUUsageNSec=2000000000
NRestarts=2
ActiveEnterTimestampMonotonic=60000000
UnitFileState=enabled

Id=postgresql@17-main.service
Description=PostgreSQL Cluster 17-main
LoadState=loaded
ActiveState=failed
SubState=failed
MainPID=0
MemoryCurrent=[not set]
CPUUsageNSec=[not set]
NRestarts=0
ActiveEnterTimestampMonotonic=0
UnitFileState=enabled
`

function fakeHost (overrides) {
  const calls = []
  let cpu = 2000000000
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '))
    if (args[0] === 'list-unit-files') return { stdout: 'nginx.service enabled enabled\npostgresql.service enabled enabled\npostgresql@.service indirect enabled\nssh.service enabled enabled\n', stderr: '' }
    if (args[0] === 'list-units') return { stdout: '  nginx.service loaded active running nginx\n● postgresql@17-main.service loaded failed failed PostgreSQL Cluster 17-main\n', stderr: '' }
    if (args[0] === 'show') { cpu += 500000000; return { stdout: SHOW.replace('CPUUsageNSec=2000000000', `CPUUsageNSec=${cpu}`), stderr: '' } }
    if (cmd === 'nginx') return { stdout: '', stderr: 'nginx version: nginx/1.28.3 (Ubuntu)\n' }
    if (cmd === 'psql') return { stdout: 'psql (PostgreSQL) 17.9 (Ubuntu 17.9-1)\n', stderr: '' }
    return { stdout: '', stderr: 'not found' }
  }
  let now = 1_000_000_000
  const sent = []
  const c = new ServiceCollector({}, { send: (ch, p) => sent.push({ ch, p }) }, Object.assign({
    platform: 'linux', exec, now: () => now, uptimeMs: () => now - BOOT_AT, readdir: () => ['postgresql-17-main.log', 'postgresql-17-main.log.1'], readable: () => true, statusMs: 60000
  }, overrides || {}))
  return { c, sent, calls, advance: ms => { now += ms } }
}

describe('prodman ServiceCollector', function () {
  this.timeout(10000)

  it('parses systemctl output and versions', () => {
    const shown = ServiceCollector.parseShow(SHOW)
    assert.deepStrictEqual(shown.map(s => [s.Id, s.ActiveState]), [['nginx.service', 'active'], ['postgresql@17-main.service', 'failed']])
    assert.deepStrictEqual([...ServiceCollector.parseUnitNames('● php8.3-fpm.service loaded\n  nginx.service x\npostgresql@.service t')], ['php8.3-fpm.service', 'nginx.service'])
    assert.strictEqual(ServiceCollector.parseVersion('nginx version: nginx/1.28.3 (Ubuntu)'), '1.28.3')
    assert.strictEqual(ServiceCollector.parseVersion('psql (PostgreSQL) 17.9 (Ubuntu 17.9-1)'), '17.9')
    assert.deepStrictEqual(ServiceCollector.expandGlob('/var/log/postgresql/*.log', () => ['a.log', 'a.log.1', 'b.log.gz', 'c.txt']), ['/var/log/postgresql/a.log'])
  })

  it('reports installed services even when none is monitored', async () => {
    const t = fakeHost()
    const p = await t.c.poll()
    assert.deepStrictEqual(p.available.map(a => [a.key, a.units]), [['nginx', ['nginx.service']], ['postgresql', ['postgresql@17-main.service']]])
    assert.deepStrictEqual(p.services, [])
    assert.ok(!t.calls.some(c => c.startsWith('systemctl show')), 'no per-unit queries until something is monitored')
  })

  it('reports monitored services: state, pid, memory, cpu, restarts, uptime, version, log sources', async () => {
    const t = fakeHost()
    t.c.services = ['nginx', 'postgresql', 'redis']
    await t.c.poll()
    t.advance(10000)
    const p = await t.c.poll()
    const [nginx, pg] = p.services
    assert.strictEqual(nginx.unit, 'nginx.service')
    assert.strictEqual(nginx.active, 'active')
    assert.strictEqual(nginx.pid, 976)
    assert.strictEqual(nginx.memory, 16777216)
    assert.strictEqual(nginx.cpu, 5) // 0.5s of CPU over 10s
    assert.strictEqual(nginx.restarts, 2)
    assert.strictEqual(nginx.since, 1_000_000_000 - 3_600_000 + 60_000) // boot + 60s
    assert.strictEqual(nginx.version, '1.28.3')
    assert.deepStrictEqual(nginx.logs, ['journal', '/var/log/nginx/access.log', '/var/log/nginx/error.log'])
    assert.strictEqual(pg.active, 'failed')
    assert.strictEqual(pg.pid, null)
    assert.strictEqual(pg.memory, null)
    assert.strictEqual(pg.since, null)
    assert.strictEqual(pg.version, '17.9')
    assert.deepStrictEqual(pg.logs, ['journal', '/var/log/postgresql/postgresql-17-main.log'])
    assert.deepStrictEqual(p.missing, ['redis'])
  })

  it('does nothing off Linux', async () => {
    const t = fakeHost({ platform: 'darwin' })
    t.c.services = ['nginx']
    assert.strictEqual(await t.c.poll(), null)
    assert.strictEqual(t.c.start(), false)
  })

  it('follows the journal of monitored services while logs are collected', async () => {
    const spawned = []
    const spawn = (cmd, args) => {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.kill = () => { child.killed = true }
      spawned.push({ cmd, args, child })
      return child
    }
    const t = fakeHost({ spawn, readable: () => false })
    t.c.services = ['nginx']
    t.c.setLogsEnabled(true)
    await wait(5)
    assert.strictEqual(spawned.length, 1)
    assert.deepStrictEqual(spawned[0].args.slice(-2), ['-u', 'nginx.service'])
    spawned[0].child.stdout.write(JSON.stringify({ MESSAGE: 'started', PRIORITY: '6', __REALTIME_TIMESTAMP: '1791700000000000', _SYSTEMD_UNIT: 'nginx.service' }) + '\n')
    spawned[0].child.stdout.write(JSON.stringify({ MESSAGE: 'bind() failed', PRIORITY: '3', __REALTIME_TIMESTAMP: '1791700001000000' }) + '\n')
    t.c.flush()
    const lines = t.sent.find(s => s.ch === 'services:logs').p.lines
    assert.deepStrictEqual(lines.map(l => [l.key, l.stream, l.message, l.at]), [['nginx', 'out', 'started', 1791700000000], ['nginx', 'err', 'bind() failed', 1791700001000]])
    t.c.setLogsEnabled(false)
    assert.strictEqual(spawned[0].child.killed, true)
  })
})

describe('prodman FileTail', () => {
  it('follows appends, rotation and truncation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-'))
    const f = path.join(dir, 'a.log')
    fs.writeFileSync(f, 'old\n')
    const lines = []
    const t = new FileTail(f, l => lines.push(l))
    t._open(false)
    fs.appendFileSync(f, 'one\ntw')
    t.poll()
    fs.appendFileSync(f, 'o\n')
    t.poll()
    fs.renameSync(f, f + '.1'); fs.writeFileSync(f, 'three\n')
    t.poll()
    fs.writeFileSync(f, 'four\n')
    t.poll()
    t.stop()
    assert.deepStrictEqual(lines, ['one', 'two', 'three', 'four'])
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('prodman AgentUpdater', () => {
  it('only accepts pm2_prodman sources unless allowed', () => {
    assert.strictEqual(AgentUpdater.checkSource('https://codeload.github.com/westonpark/pm2_prodman/tar.gz/master', {}), null)
    assert.strictEqual(AgentUpdater.checkSource('github:westonpark/pm2_prodman#v8.2.0', {}), null)
    assert.ok(/not allowed/.test(AgentUpdater.checkSource('https://registry.npmjs.org/pm2/-/pm2-6.0.0.tgz', {})))
    assert.strictEqual(AgentUpdater.checkSource('https://mirror.example/pm2.tgz', { PRODMAN_UPDATE_SOURCES: 'https://mirror.example/' }), null)
    assert.ok(/invalid/.test(AgentUpdater.checkSource('https://codeload.github.com/westonpark/pm2_prodman/x;reboot', {})))
    assert.ok(/disabled/.test(AgentUpdater.checkSource('https://codeload.github.com/westonpark/pm2_prodman/tar.gz/master', { PRODMAN_AUTO_UPDATE: 'off' })))
  })

  it('starts a detached update script and reports the previous outcome once', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'))
    const spawned = []
    const spawn = (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { pid: 42, unref () {} } }
    let res
    AgentUpdater.selfUpdate({ source: 'https://codeload.github.com/westonpark/pm2_prodman/tar.gz/master' }, { env: {}, home, spawn, version: '8.1.1', user: 'mike', execPath: '/n/bin/node' }, (err, r) => { res = r; assert.ifError(err) })
    assert.deepStrictEqual(res, { started: true, from: '8.1.1', source: 'https://codeload.github.com/westonpark/pm2_prodman/tar.gz/master', log: path.join(home, 'prodman-update.log') })
    assert.strictEqual(spawned[0].opts.detached, true)
    const script = fs.readFileSync(spawned[0].args[0], 'utf8')
    assert.ok(script.includes("npm install -g --allow-remote=root 'https://codeload.github.com/westonpark/pm2_prodman/tar.gz/master'"))
    assert.ok(script.includes('UNIT=pm2-mike'))
    assert.ok(script.includes('sudo -n systemctl restart "$UNIT"'))
    let err
    AgentUpdater.selfUpdate({ source: 'https://evil.example/x.tgz' }, { env: {}, home, spawn }, (e) => { err = e })
    assert.ok(/not allowed/.test(err.message))
    fs.writeFileSync(path.join(home, 'prodman-update.json'), JSON.stringify({ at: 1, from: '8.1.1', ok: true, to: '8.2.0', restart: 'systemd' }))
    fs.writeFileSync(path.join(home, 'prodman-update.log'), 'installed 8.2.0\n')
    const sent = []
    const p = AgentUpdater.reportPrevious({ send: (ch, x) => sent.push([ch, x]) }, { env: {}, home, version: '8.2.0' })
    assert.strictEqual(sent[0][0], 'agent:update')
    assert.strictEqual(p.ok, true)
    assert.strictEqual(p.to, '8.2.0')
    assert.ok(p.log.includes('installed 8.2.0'))
    assert.strictEqual(AgentUpdater.reportPrevious({ send: () => assert.fail('reported twice') }, { env: {}, home }), null)
    fs.rmSync(home, { recursive: true, force: true })
  })
})
