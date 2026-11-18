// Render smoke test for client.js.
//
// Loads the browser bundle with a stub React, calls the chip and the panel with
// representative props, and fails on any thrown error (undefined identifiers,
// bad destructuring, wrong helper names). This catches the class of bug a syntax
// check cannot: a refactor that leaves a stale variable behind.
//
//   node tests/render-smoke.mjs
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'client.js')
const source = fs.readFileSync(bundlePath, 'utf8')

let captured
globalThis.window = {
  __ModuleLoader__: { load: (definition) => { captured = definition } },
  localStorage: (() => {
    const store = new Map()
    return {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
      removeItem: (key) => store.delete(key)
    }
  })(),
  innerWidth: 1280,
  innerHeight: 900,
  addEventListener: () => {},
  removeEventListener: () => {}
}
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} }

new Function('window', source)(globalThis.window)

const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: () => ({ current: null }),
  memo: (component) => component
}
const requireStub = (name) => (name === 'react' ? react : { createPortal: (node) => node })
const module = captured.factory(requireStub)

const t = (key, params) => (params === undefined ? key : key + ' ' + JSON.stringify(params))

const projection = {
  tokenUsage: { uncachedInputTokens: 1200, cacheReadTokens: 3400000, cacheWriteTokens: 0, outputTokens: 56000 },
  contextPressure: { pressureTokens: 43000, projectedTokens: 44000, contextWindow: 262144 },
  contextBreakdown: { systemTokens: 7000, toolsTokens: 7000, messageTokens: 29000 },
  sessionStats: { turns: 5, steps: 15, llmMs: 120000, toolMs: 80000, ttftMs: 4000, ttftSteps: 5, decodeMs: 60000, decodeTokens: 56000 },
  modelSelection: { next: { provider: 'kimi-coding', model: 'kimi-k2' }, lastUsed: { provider: 'kimi-coding', model: 'kimi-k2' } }
}

const inventory = {
  status: 'ready',
  scannedAt: Date.now(),
  keys: [
    {
      name: 'DEEPSEEK_API_KEY',
      masked: 'sk-1e9a…fcbe8',
      models: ['deepseek-flash', 'deepseek-reasoner'],
      providers: [{ provider: 'deepseek', baseURL: 'https://api.deepseek.com' }],
      balance: { ok: true, currency: 'CNY', total: 120.00, granted: 0, toppedUp: 120.00, source: 'api.deepseek.com' },
      isNew: false
    },
    {
      name: 'KIMI_CODING_API_KEY',
      masked: 'sk-bopY…rJTIP',
      models: ['kimi-k2', 'kimi-k2-0905', 'kimi-k2'],
      providers: [{ provider: 'kimi-coding', baseURL: 'https://api.moonshot.cn/v1' }],
      balance: { ok: true, currency: 'CNY', total: 45.00, granted: 0, toppedUp: 45.00, source: 'api.moonshot.cn' },
      isNew: true
    }
  ]
}

const usageSummary = {
  status: 'ready',
  totals: { sessions: 6, included: 6, usage: { uncachedInput: 200000, cacheRead: 32000000, cacheWrite: 0, output: 200000, billedInput: 32200000, total: 32400000, cacheHit: 99 } },
  rows: [{ id: 'session-example', title: 'panel', usage: { uncachedInput: 1200, cacheRead: 3400000, cacheWrite: 0, output: 56000, billedInput: 3401200, total: 3457200, cacheHit: 99 } }]
}

const props = {
  t,
  useProjection: (key) => projection[key],
  useSession: (select) => select({ running: true }),
  useUsageSummary: (select) => select(usageSummary),
  useKeyInventory: (select) => select(inventory),
  ensureUsage: () => {},
  ensureKeyInventory: () => {},
  refreshUsage: () => {},
  refreshKeyInventory: () => {}
}

const failures = []
const check = (label, run) => {
  try {
    run()
    console.log('ok   ', label)
  } catch (error) {
    failures.push(label + ': ' + error.message)
    console.log('FAIL ', label, '->', error.message)
  }
}

check('dictionaries agree', () => {
  const zh = Object.keys(module.dictionaries.zh).sort()
  const en = Object.keys(module.dictionaries.en).sort()
  const missing = zh.filter((key) => !en.includes(key))
  const extra = en.filter((key) => !zh.includes(key))
  if (missing.length > 0 || extra.length > 0) throw new Error('zh/en mismatch: missing=' + missing + ' extra=' + extra)
})

