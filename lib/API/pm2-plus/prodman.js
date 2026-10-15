'use strict'

/**
 * Prodman helpers shared by the CLI (pm2 plus / login / logout / open / ls)
 * Prodman is a self-hosted replacement for PM2.io / Keymetrics.
 */

const fs = require('fs')
const cst = require('../../../constants.js')
const agentCst = require('../../../modules/pm2-io-agent/constants.js')

const DEFAULT_URL = agentCst.DEFAULT_ROOT_URL

/**
 * Keep an explicit scheme (http allowed), add one if missing, strip trailing slashes
 */
function normalizeUrl (url) {
  return agentCst.normalizeRootUrl(url)
}

/**
 * Default prodman URL: PRODMAN_URL > KEYMETRICS_NODE (--info-node) > http://localhost:8070
 */
function defaultUrl () {
  return normalizeUrl(process.env.PRODMAN_URL || process.env.KEYMETRICS_NODE || DEFAULT_URL)
}

/**
 * Prodman dashboard URL for a linked agent configuration (agent.json5 content)
 * @param {Object} infos { public_key, info_node }
 */
function dashboardUrl (infos) {
  infos = infos || {}
  let root = infos.info_node
  if (!root || /keymetrics\.io|pm2\.io/.test(root)) root = defaultUrl()
  return `${normalizeUrl(root)}/r/${infos.public_key}`
}

function tokenPath () {
  return cst.PRODMAN_TOKEN_PATH
}

/**
 * @return {Object|null} { url, token, email }
 */
function readToken () {
  try {
    const content = fs.readFileSync(tokenPath()).toString().trim()
    if (!content) return null
    try {
      const data = JSON.parse(content)
      if (data && data.token) return data
    } catch (e) {
      // plain token file
      return { token: content, url: null }
    }
  } catch (e) {}
  return null
}

function writeToken (data) {
  fs.writeFileSync(tokenPath(), JSON.stringify(data, null, 2), { mode: 0o600 })
  try {
    fs.chmodSync(tokenPath(), 0o600)
  } catch (e) {}
}

/**
 * @return {Boolean} true if a token file was deleted
 */
function deleteToken () {
  try {
    fs.unlinkSync(tokenPath())
    return true
  } catch (e) {
    return false
  }
}

/**
 * Minimal JSON API client
 * @param {String} baseUrl prodman URL
 * @param {String} method
 * @param {String} route e.g. /api/cli/buckets
 * @param {Object} [body]
 * @param {String} [token] bearer token
 * @return {Promise<Object>} parsed JSON; rejects with err.status on HTTP errors
 */
async function request (baseUrl, method, route, body, token) {
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`

  let res
  try {
    res = await fetch(normalizeUrl(baseUrl) + route, {
      method: method,
      headers: headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
  } catch (e) {
    const err = new Error(`Cannot reach prodman at ${baseUrl}: ${(e.cause && e.cause.message) || e.message}`)
    err.status = 0
    throw err
  }

  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch (e) {
    data = null
  }

  if (!res.ok) {
    const msg = (data && (data.message || data.statusMessage || data.msg || data.error)) || res.statusText || `HTTP ${res.status}`
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
    err.status = res.status
    throw err
  }
  return data
}

module.exports = {
  DEFAULT_URL,
  normalizeUrl,
  defaultUrl,
  dashboardUrl,
  tokenPath,
  readToken,
  writeToken,
  deleteToken,
  request,
  // browser sign-in: start, then poll until the user approves the code in prodman
  startLogin: (url, hostname) => request(url, 'POST', '/api/cli/auth', { hostname }),
  pollLogin: (url, deviceCode) => request(url, 'POST', '/api/cli/auth/poll', { deviceCode }),
  me: (url, token) => request(url, 'GET', '/api/me', undefined, token),
  listBuckets: (url, token) => request(url, 'GET', '/api/cli/buckets', undefined, token),
  createBucket: (url, token, name, orgId) => request(url, 'POST', '/api/cli/buckets', orgId ? { name, orgId } : { name }, token)
}
