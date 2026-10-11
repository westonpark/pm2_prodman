/* eslint-env mocha */

'use strict'

const assert = require('assert')
const { PassThrough } = require('stream')
const DockerCollector = require('../../src/push/DockerCollector')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const frame = (stream, text) => {
  const payload = Buffer.from(text)
  const head = Buffer.alloc(8)
  head[0] = stream === 'err' ? 2 : 1
  head.writeUInt32BE(payload.length, 4)
  return Buffer.concat([head, payload])
}

/** a fake Docker API: containers by id, scripted stats, log streams we can write to */
function fakeDocker (containers) {
  const streams = {}
  let tick = 0
  const get = async (socket, path) => {
    if (path === '/version') return { Version: '29.1.3', ApiVersion: '1.52', Os: 'linux', Arch: 'amd64' }
    if (path.startsWith('/containers/json')) return containers.map(c => ({ Id: c.id + 'ffffffffffff', Names: ['/' + c.name], Image: c.image || 'img', State: c.state, Status: c.status || '', Created: 1700000000, Ports: c.ports || [], Labels: c.labels || {} }))
    const m = /^\/containers\/(\w+)\/(json|stats)/.exec(path)
    const c = containers.find(x => x.id === m[1])
    if (m[2] === 'json') return { RestartCount: c.restarts || 0, State: { StartedAt: '2026-10-11T08:00:00Z', ExitCode: c.exitCode || 0, Health: c.health ? { Status: c.health } : undefined }, Config: { Tty: !!c.tty }, HostConfig: { RestartPolicy: { Name: 'always' } } }
    tick++
    return { cpu_stats: { cpu_usage: { total_usage: tick * 2e8 }, system_cpu_usage: tick * 4e9, online_cpus: 4 }, memory_stats: { usage: 300e6, limit: 2e9, stats: { inactive_file: 100e6 } }, networks: { eth0: { rx_bytes: tick * 1000, tx_bytes: tick * 500 } } }
  }
  const stream = async (socket, path) => {
    const id = /containers\/(\w+)\/logs/.exec(path)[1]
    const s = new PassThrough()
    s.abort = () => s.destroy()
    s.path = path
    streams[id] = s
    return s
  }
  return { get, stream, streams }
}

function setup (containers, extra) {
  const sent = []
  const docker = fakeDocker(containers)
  let now = 1_000_000
  const c = new DockerCollector({}, { send: (channel, payload) => sent.push({ channel, payload }) }, {
    env: {}, get: docker.get, stream: docker.stream, exists: () => true, now: () => now, statusMs: 60000, ...(extra || {})
  })
  return { c, sent, docker, advance: ms => { now += ms } }
}

