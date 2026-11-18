/**
 * Host half of `dsh-token-usage-panel`.
 *
 * Responsibilities:
 *   1. Scan `$DSH_HOME/.credentials.yaml` on every start and find every API-key
 *      reference (`refs:` block), marking the ones unseen before as new.
 *   2. Map each key to the provider routes and model ids that consume it, by
 *      reading the profile patch layer (`apiKeyEnv:` inside a provider block).
 *   3. Query each key's balance from the provider that owns it
 *      (DeepSeek `/user/balance`, Moonshot `/v1/users/me/balance`).
 *   4. Serve all of that to the panel over same-origin routes, because the
 *      browser cannot call those hosts directly (no CORS, keys stay here):
 *
 *        GET  /plugins-api/token-usage/balance  → DeepSeek wallet for the chip
 *        GET  /plugins-api/token-usage/keys     → full key inventory
 *        POST /plugins-api/token-usage/key      → store a fallback key
 *
 * No service, tool, prompt, or model-visible surface is added.
 *
 * @module dsh-token-usage-panel
 */

import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

/** Cordis plugin name. */
export const name = 'dsh-token-usage-panel'

/** No hard service requirement: the web server is bound optionally below. */
export const inject = []

const BALANCE_ROUTE = '/plugins-api/token-usage/balance'
const KEYS_ROUTE = '/plugins-api/token-usage/keys'
const KEY_ROUTE = '/plugins-api/token-usage/key'
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'
const MOONSHOT_BALANCE_URL = 'https://api.moonshot.cn/v1/users/me/balance'
const CACHE_MS = 15000
const KEYS_CACHE_MS = 60000
const TIMEOUT_MS = 15000

/** `$DSH_HOME` with the usual fallback. */
function homeDir() {
  return process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
}

/** The harness-managed credential document. */
function credentialsPath() {
  return join(homeDir(), '.credentials.yaml')
}

/** This plugin's own state (fallback key + the names already announced). */
function stateFile() {
  return join(homeDir(), '.dsh-token-usage-panel.json')
}

/** The active profile's patch layer, where `apiKeyEnv` wiring lives. */
function profilePatchPath() {
  const profileDir = process.env.DSH_PROFILE_DIR
  if (profileDir !== undefined && profileDir !== '') return join(profileDir, 'cordis.patch.yml')
  return join(homeDir(), 'profiles', process.env.DSH_PROFILE ?? 'desktop', 'cordis.patch.yml')
}

