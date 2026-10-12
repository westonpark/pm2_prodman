/* eslint-env mocha */
'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Supervisor = require('../../src/push/Supervisor')

describe('prodman Supervisor', () => {
  let root
  const setup = (cgroup) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-'))
    fs.writeFileSync(path.join(root, 'pm2.pid'), '4242')
    fs.mkdirSync(path.join(root, 'proc', '4242'), { recursive: true })
    fs.writeFileSync(path.join(root, 'proc', '4242', 'cgroup'), cgroup)
    return Supervisor.supervisor(root, { platform: 'linux', procRoot: path.join(root, 'proc'), fresh: true })
  }
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('finds the systemd service running the daemon', () => {
    assert.deepStrictEqual(setup('0::/system.slice/pm2-ubuntu.service\n'), { supervisor: 'systemd', service: 'pm2-ubuntu.service' })
    assert.deepStrictEqual(setup('0::/docker/c9de/system.slice/pm2-ec2-user.service\n'), { supervisor: 'systemd', service: 'pm2-ec2-user.service' })
    assert.deepStrictEqual(setup('12:pids:/x\n1:name=systemd:/system.slice/pm2-mike.service\n'), { supervisor: 'systemd', service: 'pm2-mike.service' })
  })

  it('reports a daemon started from a shell or a CI runner as unsupervised', () => {
    assert.deepStrictEqual(setup('0::/user.slice/user-1000.slice/session-12.scope\n'), { supervisor: 'none', service: null })
    assert.deepStrictEqual(setup('0::/system.slice/actions.runner.westonpark.nas.service\n'), { supervisor: 'none', service: null })
  })

  it('knows nothing off Linux or without a daemon', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-'))
    assert.strictEqual(Supervisor.supervisor(root, { platform: 'darwin', fresh: true }), null)
    assert.strictEqual(Supervisor.supervisor(root, { platform: 'linux', procRoot: root, fresh: true }), null)
  })
})
