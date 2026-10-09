'use strict'

/**
 * Prodman CLI flows (replaces the PM2.io / Keymetrics OAuth flows)
 *
 *   pm2 plus | pm2 login | pm2 register   -> prompt URL, email, password, pick/create a bucket, link
 *   pm2 plus create                        -> create a new bucket and link to it
 *   pm2 plus web                           -> open the prodman dashboard of the linked bucket
 *   pm2 logout                             -> delete ~/.pm2/prodman-token
 */

const cst = require('../../../constants.js')
const chalk = require('ansis')
const os = require('os')
const readline = require('readline')
const Table = require('cli-tableau')
const pkg = require('../../../package.json')
const promptly = require('../../tools/prompt')
const prodman = require('./prodman.js')
const execFile = require('child_process').execFile

const MSG = chalk.cyan('[Prodman]')
const MSG_ERR = chalk.red('[Prodman]')

const isTTY = () => !!process.stdin.isTTY

/**
 * Non-TTY stdin (e.g. `printf 'url\nemail\npw\n1\n' | pm2 plus`): a single shared
 * line reader, since one readline interface per prompt would swallow the piped input.
 */
let pipedReader = null
const readPipedLine = (message) => {
  if (!pipedReader) {
    const rl = readline.createInterface({ input: process.stdin, terminal: false })
    pipedReader = { lines: [], waiters: [], closed: false }
    rl.on('line', line => {
      if (pipedReader.waiters.length) return pipedReader.waiters.shift()(line)
      pipedReader.lines.push(line)
    })
    rl.on('close', () => {
      pipedReader.closed = true
      pipedReader.waiters.splice(0).forEach(w => w(null))
    })
  }
  process.stdout.write(message)
  return new Promise((resolve, reject) => {
    const done = (line) => {
      if (line === null) return reject(new Error('No more input on stdin'))
      process.stdout.write('\n')
      return resolve(line)
    }
    if (pipedReader.lines.length) return done(pipedReader.lines.shift())
    if (pipedReader.closed) return done(null)
    pipedReader.waiters.push(done)
  })
}

const readLine = (message) => {
  if (!isTTY()) return readPipedLine(message)
  return new Promise((resolve, reject) => {
    promptly.prompt(message, (err, answer) => err ? reject(err) : resolve(answer))
  })
}

const ask = async (message, defaultValue) => {
  const suffix = defaultValue ? ` [${defaultValue}]` : ''
  const answer = ((await readLine(`${MSG} ${message}${suffix}: `)) || '').trim()
  return answer || defaultValue || ''
}

const askPassword = (message) => {
  if (!isTTY() || typeof process.stdin.setRawMode !== 'function') {
    return readLine(`${MSG} ${message}: `).then(answer => answer || '')
  }
  return new Promise((resolve, reject) => {
    promptly.password(`${MSG} ${message}: `, { replace: '*' }, (err, answer) => err ? reject(err) : resolve(answer || ''))
  })
}

const choose = async (message, choices) => {
  console.log(choices.map((c, i) => `  ${i + 1}) ${c}`).join('\n'))
  for (;;) {
    const answer = ((await readLine(`${MSG} ${message} `)) || '').trim()
    const idx = parseInt(answer, 10)
    if (String(idx) === answer && idx >= 1 && idx <= choices.length) return choices[idx - 1]
    if (choices.indexOf(answer) !== -1) return answer
    console.log(`${MSG_ERR} Invalid choice`)
  }
}