check('every t() key exists', () => {
  const used = [...source.matchAll(/\bt\("([a-zA-Z][a-zA-Z.]*)"/g)].map((match) => match[1])
  const unknown = [...new Set(used)].filter((key) => !(key in module.dictionaries.zh))
  if (unknown.length > 0) throw new Error('missing keys: ' + unknown.join(', '))
})

check('chip renders', () => {
  const node = module.TokenUsageAction(props)
  if (node === null || node === undefined) throw new Error('chip returned nothing')
})

check('panel renders', () => {
  const wallets = module.deriveWallets(inventory)
  const picked = module.walletForSelection(wallets, projection.modelSelection)
  module.UsagePanel({
    t,
    usage: module.deriveUsage(projection.tokenUsage),
    context: module.deriveContext(projection.contextPressure),
    breakdown: module.deriveBreakdown(projection.contextBreakdown),
    speed: module.deriveSpeed(projection.sessionStats),
    wallet: picked.wallet,
    wallets,
    totals: usageSummary.totals,
    sessions: usageSummary.rows,
    keyInventory: inventory,
    model: 'kimi-coding/k3'
  })
})

check('panel renders without a wallet', () => {
  module.UsagePanel({ t, keyInventory: { status: 'failed', keys: [], error: 'no-key' } })
})

check('wallet matching', () => {
  const wallets = module.deriveWallets(inventory)
  const cases = [
    [{ next: { provider: 'deepseek-account', model: 'deepseek-flash' } }, 'DEEPSEEK_API_KEY'],
    [{ next: { provider: 'kimi-coding', model: 'kimi-k2' } }, 'KIMI_CODING_API_KEY'],
    [{ next: { provider: 'moonshot', model: 'unknown' } }, 'KIMI_CODING_API_KEY']
  ]
  for (const [selection, expected] of cases) {
    const picked = module.walletForSelection(wallets, selection)
    if (picked === undefined || picked.wallet.id !== expected) throw new Error(JSON.stringify(selection) + ' picked ' + (picked === undefined ? 'none' : picked.wallet.id))
  }
})

check('readable counts', () => {
  const zh = ['876', '4,321', '4.4万', '26.2万', '346万', '3241万', '12亿']
  const values = [876, 4321, 43941, 262144, 3457200, 32412821, 1200000000]
  values.forEach((value, index) => {
    const text = module.formatCount(value, 'zh-CN')
    if (text !== zh[index]) throw new Error('zh ' + value + ' -> ' + text + ' (expected ' + zh[index] + ')')
  })
  if (module.formatCount(32412821, 'en') !== '32.41M') throw new Error('en formatting changed')
})
check('accent colour plumbing', () => {
  const withAccent = { ...props, useAccent: (select) => select({ accent: '#00a86b' }), setAccent: () => {}, resetAccent: () => {} }
  const chip = module.TokenUsageAction(withAccent)
  if (chip.props.style?.['--dsh-tup-accent'] !== '#00a86b') throw new Error('chip did not carry the accent variable')
  const wallets = module.deriveWallets(inventory)
  const panel = module.UsagePanel({
    t,
    wallet: wallets[0],
    wallets,
    keyInventory: inventory,
    accent: '#00a86b',
    onAccentChange: () => {},
    onAccentReset: () => {}
  })
  const row = panel.children[0].find((child) => child.props?.className === 'dsh-tup-accent')
  if (row === undefined) throw new Error('accent row missing')
  const swatches = row.children.filter((child) => child.props?.className === 'dsh-tup-swatch')
  if (swatches.length !== 6) throw new Error('expected 6 swatches, got ' + swatches.length)
  const active = swatches.filter((child) => child.props['data-active'] === 'true')
  if (active.length !== 1 || active[0].props.style.background !== '#00a86b') throw new Error('active swatch is wrong')
  const picker = row.children.find((child) => child.props?.className === 'dsh-tup-color')
  if (picker?.props.value !== '#00a86b') throw new Error('picker value is wrong')
})
check('responsive placement', () => {
  const wide = module.computePanelPosition({ top: 40, bottom: 78, right: 400, left: 200 }, { width: 1600, height: 1000 })
  if (wide.width !== 430 || wide.top === undefined) throw new Error('wide viewport should use the full width below the chip')
  const narrow = module.computePanelPosition({ top: 40, bottom: 78, right: 380, left: 200 }, { width: 420, height: 900 })
  if (narrow.width > 400 || narrow.left + narrow.width > 420) throw new Error('narrow viewport should shrink and stay inside')
  const short = module.computePanelPosition({ top: 620, bottom: 658, right: 900, left: 800 }, { width: 1400, height: 700 })
  if (short.bottom === undefined) throw new Error('a short viewport should flip the panel above the chip')
  if (700 - short.bottom - short.maxHeight < 0) throw new Error('flipped panel overflows the top edge')
  const tiny = module.computePanelPosition({ top: 100, bottom: 138, right: 200, left: 100 }, { width: 240, height: 400 })
  if (tiny.width < 200 || tiny.maxHeight < 160) throw new Error('tiny viewport should keep a usable minimum')
  if (tiny.top + tiny.maxHeight > 400) throw new Error('tiny viewport panel overflows the bottom edge')
  const rightEdge = module.computePanelPosition({ top: 40, bottom: 78, right: 1390, left: 1200 }, { width: 1400, height: 900 })
  if (rightEdge.left + rightEdge.width > 1400) throw new Error('right edge should clamp')
})
check('ui scale follows the window', () => {
  if (module.uiScale(1280) !== 1) throw new Error('scale should stay 1 up to 1440px')
  if (module.uiScale(1440) !== 1) throw new Error('scale should stay 1 at 1440px')
  const mid = module.uiScale(1600)
  if (mid <= 1 || mid >= 1.12) throw new Error('scale should grow gently past 1440px, got ' + mid)
  if (module.uiScale(1920) !== 1.12) throw new Error('scale should reach the 1.12 ceiling at 1920px')
  if (module.uiScale(4000) !== 1.12) throw new Error('scale should cap at 1.12, got ' + module.uiScale(4000))
  const wide = module.computePanelPosition({ top: 40, bottom: 78, right: 400, left: 200 }, { width: 1920, height: 1080 }, module.uiScale(1920))
  if (wide.width <= 430) throw new Error('panel should widen on a large viewport, got ' + wide.width)
  const narrow = module.computePanelPosition({ top: 40, bottom: 78, right: 380, left: 200 }, { width: 420, height: 900 }, module.uiScale(420))
  if (narrow.left + narrow.width > 420) throw new Error('panel must stay inside a narrow viewport')
})
check('opacity controls', () => {
  const walk = (node, out = []) => {
    if (Array.isArray(node)) { for (const item of node) walk(item, out); return out }
    if (node === null || node === undefined) return out
    out.push(node)
    if (Array.isArray(node.children)) for (const child of node.children) walk(child, out)
    return out
  }
  const flat = (nodes) => walk(nodes)
  const withOpacity = { ...props, useOpacity: (select) => select({ panel: 0.8 }), setOpacity: () => {}, resetOpacity: () => {} }
  const chip = module.TokenUsageAction(withOpacity)
  if (chip.props.style['--dsh-tup-panel-alpha'] !== '0.8') throw new Error('panel alpha variable missing')
  if ('--dsh-tup-chip-alpha' in chip.props.style) throw new Error('chip alpha should be gone')
  const wallets = module.deriveWallets(inventory)
  const panel = module.UsagePanel({ t, wallet: wallets[0], wallets, keyInventory: inventory, opacity: { panel: 0.8 }, onOpacityChange: () => {}, onOpacityReset: () => {} })
  const all = walk(panel.children[0])
  const sliders = all.filter((node) => node?.props?.className === 'dsh-tup-range')
  if (sliders.length !== 1) throw new Error('expected one opacity slider, got ' + sliders.length)
  if (sliders[0].props.value !== '80') throw new Error('slider value wrong: ' + sliders[0].props.value)
})
check('summary renders', () => {
  const wallets = module.deriveWallets(inventory)
  module.buildSummary({ t, totals: usageSummary.totals, usage: module.deriveUsage(projection.tokenUsage), wallet: wallets[0] })
})

if (failures.length > 0) {
  console.error('\n' + failures.length + ' check(s) failed')
  process.exit(1)
}
console.log('\nall checks passed')