describe('prodman DockerCollector', function () {
  this.timeout(10000)

  it('picks the socket from PRODMAN_DOCKER / DOCKER_HOST', () => {
    assert.strictEqual(DockerCollector.socketPath({}), '/var/run/docker.sock')
    assert.strictEqual(DockerCollector.socketPath({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' }), '/run/user/1000/docker.sock')
    assert.strictEqual(DockerCollector.socketPath({ DOCKER_HOST: 'tcp://1.2.3.4:2375' }), null)
    assert.strictEqual(DockerCollector.socketPath({ PRODMAN_DOCKER: 'off' }), null)
    assert.strictEqual(DockerCollector.socketPath({ PRODMAN_DOCKER: 'unix:///tmp/d.sock' }), '/tmp/d.sock')
  })

  it('stays off when there is no docker socket', () => {
    const t = setup([], { exists: () => false })
    assert.strictEqual(t.c.start(), false)
    assert.strictEqual(t.sent.length, 0)
  })

  it('demultiplexes stdout/stderr frames across chunk boundaries, and raw TTY streams', () => {
    const lines = []
    const d = new DockerCollector.LogDemuxer(false, (s, l) => lines.push([s, l]))
    const all = Buffer.concat([frame('out', 'one\ntw'), frame('err', 'bad\n'), frame('out', 'o\n')])
    d.push(all.slice(0, 5)); d.push(all.slice(5, 13)); d.push(all.slice(13))
    assert.deepStrictEqual(lines, [['out', 'one'], ['err', 'bad'], ['out', 'two']])
    const tty = []
    const t = new DockerCollector.LogDemuxer(true, (s, l) => tty.push([s, l]))
    t.push(Buffer.from('a\r\nb\n'))
    assert.deepStrictEqual(tty, [['out', 'a'], ['out', 'b']])
  })

  it('parses docker timestamps and formats ports once per mapping', () => {
    assert.deepStrictEqual(DockerCollector.parseTimestamped('2026-10-11T09:00:00.123456789Z hello world', 5), { at: Date.parse('2026-10-11T09:00:00.123Z'), message: 'hello world' })
    assert.deepStrictEqual(DockerCollector.parseTimestamped('no stamp', 5), { at: 5, message: 'no stamp' })
    assert.deepStrictEqual(DockerCollector.formatPorts([{ IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }, { IP: '::', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }, { PrivatePort: 53, Type: 'udp' }]), ['8080->80/tcp', '53/udp'])
  })

  it('reports the engine and every container, with usage for running ones', async () => {
    const t = setup([
      { id: 'aaaaaaaaaaaa', name: 'web', state: 'running', status: 'Up 2 hours (healthy)', health: 'healthy', restarts: 3, ports: [{ PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }], labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.service': 'web' } },
      { id: 'bbbbbbbbbbbb', name: 'job', state: 'exited', status: 'Exited (1) 5 minutes ago', exitCode: 1, health: 'unhealthy' }
    ])
    t.c.socket = '/var/run/docker.sock'
    await t.c.poll()
    t.advance(10000)
    const p = await t.c.poll()
    assert.deepStrictEqual(p.engine, { available: true, version: '29.1.3', apiVersion: '1.52', os: 'linux', arch: 'amd64' })
    const [web, job] = p.containers
    assert.strictEqual(web.name, 'web')
    assert.strictEqual(web.health, 'healthy')
    assert.strictEqual(web.restartCount, 3)
    assert.deepStrictEqual(web.compose, { project: 'shop', service: 'web' })
    assert.deepStrictEqual(web.ports, ['8080->80/tcp'])
    assert.strictEqual(web.cpu, 20) // Δ2e8 / Δ4e9 × 4 cpus = 20%
    assert.strictEqual(web.memory, 200e6) // usage minus inactive file cache
    assert.strictEqual(web.memoryLimit, 2e9)
    assert.strictEqual(web.netRx, 100) // 1000 more bytes received over 10s
    assert.strictEqual(web.netTx, 50)
    assert.strictEqual(job.state, 'exited')
    assert.strictEqual(job.exitCode, 1)
    assert.strictEqual(job.health, null, 'health only counts while running')
    assert.strictEqual(job.cpu, null)
    assert.strictEqual(t.sent.filter(s => s.channel === 'docker:status').length, 2)
  })

  it('reports why the engine is unreachable', async () => {
    const t = setup([], { get: async () => { const e = new Error('connect EACCES'); e.code = 'EACCES'; throw e } })
    t.c.socket = '/var/run/docker.sock'
    const p = await t.c.poll()
    assert.strictEqual(p.engine.available, false)
    assert.ok(/docker group/.test(p.engine.error))
    assert.deepStrictEqual(p.containers, [])
  })

  it('follows running containers\' logs while logs are collected, batching them', async () => {
    const t = setup([{ id: 'aaaaaaaaaaaa', name: 'web', state: 'running' }, { id: 'bbbbbbbbbbbb', name: 'job', state: 'exited' }])
    t.c.socket = '/var/run/docker.sock'
    t.c.setLogsEnabled(true)
    await t.c.poll()
    await wait(5)
    assert.deepStrictEqual(Object.keys(t.docker.streams), ['aaaaaaaaaaaa'], 'only running containers are followed')
    assert.ok(/follow=1/.test(t.docker.streams.aaaaaaaaaaaa.path))
    t.docker.streams.aaaaaaaaaaaa.write(frame('out', '2026-10-11T09:00:01Z [INFO] up\n2026-10-11T09:00:02Z GET / 200\n'))
    t.docker.streams.aaaaaaaaaaaa.write(frame('err', '2026-10-11T09:00:03Z [ERROR] boom\n'))
    await wait(5)
    t.c.flush()
    const batch = t.sent.find(s => s.channel === 'docker:logs').payload
    assert.deepStrictEqual(batch.lines.map(l => [l.name, l.stream, l.message]), [['web', 'out', '[INFO] up'], ['web', 'out', 'GET / 200'], ['web', 'err', '[ERROR] boom']])
    assert.strictEqual(batch.lines[2].at, Date.parse('2026-10-11T09:00:03Z'))
    t.c.setLogsEnabled(false)
    assert.strictEqual(t.c.followers.size, 0)
  })

  it('resumes a log stream that ended from its last line, without repeats', async () => {
    const t = setup([{ id: 'aaaaaaaaaaaa', name: 'web', state: 'running' }])
    t.c.socket = '/var/run/docker.sock'
    t.c.setLogsEnabled(true)
    await t.c.poll()
    await wait(5)
    const first = t.docker.streams.aaaaaaaaaaaa
    first.write(frame('out', '2026-10-11T09:00:01Z one\n'))
    await wait(5)
    first.end()
    await wait(5)
    await t.c.poll()
    await wait(5)
    const second = t.docker.streams.aaaaaaaaaaaa
    assert.notStrictEqual(second, first)
    assert.ok(second.path.includes(`since=${(Date.parse('2026-10-11T09:00:01Z') / 1000).toFixed(3)}`))
    second.write(frame('out', '2026-10-11T09:00:01Z one\n2026-10-11T09:00:02Z two\n'))
    await wait(5)
    t.c.flush()
    const lines = t.sent.filter(s => s.channel === 'docker:logs').flatMap(s => s.payload.lines.map(l => l.message))
    assert.deepStrictEqual(lines, ['one', 'two'])
  })

  it('follows a container that started after collection began from its start, others from now', async () => {
    const t = setup([{ id: 'aaaaaaaaaaaa', name: 'old', state: 'running' }, { id: 'bbbbbbbbbbbb', name: 'new', state: 'running' }])
    t.c.socket = '/var/run/docker.sock'
    t.c.startedAt = Date.parse('2026-10-11T07:00:00Z') // 'old' started before (fake inspect: 08:00), so pretend collection began at 07:00
    t.c.setLogsEnabled(true)
    await t.c.poll()
    await wait(5)
    // fake inspect reports StartedAt 08:00 for both: after collection began → follow from 08:00
    assert.ok(t.docker.streams.bbbbbbbbbbbb.path.includes(`since=${(Date.parse('2026-10-11T08:00:00Z') / 1000).toFixed(3)}`))
    t.c.stop()
    const t2 = setup([{ id: 'aaaaaaaaaaaa', name: 'old', state: 'running' }])
    t2.c.socket = '/var/run/docker.sock'
    t2.c.startedAt = Date.parse('2026-10-11T09:00:00Z') // container started before collection: only new lines
    t2.c.setLogsEnabled(true)
    await t2.c.poll()
    await wait(5)
    assert.ok(t2.docker.streams.aaaaaaaaaaaa.path.includes(`since=${(1_000_000 / 1000).toFixed(3)}`))
  })

  it('caps a log burst per batch and counts the excess', () => {
    const t = setup([])
    for (let i = 0; i < 520; i++) t.c._push({ id: 'a', name: 'web', stream: 'out', at: i, message: 'x' })
    t.c.flush()
    const b = t.sent[0].payload
    assert.strictEqual(b.lines.length, 500)
    assert.strictEqual(b.dropped, 20)
  })
})