module.exports = class PM2ioHandler {
  static usePM2Client (instance) {
    this.pm2 = instance
  }

  static launch (command, opts) {
    let run
    switch (command) {
      case 'connect':
      case 'login':
      case 'register':
      case 'link':
      case undefined:
      case 'authenticate':
        run = this.authenticateAndLink()
        break
      case 'create':
        run = this.authenticateAndLink({ create: true })
        break
      case 'logout':
        run = this.logout()
        break
      case 'web':
      case 'open':
        return this.pm2.openDashboard()
      case 'help':
      case 'welcome':
        this.printHelp()
        return process.exit(0)
      default:
        console.log(`${MSG_ERR} Invalid command ${command}, available: login, register, connect, create, web, logout, help`)
        return process.exit(1)
    }

    run.catch(err => {
      console.error(`${MSG_ERR} ${err.message || err}`)
      return process.exit(1)
    })
  }

  static printHelp () {
    console.log(`
${chalk.bold('Prodman')} - self-hosted PM2 monitoring

  ${chalk.bold('pm2 plus')} / ${chalk.bold('pm2 login')}            log in to prodman, pick or create a bucket and link this machine
  ${chalk.bold('pm2 plus create')}                create a new bucket and link this machine to it
  ${chalk.bold('pm2 link <secret> <public> [name]')}  link with bucket keys (no login)
  ${chalk.bold('pm2 open')}                       open the dashboard of the linked bucket
  ${chalk.bold('pm2 unlink')}                     stop the agent and forget the link
  ${chalk.bold('pm2 logout')}                     delete the stored CLI token (${prodman.tokenPath()})

  Server URL: PRODMAN_URL env var or --info-node <url> (default ${prodman.DEFAULT_URL})
`)
  }

  static async logout () {
    const deleted = prodman.deleteToken()
    console.log(`${MSG} ${deleted ? 'Successfully logged out' : 'Already logged out'}`)
    console.log(`${MSG} The agent stays linked; use \`pm2 unlink\` to stop it`)
    return process.exit(0)
  }

  /**
   * Get a valid token for `url`: reuse the stored one if it still works, otherwise
   * prompt for email / password and POST /api/cli/login
   * @return {Promise<{token, buckets?}>}
   */
  static async getSession (url) {
    const stored = prodman.readToken()
    if (stored && stored.token && (!stored.url || prodman.normalizeUrl(stored.url) === url)) {
      try {
        const buckets = await prodman.listBuckets(url, stored.token)
        console.log(`${MSG} Using stored session${stored.email ? ` (${stored.email})` : ''}`)
        return { token: stored.token, buckets: buckets }
      } catch (err) {
        if (err.status !== 401 && err.status !== 403) throw err
        console.log(`${MSG} Stored session expired, please log in again`)
      }
    }

    const email = await ask('Email')
    if (!email) throw new Error('Email is required')
    const password = await askPassword('Password')
    if (!password) throw new Error('Password is required')

    let res
    try {
      res = await prodman.login(url, email, password)
    } catch (err) {
      if (err.status === 401 || err.status === 403) throw new Error(`Login failed: ${err.message}`)
      throw err
    }
    if (!res || !res.token) throw new Error('Login failed: no token returned by prodman')

    prodman.writeToken({
      url: url,
      token: res.token,
      email: (res.user && res.user.email) || email,
      created_at: new Date().toISOString()
    })
    console.log(`${MSG} Logged in as ${(res.user && (res.user.name || res.user.email)) || email}`)
    return { token: res.token }
  }

  static async authenticateAndLink (opts) {
    opts = opts || {}
    const url = prodman.normalizeUrl(await ask('Prodman URL', prodman.defaultUrl()))
    const session = await this.getSession(url)
    const token = session.token

    let bucket = null
    if (opts.create) {
      bucket = await this.createBucket(url, token)
    } else {
      const buckets = session.buckets || await prodman.listBuckets(url, token) || []
      bucket = await this.pickBucket(url, token, buckets)
    }

    if (!bucket) {
      console.log(`${MSG} No bucket selected, nothing linked`)
      return process.exit(0)
    }
    return this.linkBucket(url, bucket)
  }

  static async createBucket (url, token) {
    const name = await ask('New bucket name', os.hostname())
    const bucket = await prodman.createBucket(url, token, name)
    console.log(`${MSG} Bucket ${chalk.bold(bucket.name)} created`)
    return bucket
  }

  static async pickBucket (url, token, buckets) {
    if (!Array.isArray(buckets) || buckets.length === 0) {
      console.log(`${MSG} No bucket found, let's create one`)
      return this.createBucket(url, token)
    }

    const table = new Table({
      style: { 'padding-left': 1, head: ['cyan', 'bold'], compact: true },
      head: ['Bucket name', 'Public key']
    })
    buckets.forEach(bucket => table.push([bucket.name, bucket.publicKey]))
    console.log(table.toString())

    const NEW = '(create a new bucket)'
    const NONE = '(none)'
    const choices = buckets.map(bucket => bucket.name).concat([NEW, NONE])
    const value = await choose('Type the name or number of the bucket to link to:', choices)

    if (value === NONE) return null
    if (value === NEW) return this.createBucket(url, token)
    return buckets.find(bucket => bucket.name === value) || null
  }

  static linkBucket (url, bucket) {
    return new Promise((resolve) => {
      if (!bucket.publicKey || !bucket.secretKey) {
        throw new Error('Bucket keys missing in prodman response')
      }
      // make sure the agent (and agent.json5) use the URL the user just chose
      process.env.PRODMAN_URL = url
      process.env.KEYMETRICS_NODE = url

      this.pm2.link({
        public_key: bucket.publicKey,
        secret_key: bucket.secretKey,
        info_node: url,
        pm2_version: pkg.version
      }, (err) => {
        if (err) {
          console.error(`${MSG_ERR} Failed to link: ${err.message || err}`)
          console.error(`${MSG_ERR} You can retry with: PRODMAN_URL=${url} pm2 link ${bucket.secretKey} ${bucket.publicKey}`)
          return process.exit(1)
        }
        console.log(`${MSG} Linked to bucket ${chalk.bold(bucket.name)}`)
        console.log(`${MSG} Dashboard: ${chalk.bold(prodman.dashboardUrl({ info_node: url, public_key: bucket.publicKey }))}`)
        resolve()
        return process.exit(0)
      })
    })
  }

  static open (target, appName, callback) {
    if (typeof (appName) === 'function') {
      callback = appName
      appName = null
    }

    let cmd
    let args = []

    switch (process.platform) {
      case 'darwin': {
        cmd = 'open'
        if (appName) args.push('-a', appName)
        args.push(target)
        break
      }
      case 'win32': {
        cmd = 'cmd'
        args = ['/c', 'start', '""']
        if (appName) args.push(appName)
        args.push(target)
        break
      }
      default: {
        cmd = appName || 'xdg-open'
        args.push(target)
        break
      }
    }

    if (process.env.SUDO_USER) {
      if (!/^[a-zA-Z0-9._-]+$/.test(process.env.SUDO_USER)) {
        return callback && callback(new Error('Invalid SUDO_USER'))
      }
      args = ['-u', process.env.SUDO_USER, cmd].concat(args)
      cmd = 'sudo'
    }

    return execFile(cmd, args, callback)
  }
}