//#region state document
/** Read this plugin's state document; a damaged file counts as empty. */
async function readState() {
  try {
    const parsed = JSON.parse(await readFile(stateFile(), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Merge into the state document, keeping the file owner-only. */
async function writeState(patch) {
  const path = stateFile()
  const next = { ...(await readState()), ...patch }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(next, null, 2), { mode: 0o600 })
  try {
    await chmod(path, 0o600)
  } catch {
    // Windows has no POSIX mode; the file still lives under the user's profile.
  }
  return next
}

/** The fallback key the panel may have stored. */
async function readStoredKey() {
  const state = await readState()
  return typeof state.apiKey === 'string' && state.apiKey.trim() !== '' ? state.apiKey.trim() : undefined
}
//#endregion

//#region credential scan
/** Mask a secret for display: `sk-1e9a…fcbe8`. */
function maskSecret(secret) {
  if (typeof secret !== 'string' || secret.length === 0) return '(empty)'
  if (secret.length <= 12) return secret.slice(0, 4) + '…'
  return secret.slice(0, 7) + '…' + secret.slice(-5)
}

/**
 * Read every API-key reference from the credential document's `refs:` block.
 * @returns `[{ name, secret }]` in file order.
 */
export async function scanCredentialRefs() {
  let text
  try {
    text = await readFile(credentialsPath(), 'utf8')
  } catch {
    return []
  }
  const refs = []
  let inRefs = false
  for (const raw of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(raw)) {
      inRefs = true
      continue
    }
    if (!inRefs) continue
    if (raw.trim() === '') continue
    const line = raw.match(/^\s{2}([\w.\-]+):\s*(\S+)\s*$/)
    if (line !== null) {
      refs.push({ name: line[1], secret: line[2] })
      continue
    }
    if (/^\S/.test(raw)) inRefs = false
  }
  return refs
}

/** Known provider shapes used when the patch layer says nothing. */
function inferProvider(name) {
  const upper = name.toUpperCase()
  if (upper.includes('DEEPSEEK')) {
    return [{ provider: 'deepseek-official', baseURL: 'https://api.deepseek.com', models: ['deepseek-chat', 'deepseek-reasoner'] }]
  }
  if (upper.includes('KIMI') || upper.includes('MOONSHOT')) {
    return [{ provider: 'moonshot', baseURL: 'https://api.moonshot.cn/v1', models: [] }]
  }
  return [{ provider: 'unknown', baseURL: undefined, models: [] }]
}

/**
 * Map `apiKeyEnv` names to the provider routes and model ids that consume them,
 * read from the profile patch layer.
 * @returns `Map<string, [{ provider, baseURL, models }]>`.
 */
export async function readProviderMap() {
  const map = new Map()
  let text
  try {
    text = await readFile(profilePatchPath(), 'utf8')
  } catch {
    return map
  }
  let provider
  let baseURL
  let models = []
  let inModels = false
  let inProviders = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ')
    if (/^\s{4}providers:\s*$/.test(line)) {
      inProviders = true
      provider = undefined
      baseURL = undefined
      models = []
      inModels = false
      continue
    }
    if (inProviders && (/^-/.test(line) || (line.trim() !== '' && /^\s{0,3}\S/.test(line)))) {
      inProviders = false
      provider = undefined
      inModels = false
    }
    const providerLine = inProviders ? line.match(/^\s{6}([\w.\-]+):\s*$/) : null
    if (providerLine !== null) {
      provider = providerLine[1]
      baseURL = undefined
      models = []
      inModels = false
      continue
    }
    const baseLine = line.match(/^\s{8}baseURL:\s*(\S+)/)
    if (baseLine !== null) {
      baseURL = baseLine[1]
      continue
    }
    if (/^\s{8}models:\s*$/.test(line)) {
      inModels = true
      continue
    }
    const modelLine = line.match(/^\s{10,}-\s+id:\s*(\S+)/)
    if (modelLine !== null && inModels) {
      models.push(modelLine[1])
      continue
    }
    const keyLine = line.match(/apiKeyEnv:\s*([\w.\-]+)/)
    if (keyLine !== null) {
      const entry = { provider: provider ?? 'deepseek-official', baseURL, models: models.slice() }
      const list = map.get(keyLine[1]) ?? []
      list.push(entry)
      map.set(keyLine[1], list)
    }
  }
  return map
}
//#endregion

//#region balances
/** DeepSeek wallet. */
async function readDeepSeekBalance(secret) {
  try {
    const response = await fetch(DEEPSEEK_BALANCE_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${secret}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    const text = await response.text()
    if (!response.ok) return { ok: false, status: response.status, error: `http ${response.status}: ${text.slice(0, 160)}` }
    const body = JSON.parse(text)
    const primary = Array.isArray(body?.balance_infos) ? body.balance_infos[0] : undefined
    if (primary === undefined) return { ok: false, error: 'no balance_infos' }
    return {
      ok: true,
      source: 'api.deepseek.com',
      currency: typeof primary.currency === 'string' ? primary.currency : 'CNY',
      total: Number(primary.total_balance),
      granted: Number(primary.granted_balance),
      toppedUp: Number(primary.topped_up_balance)
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Moonshot / Kimi wallet (`available_balance` is the spendable total). */
async function readMoonshotBalance(secret) {
  try {
    const response = await fetch(MOONSHOT_BALANCE_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${secret}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    const text = await response.text()
    if (!response.ok) return { ok: false, status: response.status, error: `http ${response.status}: ${text.slice(0, 160)}` }
    const body = JSON.parse(text)
    const data = body?.data
    if (data === undefined || data === null) return { ok: false, error: 'no data' }
    return {
      ok: true,
      source: 'api.moonshot.cn',
      currency: 'CNY',
      total: Number(data.available_balance),
      granted: Number(data.voucher_balance),
      toppedUp: Number(data.cash_balance)
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Query the balance from whichever known provider owns this key.
 * @param secret - the API key.
 * @param routes - provider entries mapped to the key.
 * @returns a balance payload with `ok`.
 */
async function readBalanceFor(secret, routes) {
  const tags = routes.map((route) => ((route.provider ?? '') + ' ' + (route.baseURL ?? '')).toLowerCase())
  if (tags.some((tag) => tag.includes('deepseek'))) return readDeepSeekBalance(secret)
  if (tags.some((tag) => tag.includes('moonshot') || tag.includes('kimi'))) return readMoonshotBalance(secret)
  return { ok: false, error: 'no balance endpoint for this provider' }
}
//#endregion

//#region inventory
let keysCache = { at: 0, value: undefined }

/**
 * Build the key inventory: every credential reference, the provider routes and
 * models that consume it, its balance, and whether it is new to this machine.
 * @returns `{ ok, scannedAt, credentials, profilePatch, keys }`.
 */
export async function scanKeys() {
  const refs = await scanCredentialRefs()
  const providers = await readProviderMap()
  const state = await readState()
  const known = Array.isArray(state.knownKeys) ? state.knownKeys.filter((entry) => typeof entry === 'string') : []
  const keys = []
  for (const ref of refs) {
    const routes = providers.get(ref.name) ?? inferProvider(ref.name)
    const seen = new Set()
    const providersListed = []
    for (const route of routes) {
      const provider = route.provider ?? 'unknown'
      const models = Array.isArray(route.models) ? route.models : []
      const fingerprint = provider + '|' + models.join(',')
      if (seen.has(fingerprint)) continue
      seen.add(fingerprint)
      providersListed.push({ provider, baseURL: route.baseURL, models })
    }
    const balance = ref.secret.length === 0 ? { ok: false, error: 'empty secret' } : await readBalanceFor(ref.secret, routes)
    keys.push({
      name: ref.name,
      masked: maskSecret(ref.secret),
      providers: providersListed,
      models: [...new Set(providersListed.flatMap((route) => route.models))],
      balance,
      isNew: !known.includes(ref.name)
    })
  }
  const names = keys.map((entry) => entry.name)
  if (names.some((name) => !known.includes(name))) await writeState({ knownKeys: [...new Set([...known, ...names])] })
  return {
    ok: true,
    scannedAt: Date.now(),
    credentials: credentialsPath(),
    profilePatch: profilePatchPath(),
    keys
  }
}

/** Cached inventory read for the route. */
async function keysPayload(force) {
  if (force !== true && keysCache.value !== undefined && Date.now() - keysCache.at < KEYS_CACHE_MS) return keysCache.value
  const value = await scanKeys()
  keysCache = { at: Date.now(), value }
  return value
}

/**
 * Resolve the key used for the chip's wallet: the credential reference that maps
 * to DeepSeek, else the panel-stored fallback key.
 * @returns the key, or undefined.
 */
async function resolveDeepSeekKey(ctx, config) {
  const direct = typeof config?.apiKey === 'string' ? config.apiKey.trim() : ''
  if (direct !== '') return direct
  const refs = await scanCredentialRefs()
  const mapped = refs.find((ref) => ref.name.toUpperCase().includes('DEEPSEEK'))
  if (mapped !== undefined && mapped.secret !== '') return mapped.secret
  const stored = await readStoredKey()
  if (stored !== undefined) return stored
  const refName = typeof config?.apiKeyEnv === 'string' && config.apiKeyEnv.trim() !== '' ? config.apiKeyEnv.trim() : 'DEEPSEEK_API_KEY'
  const fromEnv = process.env[refName]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    for (const ref of [refName, { name: refName }, { kind: 'reference', name: refName }]) {
      try {
        const hit = await credentials.resolve(ref)
        if (hit !== undefined && hit !== null && typeof hit.value === 'string' && hit.value.trim() !== '') return hit.value.trim()
      } catch {
        // Shape mismatch on this harness version: fall through.
      }
    }
  }
  return undefined
}
//#endregion

/** Read a small JSON request body without letting a client stream unbounded bytes. */
async function readJsonBody(req, limit = 4096) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Answer one request with JSON. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  })
  res.end(body)
}

/**
 * Cordis plugin body: scan credentials once, register the same-origin routes.
 * @param ctx - host plugin context.
 * @param config - optional `{ apiKey, apiKeyEnv }`.
 */
export function apply(ctx, config) {
  let walletCache = { at: 0, payload: undefined }

  const handleBalance = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      if (walletCache.payload !== undefined && Date.now() - walletCache.at < CACHE_MS) {
        sendJson(res, 200, walletCache.payload)
        return
      }
      const secret = await resolveDeepSeekKey(ctx, config)
      if (secret === undefined) {
        console.warn('[token-usage-panel] no DeepSeek API key: credentials=%s exists=%s', credentialsPath(), existsSync(credentialsPath()))
        sendJson(res, 200, { ok: false, error: 'no-key' })
        return
      }
      const balance = await readDeepSeekBalance(secret)
      if (balance.ok !== true) console.warn('[token-usage-panel] deepseek balance failed:', balance.error)
      const answer = {
        ok: balance.ok === true,
        source: balance.source,
        isAvailable: balance.ok === true,
        balances: balance.ok === true
          ? [{ currency: balance.currency ?? 'CNY', total: String(balance.total ?? 0), granted: String(balance.granted ?? 0), toppedUp: String(balance.toppedUp ?? 0) }]
          : [],
        error: balance.ok === true ? undefined : balance.error,
        at: Date.now()
      }
      walletCache = { at: Date.now(), payload: answer }
      sendJson(res, 200, answer)
    } catch (error) {
      console.warn('[token-usage-panel] balance route threw:', error instanceof Error ? error.message : String(error))
      sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error), at: Date.now() })
    }
  }

  const handleKeys = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://host.invalid')
      sendJson(res, 200, await keysPayload(url.searchParams.get('refresh') === '1'))
    } catch (error) {
      console.warn('[token-usage-panel] keys route threw:', error instanceof Error ? error.message : String(error))
      sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error), keys: [] })
    }
  }

  const handleKey = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const body = await readJsonBody(req)
      const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
      if (apiKey === '') {
        sendJson(res, 400, { ok: false, error: 'empty-key' })
        return
      }
      await writeState({ apiKey, savedAt: new Date().toISOString() })
      walletCache = { at: 0, payload: undefined }
      keysCache = { at: 0, value: undefined }
      sendJson(res, 200, { ok: true, stored: true, at: Date.now() })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error), at: Date.now() })
    }
  }

  // Startup scan: announce newly seen keys once, so the log records them.
  void scanKeys()
    .then((inventory) => {
      const names = inventory.keys.map((entry) => entry.name)
      const fresh = inventory.keys.filter((entry) => entry.isNew).map((entry) => entry.name)
      console.warn('[token-usage-panel] credential scan: %s keys [%s], new [%s]', names.length, names.join(', '), fresh.join(', '))
    })
    .catch((error) => console.warn('[token-usage-panel] credential scan failed:', error instanceof Error ? error.message : String(error)))

  // The web server may mount after this plugin, so bind on the service.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: BALANCE_ROUTE, handler: handleBalance }), 'token-usage-panel: balance route')
    webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: KEYS_ROUTE, handler: handleKeys }), 'token-usage-panel: keys route')
    webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: KEY_ROUTE, handler: handleKey }), 'token-usage-panel: key route')
    console.warn('[token-usage-panel] routes registered:', BALANCE_ROUTE, KEYS_ROUTE, KEY_ROUTE)
  })
}
