/**
 * pm2 deploy: the vendored pm2-deploy module (modules/pm2-deploy). The deploy shell script is
 * replaced by a stub that records the JSON config it receives on stdin and its arguments.
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const deploy = require('../../modules/pm2-deploy')

describe('pm2 deploy (vendored pm2-deploy)', function () {
  this.timeout(10000)
  const realScript = deploy.script
  let dir, out

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-deploy-'))
    out = path.join(dir, 'calls.log')
    const stub = path.join(dir, 'deploy')
    // one line per call: the config JSON, then the arguments; exit 3 when asked to fail
    fs.writeFileSync(stub, `#!/bin/sh\nread -r config\necho "$config ARGS:$*" >> "${out}"\n[ "$1" = "fail" ] && exit 3\nexit 0\n`, { mode: 0o755 })
    deploy.script = stub
  })
  after(() => {
    deploy.script = realScript
    fs.rmSync(dir, { recursive: true, force: true })
  })
  beforeEach(() => fs.rmSync(out, { force: true }))

  const calls = () => fs.readFileSync(out, 'utf8').trim().split('\n').map((line) => {
    const i = line.lastIndexOf(' ARGS:')
    return { config: JSON.parse(line.slice(0, i)), args: line.slice(i + 6) }
  })
  const base = { user: 'node', host: 'web1', repo: 'git@example.com:app.git', path: '/srv/app', ref: 'origin/main' }

  it('ships the deploy script, executable', () => {
    const st = fs.statSync(realScript)
    assert.ok(st.isFile())
    assert.ok(st.mode & 0o111, 'deploy script is executable')
  })

  it('validates the environment like pm2-deploy (tv4) did', () => {
    assert.strictEqual(deploy.validate(base), null)
    assert.strictEqual(deploy.validate({}).message, 'Missing required property: host')
    assert.strictEqual(deploy.validate({ host: 'h', repo: 'r', path: 'p' }).message, 'Missing required property: ref')
    const t = deploy.validate({ ...base, host: 1 })
    assert.strictEqual(t.message, 'Invalid type: number (expected string/array)')
    assert.strictEqual(t.dataPath, '/host')
    assert.strictEqual(deploy.validate({ ...base, user: '' }).message, 'String is too short (0 chars), minimum 1')
    assert.strictEqual(deploy.validate({ ...base, fetch: 2 }).dataPath, '/fetch')
    assert.strictEqual(deploy.validate({ ...base, host: ['a', 'b'] }), null)
  })

  it('prefixes post-deploy with the environment', () => {
    assert.strictEqual(deploy.prependEnv('npm i', { node_env: 'production', port: 80 }), 'export NODE_ENV=production PORT=80 && npm i')
    assert.strictEqual(deploy.prependEnv(undefined, { a: 1 }), 'export A=1')
    assert.strictEqual(deploy.prependEnv('npm i', {}), 'npm i')
  })

  it('runs tasks in series and stops at the first error', (done) => {
    const order = []
    deploy.series([
      cb => setTimeout(() => { order.push(1); cb(null, 'a') }, 10),
      cb => { order.push(2); cb(new Error('boom'), 'b') },
      cb => { order.push(3); cb(null, 'c') }
    ], (err, results) => {
      assert.strictEqual(err.message, 'boom')
      assert.deepStrictEqual(order, [1, 2])
      assert.deepStrictEqual(results, ['a', 'b'])
      done()
    })
  })

  it('refuses an unknown or invalid environment', (done) => {
    deploy.deployForEnv({ production: base }, 'staging', [], (err) => {
      assert.strictEqual(err.message, 'staging not defined in deploy section')
      deploy.deployForEnv({ production: { ...base, ref: undefined } }, 'production', [], (err2) => {
        assert.strictEqual(err2.message, 'Missing required property: ref')
        assert.ok(!fs.existsSync(out), 'nothing ran')
        done()
      })
    })
  })

  it('deploys to one host with the config on stdin and the arguments', (done) => {
    const env = { production: { ...base, path: 'relative/app', env: { NODE_ENV: 'production' }, 'post-deploy': 'npm ci', ssh_options: ['StrictHostKeyChecking=no', 'PasswordAuthentication=no'] } }
    deploy.deployForEnv(env, 'production', ['setup'], (err, result) => {
      assert.ifError(err)
      assert.deepStrictEqual(result, ['setup'])
      const [call] = calls()
      assert.strictEqual(call.args, 'setup')
      assert.strictEqual(call.config.host, 'web1')
      assert.strictEqual(call.config.path, path.resolve('relative/app'))
      assert.strictEqual(call.config['post-deploy'], 'export NODE_ENV=production && npm ci')
      assert.strictEqual(call.config.ssh_options, '-o StrictHostKeyChecking=no -o PasswordAuthentication=no')
      done()
    })
  })

  it('deploys host after host, one result per host', (done) => {
    deploy.deployForEnv({ production: { ...base, host: ['web1', 'web2'] } }, 'production', [], (err, result) => {
      assert.ifError(err)
      assert.strictEqual(result.length, 2)
      assert.deepStrictEqual(calls().map(c => c.config.host), ['web1', 'web2'])
      done()
    })
  })

  it('reports the exit code when the deploy script fails, and stops', (done) => {
    deploy.deployForEnv({ production: { ...base, host: ['web1', 'web2'] } }, 'production', ['fail'], (err) => {
      assert.strictEqual(err.message, 'Deploy failed with exit code: 3')
      assert.strictEqual(err.code, 3)
      assert.strictEqual(calls().length, 1, 'the second host was not attempted')
      done()
    })
  })
})
