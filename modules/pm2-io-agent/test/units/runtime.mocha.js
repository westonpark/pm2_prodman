/* eslint-env mocha */

'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const RuntimeInspector = require('../../src/push/RuntimeInspector')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

/** temp dir with executable fake interpreters: bin/python3 (+ pyvenv.cfg), bin/bun */
function fakeRoot () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-rt-'))
  fs.mkdirSync(path.join(root, 'venv', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'venv', 'pyvenv.cfg'), 'home = /usr/bin\n')
  for (const f of ['venv/bin/python3', 'venv/bin/bun', 'venv/bin/mywrapper']) {
    fs.writeFileSync(path.join(root, f), '#!/bin/sh\n')
    fs.chmodSync(path.join(root, f), 0o755)
  }
  return root
}

describe('prodman RuntimeInspector', function () {
  it('classifies interpreters', () => {
    const k = RuntimeInspector.kindOf
    assert.strictEqual(k('node'), 'node')
    assert.strictEqual(k('/home/u/.nvm/versions/node/v22.19.0/bin/node'), 'node')
    assert.strictEqual(k('node@18.20.0'), 'node')
    assert.strictEqual(k('python3.8'), 'python')
    assert.strictEqual(k('/srv/app/venv/bin/python'), 'python')
    assert.strictEqual(k('bun'), 'bun')
    assert.strictEqual(k('bash'), 'shell')
    assert.strictEqual(k('none'), 'binary')
    assert.strictEqual(k(undefined), 'binary')
    assert.strictEqual(k('/opt/custom/run-it'), 'run-it')
  })

  it('uses the version node processes report themselves, without probing', () => {
    let probes = 0
    const ri = new RuntimeInspector({ execFile: () => { probes++ }, env: { PATH: '/nonexistent' } })
    const r = ri.describe({ exec_interpreter: 'node', node_version: 'v22.19.0', exec_mode: 'cluster_mode', instances: 2, node_args: ['--max-old-space-size=512'], pm_exec_path: '/srv/a/index.js', pm_cwd: '/srv/a', NODE_ENV: 'production' })
    assert.strictEqual(r.kind, 'node')
    assert.strictEqual(r.version, '22.19.0')
    assert.strictEqual(r.versionSource, 'process')
    assert.deepStrictEqual(r.nodeArgs, ['--max-old-space-size=512'])
    assert.strictEqual(r.execMode, 'cluster_mode')
    assert.strictEqual(r.nodeEnv, 'production')
    assert.strictEqual(probes, 0)
  })

  it('probes other interpreters once, asynchronously, and detects virtualenvs', async () => {
    const root = fakeRoot()
    const calls = []
    const ri = new RuntimeInspector({
      env: { PATH: path.join(root, 'venv', 'bin') },
      execFile: (file, args, opts, cb) => { calls.push([file, args, opts.timeout]); setTimeout(() => cb(null, 'Python 3.8.10\n', ''), 5) }
    })
    const env = { exec_interpreter: 'python3', pm_exec_path: '/srv/led/server.py', args: ['--port', '8080'], interpreter_args: '-u' }
    const first = ri.describe(env)
    assert.strictEqual(first.version, null, 'never blocks on the probe')
    assert.strictEqual(first.interpreterPath, path.join(root, 'venv', 'bin', 'python3'))
    assert.strictEqual(first.virtualenv, path.join(root, 'venv'))
    assert.deepStrictEqual(first.args, ['--port', '8080'])
    assert.deepStrictEqual(first.interpreterArgs, ['-u'])
    ri.describe(env); ri.describe(env)
    await wait(20)
    assert.strictEqual(ri.describe(env).version, '3.8.10')
    assert.strictEqual(ri.describe(env).versionSource, 'interpreter')
    assert.strictEqual(calls.length, 1, 'one probe per interpreter')
    assert.deepStrictEqual(calls[0].slice(1), [['--version'], 3000])
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('reads versions printed on stderr (python 2, java)', async () => {
    const root = fakeRoot()
    const ri = new RuntimeInspector({ env: { PATH: path.join(root, 'venv', 'bin') }, execFile: (f, a, o, cb) => cb(null, '', 'Python 2.7.18\n') })
    ri.describe({ exec_interpreter: 'python3' })
    await wait(5)
    assert.strictEqual(ri.describe({ exec_interpreter: 'python3' }).version, '2.7.18')
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('never runs binaries or unrecognised interpreters', () => {
    const root = fakeRoot()
    let probes = 0
    const ri = new RuntimeInspector({ env: { PATH: path.join(root, 'venv', 'bin') }, execFile: () => { probes++ } })
    assert.strictEqual(ri.describe({ exec_interpreter: 'none', pm_exec_path: '/usr/local/bin/server' }).kind, 'binary')
    assert.strictEqual(ri.describe({ exec_interpreter: 'mywrapper' }).kind, 'mywrapper')
    assert.strictEqual(probes, 0)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('probes a real interpreter on this machine', async () => {
    // the running node binary, with no process-reported version, so it must be probed
    const ri = new RuntimeInspector()
    const env = { exec_interpreter: process.execPath, pm_cwd: os.tmpdir() }
    assert.strictEqual(ri.describe(env).version, null)
    await wait(1500)
    const r = ri.describe(env)
    // under bun the interpreter is bun, which reports its own version
    assert.strictEqual(r.version, process.versions.bun || process.versions.node)
    assert.strictEqual(r.versionSource, 'interpreter')
  })

  it('probes from the process working directory with its PATH (asdf/pyenv shims), per directory', async () => {
    const root = fakeRoot()
    const appA = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-app-a-'))
    const appB = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-app-b-'))
    const seen = []
    const ri = new RuntimeInspector({
      env: { PATH: '/agent/path', HOME: '/home/u' },
      execFile: (file, args, opts, cb) => {
        seen.push([opts.cwd, opts.env.PATH])
        // a shim that only has a version configured for app A's directory
        if (opts.cwd === appA) cb(null, 'Python 3.12.4\n', '')
        else cb(Object.assign(new Error('exit 126'), { code: 126 }), '', 'No version is set for command python3\nConsider adding: python 3.12.4\n')
      }
    })
    const procPath = path.join(root, 'venv', 'bin')
    ri.describe({ exec_interpreter: 'python3', pm_cwd: appA, env: { PATH: procPath } })
    ri.describe({ exec_interpreter: 'python3', pm_cwd: appB, env: { PATH: procPath } })
    await wait(5)
    assert.strictEqual(ri.describe({ exec_interpreter: 'python3', pm_cwd: appA, env: { PATH: procPath } }).version, '3.12.4')
    assert.strictEqual(ri.describe({ exec_interpreter: 'python3', pm_cwd: appB, env: { PATH: procPath } }).version, null,
      'an interpreter that fails in the app directory reports no version, not the shim error text')
    assert.deepStrictEqual(seen, [[appA, procPath], [appB, procPath]])
    for (const d of [root, appA, appB]) fs.rmSync(d, { recursive: true, force: true })
  })
})
