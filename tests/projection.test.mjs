/**
 * `turnCost` 投影折叠的单测（node:test，直接跑构建产物 lib/projection.js）。
 *
 * 覆盖：三桶计价、同槽替换、重试累加、流式样本回退、跨轮换模型、
 * 非计价 provider、峰谷差异、配置透传，以及"永不抛错"的健壮性契约。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTurnCostProjection } from '../lib/projection.js'

/** 北京时间 ISO → epoch ms。 */
const bj = iso => Date.parse(`${iso}+08:00`)
/** 2026-09-14（周一）20:00：空闲时段。 */
const VALLEY = bj('2026-09-14T20:00:00')
/** 2026-09-14（周一）10:00：高峰时段。 */
const PEAK = bj('2026-09-14T10:00:00')
/** 2026-09-01 20:00：调价前的空闲时段。 */
const OLD_VALLEY = bj('2026-09-01T20:00:00')

const header = (model, provider = 'deepseek-official') => ({
  type: 'request/header', time: 0, data: { header: { config: { provider, model } } },
})
const message = ({ turn, step, time, usage, model = 'deepseek-v4-flash', provider = 'deepseek-official' }) => ({
  type: 'assistant/message',
  time,
  data: { turn, step, usage, message: { source: { provider, model } } },
})
const messageWithStream = ({ turn, step, time, usage, model = 'deepseek-v4-flash' }) => ({
  type: 'assistant/message',
  time,
  data: {
    turn,
    step,
    message: { source: { provider: 'deepseek-official', model } },
    stream: [{ type: 'chunk', chunk: { type: 'text', text: 'hi' } }, { type: 'chunk', chunk: { type: 'usage', usage } }],
  },
})
const attempt = ({ turn, step, time, usage }) => ({
  type: 'assistant/attempt',
  time,
  data: { turn, step, stream: [{ type: 'chunk', chunk: { type: 'usage', usage } }] },
})
const retryStarted = (turn, step) => ({ type: 'llm/retry-started', data: { turn, step, retry: 1 } })

/** 跑一段事件，返回 {state, view}。 */
function run(events, options) {
  const definition = createTurnCostProjection(options)
  let state = definition.init()
  for (const event of events) state = definition.apply(state, event)
  return { state, view: definition.wire.view(state) }
}

test('空闲时段：三桶金额 = tokens × 谷价，且每轮与会话累计一致', () => {
  const { view } = run([
    header('deepseek-v4-flash'),
    message({
      turn: 1,
      step: 1,
      time: VALLEY,
      usage: { inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 500 },
    }),
  ])
  const turn = view.turns['1']
  assert.deepEqual(turn.cost, { hit: 180, miss: 1000, out: 2000, total: 3180 })
  assert.deepEqual(turn.tok, { hit: 9000, miss: 1000, out: 500, total: 10500 })
  assert.equal(turn.peak, false)
  assert.equal(turn.model, 'deepseek-v4-flash')
  assert.deepEqual(view.totals.cost, { hit: 180, miss: 1000, out: 2000, total: 3180 })
  assert.deepEqual(view.totals.tok, turn.tok)
  assert.equal(view.priceAsOf, '2026-09-10')
})

test('高峰时段：同一批 token 正好是谷价的 2 倍', () => {
  const usage = { inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 500 }
  const valley = run([header('deepseek-v4-flash'), message({ turn: 1, step: 1, time: VALLEY, usage })]).view
  const peak = run([header('deepseek-v4-flash'), message({ turn: 1, step: 1, time: PEAK, usage })]).view
  assert.equal(peak.turns['1'].peak, true)
  assert.equal(peak.turns['1'].cost.hit, valley.turns['1'].cost.hit * 2)
  assert.equal(peak.turns['1'].cost.miss, valley.turns['1'].cost.miss * 2)
  assert.equal(peak.turns['1'].cost.out, valley.turns['1'].cost.out * 2)
})

test('调价前的时间点用当时价格（2026-08-17 档）', () => {
  const { view } = run([
    header('deepseek-v4-flash'),
    message({
      turn: 1,
      step: 1,
      time: OLD_VALLEY,
      usage: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 0 },
    }),
  ])
  assert.equal(view.turns['1'].cost.miss, 1500) // 1.5 元/百万 × 1000 tokens
  assert.equal(view.turns['1'].asOf, '2026-08-17')
})

test('同一 (turn, step) 的新样本替换旧样本，而不是累加', () => {
  const { view } = run([
    header('deepseek-v4-flash'),
    message({ turn: 1, step: 1, time: VALLEY, usage: { inputTokens: 100, outputTokens: 10 } }),
    message({ turn: 1, step: 1, time: VALLEY, usage: { inputTokens: 1000, outputTokens: 500 } }),
  ])
  assert.deepEqual(view.turns['1'].tok, { hit: 0, miss: 1000, out: 500, total: 1500 })
  assert.equal(view.totals.tok.miss, 1000)
})

