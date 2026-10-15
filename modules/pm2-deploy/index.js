'use strict'

/**
 * `pm2 deploy`: deploy an app over SSH to the hosts of an ecosystem file's `deploy` section.
 *
 * Vendored from pm2-deploy 1.0.2 (MIT, Alexandre Strzelewicz; see LICENSE), which wraps the
 * `deploy` shell script (a modified visionmedia/deploy). Its two dependencies are replaced:
 * run-series by `series` below, and tv4 (a full JSON-schema validator) by `validate`, which
 * checks the same schema in the same order with the same error messages.
 */

const childProcess = require('child_process')
const format = require('util').format
const path = require('path')

/** the deploy shell script (overridable for tests) */
exports.script = path.join(__dirname, 'deploy')

/** fields of one environment's deploy config: required ones, and the type of each */
const REQUIRED = ['host', 'repo', 'path', 'ref']
const PROPERTIES = {
  user: { types: ['string'], minLength: 1 },
  host: { types: ['string', 'array'] },
  repo: { types: ['string'] },
  path: { types: ['string'] },
  ref: { types: ['string'] },
  fetch: { types: ['string'] }
}

const typeOf = v => Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v

function validationError (message, dataPath) {
  const err = new Error(message)
  err.dataPath = dataPath
  return err
}

/**
 * Check an environment's config: the first problem as an Error (message and dataPath as tv4
 * reported them), or null when valid.
 */
function validate (config) {
  if (typeOf(config) !== 'object') return validationError(format('Invalid type: %s (expected object)', typeOf(config)), '')
  for (const key of REQUIRED) {
    if (config[key] === undefined) return validationError(format('Missing required property: %s', key), '')
  }
  for (const key of Object.keys(PROPERTIES)) {
    const value = config[key]
    if (value === undefined) continue
    const rule = PROPERTIES[key]
    if (!rule.types.includes(typeOf(value))) {
      return validationError(format('Invalid type: %s (expected %s)', typeOf(value), rule.types.join('/')), '/' + key)
    }
    if (rule.minLength !== undefined && value.length < rule.minLength) {
      return validationError(format('String is too short (%d chars), minimum %d', value.length, rule.minLength), '/' + key)
    }
  }
  return null
}

/** run async tasks one after another; cb(err, results) after the last, or the first error */
function series (tasks, cb) {
  const results = []
  let current = 0
  let sync = true
  const done = (err) => sync ? process.nextTick(() => cb(err, results)) : cb(err, results)
  const each = (err, result) => {
    results.push(result)
    if (++current >= tasks.length || err) done(err)
    else tasks[current](each)
  }
  if (tasks.length > 0) tasks[0](each)
  else done(null)
  sync = false
}

/**
 * Run the deploy script for one host: the config is piped to it as JSON, `args` (the
 * command, e.g. `setup`, `revert 1`) are passed as its arguments.
 */
function spawn (config, args, cb) {
  let cmd = format('echo \'%j\' | "%s"', config, exports.script)
  args = args || []
  if (args.length > 0) cmd = [cmd, args.map(arg => format('"%s"', arg)).join(' ')].join(' ')

  const proc = childProcess.spawn('sh', ['-c', cmd], { stdio: 'inherit' })
  let error
  proc.on('error', (err) => { error = err })
  proc.on('close', (code) => {
    if (code === 0) return cb(null, args)
    error = error || new Error(format('Deploy failed with exit code: %s', code))
    error.code = code
    return cb(error)
  })
}

const clone = obj => JSON.parse(JSON.stringify(obj))
const castArray = arg => Array.isArray(arg) ? arg : [arg]

const envToString = env => Object.keys(env || {}).map(name => format('%s=%s', name.toUpperCase(), env[name])).join(' ')

/** prefix a command with `export NAME=value…` for the environment's `env` */
function prependEnv (cmd, env) {
  const vars = envToString(env)
  if (!vars) return cmd
  if (!cmd) return format('export %s', vars)
  return format('export %s && %s', vars, cmd)
}

/**
 * Deploy to one environment of a deploy config, host after host.
 * @param {object} deployConfig the `deploy` section: { [env]: { user, host, repo, path, ref, … } }
 * @param {string} env the environment to deploy
 * @param {array} args deploy command-line arguments
 * @param {function} cb (err, args — or one per host when `host` is a list)
 * @returns {boolean} always false
 */
function deployForEnv (deployConfig, env, args, cb) {
  if (!deployConfig[env]) return cb(new Error(format('%s not defined in deploy section', env)))

  const envConfig = clone(deployConfig[env])
  if (envConfig.ssh_options) {
    envConfig.ssh_options = castArray(envConfig.ssh_options).map(option => format('-o %s', option)).join(' ')
  }

  const invalid = validate(envConfig)
  if (invalid) return cb(invalid)

  if (process.env.NODE_ENV !== 'test') console.log('--> Deploying to %s environment', env)
  if (process.platform !== 'win32') envConfig.path = path.resolve(envConfig.path)

  const jobs = castArray(envConfig.host).map(host => function job (done) {
    if (process.env.NODE_ENV !== 'test') console.log('--> on host %s', host.host ? host.host : host)
    const config = clone(envConfig)
    config.host = host
    config['post-deploy'] = prependEnv(config['post-deploy'], config.env)
    spawn(config, args, done)
  })
  series(jobs, (err, result) => cb(err, Array.isArray(envConfig.host) ? result : result[0]))
  return false
}

exports.deployForEnv = deployForEnv
exports.validate = validate
exports.prependEnv = prependEnv
exports.series = series
