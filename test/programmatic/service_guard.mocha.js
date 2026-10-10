/* eslint-env mocha */

'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const ServiceGuard = require('../../lib/ServiceGuard.js')

const UNIT = `[Service]
Type=forking
User=mike
Environment=PATH=/usr/bin
Environment=PM2_HOME=/home/mike/.pm2
PIDFile=/home/mike/.pm2/pm2.pid
ExecStart=/usr/bin/pm2 resurrect
`

describe('prodman ServiceGuard', function () {
  let dir, cgroupOutside, cgroupInside
  const base = () => ({ pm2Home: '/home/mike/.pm2', dirs: [dir], cgroupFile: cgroupOutside, env: {}, unitState: () => 'failed' })

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-guard-'))
    fs.writeFileSync(path.join(dir, 'pm2-mike.service'), UNIT)
    fs.writeFileSync(path.join(dir, 'pm2-other.service'), UNIT.replace('/home/mike/.pm2', '/srv/other/.pm2'))
    fs.writeFileSync(path.join(dir, 'nginx.service'), UNIT)
    cgroupOutside = path.join(dir, 'cg-out')
    cgroupInside = path.join(dir, 'cg-in')
    fs.writeFileSync(cgroupOutside, '0::/user.slice/user-1000.slice/session-5003.scope\n')
    fs.writeFileSync(cgroupInside, '0::/system.slice/pm2-mike.service\n')
  })

  after(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('finds the systemd unit installed for this PM2_HOME', () => {
    assert.deepStrictEqual(ServiceGuard.findService('/home/mike/.pm2/', { dirs: [dir] }), { unit: 'pm2-mike.service', file: path.join(dir, 'pm2-mike.service') })
    assert.strictEqual(ServiceGuard.findService('/srv/other/.pm2', { dirs: [dir] }).unit, 'pm2-other.service')
    assert.strictEqual(ServiceGuard.findService('/home/nobody/.pm2', { dirs: [dir] }), null)
    assert.strictEqual(ServiceGuard.findService('/home/mike/.pm2', { dirs: ['/nonexistent'] }), null)
  })

  it('refuses a daemon outside the installed service, naming it and its state', () => {
    const err = ServiceGuard.check(base())
    assert.strictEqual(err.code, 'PM2_SERVICE_NOT_RUNNING')
    assert.strictEqual(err.service, 'pm2-mike')
    assert.match(err.message, /service is failed/)
    assert.match(err.message, /sudo systemctl start pm2-mike/)
  })

  it('allows the daemon when systemd runs pm2 for the service', () => {
    assert.strictEqual(ServiceGuard.check({ ...base(), cgroupFile: cgroupInside }), null)
    assert.strictEqual(ServiceGuard.insideUnit('pm2-mike.service', cgroupInside), true)
    assert.strictEqual(ServiceGuard.insideUnit('pm2-mike.service', cgroupOutside), false)
  })

  it('mentions the runner when a CI job hits the installed service', () => {
    const err = ServiceGuard.check({ ...base(), env: { GITHUB_ACTIONS: 'true', RUNNER_TRACKING_ID: 'github_1' } })
    assert.strictEqual(err.code, 'PM2_SERVICE_NOT_RUNNING')
    assert.match(err.message, /runner would kill it/)
  })

  it('refuses a daemon in a runner job when no service is installed', () => {
    const opts = { ...base(), dirs: ['/nonexistent'], env: { RUNNER_TRACKING_ID: 'github_1', USER: 'mike' } }
    const err = ServiceGuard.check(opts)
    assert.strictEqual(err.code, 'PM2_RUNNER_NO_DAEMON')
    assert.match(err.message, /pm2 startup/)
    assert.strictEqual(ServiceGuard.check({ ...opts, env: { GITHUB_ACTIONS: 'true' } }).code, 'PM2_RUNNER_NO_DAEMON')
  })

  it('allows a daemon with no service and no runner, or with the guard off', () => {
    assert.strictEqual(ServiceGuard.check({ ...base(), dirs: ['/nonexistent'] }), null)
    assert.strictEqual(ServiceGuard.check({ ...base(), env: { PM2_SERVICE_GUARD: 'off', GITHUB_ACTIONS: 'true' } }), null)
  })

  it('blocks pm2 update outside the service and in runner jobs', () => {
    const err = ServiceGuard.checkUpdate(base())
    assert.strictEqual(err.code, 'PM2_UPDATE_OUTSIDE_SERVICE')
    assert.match(err.message, /pm2 save && sudo systemctl restart pm2-mike/)
    assert.strictEqual(ServiceGuard.checkUpdate({ ...base(), cgroupFile: cgroupInside }), null)
    assert.strictEqual(ServiceGuard.checkUpdate({ ...base(), dirs: ['/nonexistent'] }), null)
    assert.match(ServiceGuard.checkUpdate({ ...base(), dirs: ['/nonexistent'], env: { GITHUB_ACTIONS: 'true', USER: 'ci' } }).message, /runner job/)
  })

  it('reports the service pm2 kill leaves stopped', () => {
    assert.strictEqual(ServiceGuard.stoppedService(base()), 'pm2-mike')
    assert.strictEqual(ServiceGuard.stoppedService({ ...base(), cgroupFile: cgroupInside }), null)
  })

  it('is inert on hosts without systemd units', () => {
    if (process.platform === 'linux') return
    assert.strictEqual(ServiceGuard.findService('/home/mike/.pm2'), null)
  })
})