test('失败重试：llm/retry-started 之后的 attempt 累加（每次请求都真实计费）', () => {
  const { view } = run([
    header('deepseek-v4-flash'),
    message({ turn: 1, step: 1, time: VALLEY, usage: { inputTokens: 1000, outputTokens: 100 } }),
    retryStarted(1, 1),
    message({ turn: 1, step: 1, time: VALLEY, usage: { inputTokens: 2000, outputTokens: 200 } }),
  ])
  assert.equal(view.turns['1'].tok.miss, 3000)
  assert.equal(view.turns['1'].tok.out, 300)
  assert.equal(view.totals.tok.miss, 3000)
})

test('流式 attempt 样本被随后的最终样本替换（原生同语义）', () => {
  const { view } = run([
    header('deepseek-v4-flash'),
    attempt({ turn: 1, step: 1, time: VALLEY, usage: { inputTokens: 1000, outputTokens: 50 } }),
    message({ turn: 1, step: 1, time: VALLEY, usage: { inputTokens: 1000, outputTokens: 500 } }),
  ])
  assert.deepEqual(view.turns['1'].tok, { hit: 0, miss: 1000, out: 500, total: 1500 })
})

test('usage 只在流里时也能取到（与原生 lastAssistantStreamChunk 同源）', () => {
  const { view } = run([
    header('deepseek-v4-flash'),
    messageWithStream({ turn: 1, step: 1, time: VALLEY, usage: { inputTokens: 2000, outputTokens: 250 } }),
  ])
  assert.deepEqual(view.turns['1'].tok, { hit: 0, miss: 2000, out: 250, total: 2250 })
})

test('跨轮换模型：每轮按各自模型计价，会话累计为各轮之和', () => {
  const { view } = run([
    header('deepseek-v4-flash'),
    message({ turn: 1, step: 1, time: VALLEY, usage: { inputTokens: 1000, outputTokens: 0 }, model: 'deepseek-v4-flash' }),
    header('deepseek-v4-pro'),
    message({ turn: 2, step: 1, time: VALLEY, usage: { inputTokens: 1000, outputTokens: 0 }, model: 'deepseek-v4-pro' }),
  ])
  assert.equal(view.turns['1'].model, 'deepseek-v4-flash')
  assert.equal(view.turns['2'].model, 'deepseek-v4-pro')
  assert.equal(view.turns['1'].cost.miss, 1000) // 1 元/百万
  assert.equal(view.turns['2'].cost.miss, 4500) // 4.5 元/百万
  assert.equal(view.totals.cost.miss, 5500)
})

test('非计价 provider 不计入（默认只认 deepseek-official）', () => {
  const events = [
    header('glm-5.3', 'zai-coding'),
    message({
      turn: 1, step: 1, time: VALLEY, model: 'glm-5.3', provider: 'zai-coding',
      usage: { inputTokens: 1000, outputTokens: 100 },
    }),
  ]
  const skipped = run(events).view
  assert.deepEqual(skipped.turns, {})
  assert.equal(skipped.totals.cost.total, 0)

  const priced = run(events, { pricedProviders: ['*'] }).view
  assert.equal(priced.turns['1'].cost.miss, 1000)
})

test('配置：placement 随投影下发；peakPricing=false 时一律谷价', () => {
  const usage = { inputTokens: 1000, outputTokens: 0 }
  const flat = run([header('deepseek-v4-flash'), message({ turn: 1, step: 1, time: PEAK, usage })], {
    placement: 'between',
    peakPricing: false,
  }).view
  assert.equal(flat.placement, 'between')
  assert.equal(flat.turns['1'].peak, false)
  assert.equal(flat.turns['1'].cost.miss, 1000) // 谷价 1 元/百万
})

test('无信息事件返回同一引用（框架据此零成本跳过推送）', () => {
  const definition = createTurnCostProjection()
  const state = definition.init()
  for (const event of [
    { type: 'tool/call', time: 1, data: { callId: 'x' } },
    { type: 'step/start', time: 1, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', time: 1, data: { turn: 1, step: 1 } },
    { type: 'turn/end', time: 1, data: { turn: 1 } },
    { type: 'subagent/descriptor', time: 1, data: { version: 3 } },
  ]) {
    assert.equal(definition.apply(state, event), state)
  }
})

test('轮边界与子代理目录是有信息事件：轮起点 / 当前轮 / 子会话锚点', () => {
  const { state, view } = run([
    { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
    message({ turn: 1, step: 1, time: VALLEY, usage: { inputTokens: 10, outputTokens: 5 } }),
    { type: 'turn/start', seq: 3, time: 2000, data: { turn: 2 } },
    { type: 'turn/start', seq: 4, time: 2000, data: { turn: 2 } }, // 重复边界不改写起点
    {
      type: 'subagent/catalog',
      seq: 5,
      time: 2100,
      data: { version: 0, childId: 'child-a', childCreatedAt: 2050, mode: 'continuable', label: '审计' },
    },
  ])
  assert.equal(state.currentTurn, 2)
  assert.equal(state.ownComplete, 1)
  assert.equal(view.ownComplete, true)
  assert.equal(state.ownTurns['1'].startedAt, 1000)
  assert.equal(state.ownTurns['2'].startedAt, 2000)
  assert.deepEqual(Object.keys(state.spawns), ['child-a'])
  assert.deepEqual(state.spawns['child-a'], { turn: 2, at: 2100, mode: 'continuable', label: '审计' })
})

test('fork 继承前缀：祖辈的用量与目录事实不算本会话自己的', () => {
  const definition = createTurnCostProjection()
  // 前缀长度 4：seq 0..3 属于祖辈
  let state = definition.init(undefined, 4)
  const events = [
    { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
    { ...message({ turn: 1, step: 1, time: VALLEY, usage: { inputTokens: 1000, outputTokens: 100 } }), seq: 1 },
    {
      type: 'subagent/catalog',
      seq: 2,
      time: 150,
      data: { version: 0, childId: 'ancestor-child', childCreatedAt: 120, mode: 'one-shot' },
    },
    { type: 'turn/end', seq: 3, time: 200, data: { turn: 1 } },
    // ↓ 本会话自己的那一段
    { type: 'turn/start', seq: 4, time: 300, data: { turn: 2 } },
    { ...message({ turn: 2, step: 1, time: VALLEY, usage: { inputTokens: 20, outputTokens: 7 } }), seq: 5 },
    {
      type: 'subagent/catalog',
      seq: 6,
      time: 350,
      data: { version: 0, childId: 'my-child', childCreatedAt: 320, mode: 'one-shot' },
    },
  ]
  for (const event of events) state = definition.apply(state, event)
  const view = definition.wire.view(state)

  // 整段日志口径（与原生 tokenUsage 一致）包含继承前缀……
  assert.equal(view.totals.tok.miss, 1020)
  assert.deepEqual(Object.keys(view.turns).sort(), ['1', '2'])
  // ……而"自身口径"只有 seq ≥ 4 的那一段。
  assert.deepEqual(Object.keys(view.ownTurns), ['2'])
  assert.equal(view.ownTurns['2'].tok.miss, 20)
  assert.equal(view.ownTurns['2'].startedAt, 300)
  assert.deepEqual(Object.keys(view.spawns), ['my-child'])
  assert.equal(view.spawns['my-child'].turn, 2)
})

test('缓存覆盖标记：整段折叠写 1；从旧持久行恢复（缺字段）写 0 且保持 0', () => {
  const definition = createTurnCostProjection()
  // 1) 由 init 折起：覆盖整段日志。
  let fresh = definition.init()
  fresh = definition.apply(fresh, { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })
  assert.equal(fresh.ownComplete, 1)
  assert.equal(definition.wire.view(fresh).ownComplete, true)

  // 2) 老行（没有这个字段）——stateSchema.parse 只在"从持久行恢复"的两条路径上被调用。
  const legacyRow = definition.stateSchema.parse({
    totals: { costHit: 5, costMiss: 0, costOut: 0, tokHit: 0, tokMiss: 0, tokOut: 0 },
    turns: { 1: { costHit: 5, costMiss: 0, costOut: 0, tokHit: 0, tokMiss: 0, tokOut: 0, peak: 0, model: 'm' } },
    header: null,
    last: null,
    asOf: '2026-09-10',
    placement: 'before-usage',
  })
  assert.equal(legacyRow.ownComplete, 0)
  assert.deepEqual(legacyRow.ownTurns, {})
  assert.deepEqual(legacyRow.spawns, {})
  // 恢复后继续折：新增字段仍只覆盖恢复点之后 ⇒ 标记保持 0，不假装覆盖了整段。
  const resumed = definition.apply(legacyRow, { type: 'turn/start', seq: 6, time: 9, data: { turn: 2 } })
  assert.equal(resumed.ownComplete, 0)
  assert.equal(definition.wire.view(resumed).ownComplete, false)
  // 而往返（把新状态写回缓存再读）会原样保留标记。
  const roundTrip = definition.stateSchema.parse(JSON.parse(JSON.stringify(resumed)))
  assert.equal(roundTrip.ownComplete, 0)
  const freshTrip = definition.stateSchema.parse(JSON.parse(JSON.stringify(fresh)))
  assert.equal(freshTrip.ownComplete, 1)
})

test('健壮性：脏的子代理目录事件不抛错、不产生假锚点', () => {
  const { view } = run([
    { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
    { type: 'subagent/catalog', seq: 1, time: 11, data: null },
    { type: 'subagent/catalog', seq: 2, time: 12, data: { version: 0, childId: 7 } },
    { type: 'subagent/catalog', seq: 3, time: 13, data: { version: 0, childId: '', mode: 'one-shot' } },
    {
      type: 'subagent/catalog',
      seq: 4,
      time: 'nope',
      data: { version: 0, childId: 'ok', childCreatedAt: 42, mode: 'weird' },
    },
    { type: 'turn/start', seq: 5, time: Number.NaN, data: { turn: 1 } },
  ])
  assert.deepEqual(Object.keys(view.spawns), ['ok'])
  // 事件时刻非法 → 退回 childCreatedAt；形态非法 → 归到 continuable（仅展示用）。
  assert.deepEqual(view.spawns.ok, { turn: 1, at: 42, mode: 'continuable' })
})

test('持久缓存往返：新增的自身口径 / 锚点字段保形', () => {
  const definition = createTurnCostProjection()
  let state = definition.init()
  for (const event of [
    { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
    message({ turn: 1, step: 1, time: VALLEY, usage: { inputTokens: 10, outputTokens: 30 } }),
    {
      type: 'subagent/catalog',
      seq: 2,
      time: 20,
      data: { version: 0, childId: 'c1', childCreatedAt: 15, mode: 'one-shot', label: 'x' },
    },
  ]) state = definition.apply(state, event)
  const restored = definition.stateSchema.parse(JSON.parse(JSON.stringify(state)))
  assert.deepEqual(restored, state)
  const view = definition.wire.view(restored)
  assert.deepEqual(view.ownTurns['1'], {
    cost: view.ownTurns['1'].cost, tok: view.ownTurns['1'].tok, startedAt: 10,
  })
  assert.deepEqual(view.spawns.c1, { turn: 1, at: 20, mode: 'one-shot', label: 'x' })
})

test('健壮性：脏事件与脏状态都不抛错，schema 永远返回合法形状', () => {
  const definition = createTurnCostProjection()
  let state = definition.init()
  const junk = [
    {},
    { type: 'assistant/message' },
    { type: 'assistant/message', data: null },
    { type: 'assistant/message', time: 'nope', data: { turn: 'x', step: -1, usage: 'bad' } },
    {
      type: 'assistant/message',
      time: Number.NaN,
      data: { turn: 1, step: 1, usage: { inputTokens: -5, outputTokens: Number.NaN } },
    },
    { type: 'request/header', data: { header: { config: { provider: 7, model: null } } } },
    { type: 'llm/retry-started', data: { turn: null } },
    { type: 'assistant/attempt', data: { turn: 2, step: 1, stream: 'not-an-array' } },
  ]
  for (const event of junk) {
    assert.doesNotThrow(() => { state = definition.apply(state, event) })
    assert.doesNotThrow(() => { definition.wire.view(state) })
  }

  const emptyView = definition.wire.viewSchema.parse(undefined)
  assert.deepEqual(emptyView.totals.cost, { hit: 0, miss: 0, out: 0, total: 0 })
  assert.deepEqual(emptyView.turns, {})
  assert.equal(emptyView.placement, 'before-usage')
  assert.equal(emptyView.priceAsOf, '2026-09-10')

  const junkView = definition.wire.viewSchema.parse({ totals: 'x', turns: { 1: { cost: { hit: -1 } } }, placement: 42 })
  assert.deepEqual(junkView.turns['1'].cost, { hit: 0, miss: 0, out: 0, total: 0 })
  assert.equal(junkView.placement, 'before-usage')

  const emptyState = definition.stateSchema.parse({ nonsense: true })
  assert.deepEqual(emptyState.totals.costHit, 0)
  assert.equal(emptyState.header, null)
  assert.equal(emptyState.last, null)
  assert.equal(emptyState.placement, 'before-usage')
})

test('持久缓存往返：stateSchema.parse(view 之外的真实状态) 保形', () => {
  const definition = createTurnCostProjection({ placement: 'after-time' })
  let state = definition.init()
  state = definition.apply(state, header('deepseek-v4-flash'))
  state = definition.apply(state, message({
    turn: 3, step: 2, time: VALLEY, usage: { inputTokens: 10, cacheReadTokens: 20, outputTokens: 30 },
  }))
  const restored = definition.stateSchema.parse(JSON.parse(JSON.stringify(state)))
  assert.deepEqual(restored, state)
  assert.equal(definition.wire.view(restored).turns['3'].cost.hit, 0) // 20 × 0.02 = 0.4 µ¥ → 进位到 0
  assert.equal(definition.wire.view(restored).placement, 'after-time')
})
