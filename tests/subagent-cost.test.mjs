/**
 * 子代理聚合（`rollupSubagentCost`）的单测（node:test，直接跑构建产物
 * `lib/client/subagent-cost.js` 的纯函数，不涉及 React）。
 *
 * 覆盖：后代发现（含孙代 / 回环 / 非子代理行）、时间窗归属、创建锚点兜底、
 * 未归属计数、老形状（缺 ownTurns）退化、跨层锚点换算、空输入。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NO_SUBAGENTS, rollupSubagentCost } from '../lib/client/subagent-cost.js'

/** 一轮的自身口径条目。 */
const ownTurn = (cost, tokens, startedAt) => ({
  cost: { hit: 0, miss: cost, out: 0, total: cost },
  tok: { hit: 0, miss: tokens, out: 0, total: tokens },
  ...startedAt === undefined ? {} : { startedAt },
})

/** 一个会话行的投影值（只给我们读的字段）。默认"自身口径覆盖整段日志"。 */
const view = ({ turns = {}, spawns = {}, ownComplete = true } = {}) => ({
  ownTurns: turns,
  spawns,
  ...ownComplete === undefined ? {} : { ownComplete },
})

/** 根会话的行。 */
const root = (turns) => ({ id: 'root', projectionValues: { turnCost: view({ turns }) } })

test('没有后代时返回空汇总（同一引用，调用方可零成本判断）', () => {
  assert.equal(rollupSubagentCost('root', [root({ '1': ownTurn(10, 1, 100) })], view()), NO_SUBAGENTS)
})

test('一次性子代理：按自身轮起点落进触发它的那一轮', () => {
  const sessions = [
    { id: 'root', projectionValues: { turnCost: view({ turns: { '1': ownTurn(100, 1, 0), '2': ownTurn(200, 1, 1000) } }) } },
    {
      id: 'kid',
      parentId: 'root',
      origin: 'subagent',
      title: '审计',
      projectionValues: { turnCost: view({ turns: { '1': ownTurn(500, 50, 1200) } }) },
    },
  ]
  const rollup = rollupSubagentCost('root', sessions, sessions[0].projectionValues.turnCost)
  assert.equal(rollup.cost, 500)
  assert.equal(rollup.tokens, 50)
  assert.equal(rollup.count, 1)
  assert.equal(rollup.unattributed, 0)
  assert.deepEqual(rollup.byTurn['2'].cost, 500)
  assert.equal(rollup.byTurn['1'], undefined)
  assert.deepEqual(rollup.rows[0], {
    id: 'kid',
    label: '审计',
    depth: 1,
    cost: 500,
    tokens: 50,
    mode: 'unknown',
    exact: true,
    turns: [2],
  })
})

test('可持续子代理：两轮分别落到各自触发的父会话轮次', () => {
  const sessions = [
    { id: 'root', projectionValues: { turnCost: view({ turns: { '1': ownTurn(1, 1, 0), '2': ownTurn(1, 1, 1000), '3': ownTurn(1, 1, 2000) } }) } },
    {
      id: 'kid',
      parentId: 'root',
      origin: 'subagent',
      displayTitle: 'kid-display',
      projectionValues: { turnCost: view({ turns: { '1': ownTurn(300, 3, 1100), '2': ownTurn(700, 7, 2100) } }) },
    },
  ]
  const rollup = rollupSubagentCost('root', sessions, sessions[0].projectionValues.turnCost)
  assert.equal(rollup.cost, 1000)
  assert.equal(rollup.byTurn['2'].cost, 300)
  assert.equal(rollup.byTurn['3'].cost, 700)
  assert.deepEqual(rollup.rows[0].turns, [2, 3])
  assert.equal(rollup.rows[0].label, 'kid-display')
})

test('缺轮起点 → 退回创建锚点，并标记 exact:false', () => {
  const sessions = [
    { id: 'root', projectionValues: { turnCost: view({ turns: { '1': ownTurn(1, 1, 0), '7': ownTurn(1, 1, 9000) } }) } },
    {
      id: 'kid',
      parentId: 'root',
      origin: 'subagent',
      projectionValues: {
        turnCost: view({ turns: { '1': ownTurn(400, 4) }, spawns: {} }),
      },
    },
    // 锚点在 root 自己身上：kid 是 root 创建的第 7 轮
    {
      id: 'root',
      projectionValues: { turnCost: view({ turns: { '1': ownTurn(1, 1, 0), '7': ownTurn(1, 1, 9000) }, spawns: { kid: { turn: 7, at: 8000, mode: 'one-shot', label: 'x' } } }) },
    },
  ]
  // 上面重复了 root：以最后一条为准（Map 后写覆盖），保持用例自解释。
  const rollup = rollupSubagentCost('root', sessions.slice(1), sessions[2].projectionValues.turnCost)
  assert.equal(rollup.cost, 400)
  assert.deepEqual(rollup.byTurn['7'].cost, 400)
  assert.equal(rollup.rows[0].exact, false)
  assert.equal(rollup.rows[0].mode, 'one-shot')
})

test('孙代：按时间窗归到本会话轮次；无时刻时沿祖先链换算锚点', () => {
  const sessions = [
    { id: 'root', projectionValues: { turnCost: view({ turns: { '4': ownTurn(1, 1, 4000) }, spawns: { child: { turn: 4, at: 4100, mode: 'continuable' } } }) } },
    {
      id: 'child',
      parentId: 'root',
      origin: 'subagent',
      projectionValues: {
        turnCost: view({
          turns: { '1': ownTurn(100, 1, 4200), '2': ownTurn(200, 2) },
          spawns: { grand: { turn: 2, at: 5000, mode: 'one-shot' } },
        }),
      },
    },
    {
      id: 'grand',
      parentId: 'child',
      origin: 'subagent',
      projectionValues: { turnCost: view({ turns: { '1': ownTurn(900, 9) } }) },
    },
  ]
  const rollup = rollupSubagentCost('root', sessions, sessions[0].projectionValues.turnCost)
  assert.equal(rollup.cost, 1200)
  assert.deepEqual(rollup.rows.map(row => [row.id, row.depth]), [['child', 1], ['grand', 2]])
  // child 第 1 轮：时刻 4200 落在 root 第 4 轮 ✓；child 第 2 轮没有时刻 → 锚点 turn 2
  // （child 的第 2 轮起点缺失，于是继续沿链用 child 在 root 的创建锚点 turn 4）；
  // grand 没有时刻 → 它的锚点 turn 2 在 child 里，同样沿链换算到 root 第 4 轮。
  assert.equal(rollup.byTurn['4'].cost, 100 + 200 + 900)
  assert.deepEqual(rollup.rows[1].turns, [4])
})

test('回环 / 断链 / 非子代理行都不产生后代（不会无限递归）', () => {
  const sessions = [
    { id: 'root', projectionValues: { turnCost: view({ turns: { '1': ownTurn(1, 1, 0) } }) } },
    { id: 'a', parentId: 'b', origin: 'subagent', projectionValues: { turnCost: view({ turns: { '1': ownTurn(5, 1, 1) } }) } },
    { id: 'b', parentId: 'a', origin: 'subagent', projectionValues: { turnCost: view({ turns: { '1': ownTurn(5, 1, 1) } }) } },
    { id: 'orphan', parentId: 'missing', origin: 'subagent', projectionValues: { turnCost: view({ turns: { '1': ownTurn(5, 1, 1) } }) } },
    { id: 'plain', parentId: 'root', projectionValues: { turnCost: view({ turns: { '1': ownTurn(5, 1, 1) } }) } },
  ]
  assert.equal(rollupSubagentCost('root', sessions, sessions[0].projectionValues.turnCost), NO_SUBAGENTS)
})

test('既无时刻又无锚点 → 只进会话合计，计入 unattributed', () => {
  const sessions = [
    { id: 'root', projectionValues: { turnCost: view({ turns: { '1': ownTurn(1, 1, 0) } }) } },
    { id: 'kid', parentId: 'root', origin: 'subagent', projectionValues: { turnCost: view({ turns: { '1': ownTurn(250, 2) } }) } },
  ]
  const rollup = rollupSubagentCost('root', sessions, sessions[0].projectionValues.turnCost)
  assert.equal(rollup.cost, 250)
  assert.equal(rollup.unattributed, 250)
  assert.deepEqual(rollup.byTurn, {})
  assert.deepEqual(rollup.rows[0].turns, [])
})

test('子轮起点早于本会话任何轮起点 → 退回锚点，不硬塞进第 1 轮', () => {
  const sessions = [
    { id: 'root', projectionValues: { turnCost: view({ turns: { '5': ownTurn(1, 1, 5000) } }) } },
    { id: 'kid', parentId: 'root', origin: 'subagent', projectionValues: { turnCost: view({ turns: { '1': ownTurn(60, 1, 10) } }) } },
  ]
  const rollup = rollupSubagentCost('root', sessions, sessions[0].projectionValues.turnCost)
  assert.equal(rollup.unattributed, 60)
  assert.deepEqual(rollup.byTurn, {})
})

test('老形状（ownComplete 非 true）：退回整段日志口径并标记 exact:false', () => {
  const legacyTurns = {
    '1': { cost: { hit: 0, miss: 0, out: 0, total: 700 }, tok: { hit: 0, miss: 0, out: 0, total: 7 }, peak: false, model: 'm' },
  }
  const legacyTotals = { cost: { hit: 0, miss: 0, out: 0, total: 700 }, tok: { hit: 0, miss: 0, out: 0, total: 7 } }
  // 三种"未覆盖整段日志"的读法都要退回整段口径（`turns`）：缺字段 / false / 非法值。
  const legacyViews = [
    { totals: legacyTotals, turns: legacyTurns },
    { totals: legacyTotals, turns: legacyTurns, ownTurns: legacyTurns, ownComplete: false },
    { totals: legacyTotals, turns: legacyTurns, ownTurns: legacyTurns },
  ]
  for (const legacy of legacyViews) {
    const sessions = [
      { id: 'root', projectionValues: { turnCost: view({ turns: { '2': ownTurn(1, 1, 2000) } }) } },
      { id: 'kid', parentId: 'root', origin: 'subagent', projectionValues: { turnCost: legacy } },
    ]
    const rollup = rollupSubagentCost('root', sessions, sessions[0].projectionValues.turnCost)
    assert.equal(rollup.cost, 700)
    assert.equal(rollup.tokens, 7)
    assert.equal(rollup.unattributed, 700)
    assert.equal(rollup.rows[0].exact, false)
  }
})

test('纯零花费的后代不出行、不计数', () => {
  const sessions = [
    { id: 'root', projectionValues: { turnCost: view({ turns: { '1': ownTurn(1, 1, 0) } }) } },
    { id: 'kid', parentId: 'root', origin: 'subagent', projectionValues: { turnCost: view({ turns: { '1': ownTurn(0, 0, 5) } }) } },
  ]
  assert.equal(rollupSubagentCost('root', sessions, sessions[0].projectionValues.turnCost), NO_SUBAGENTS)
})

test('标签优先级：标题 → 创建标签 → id 前 8 位', () => {
  const sessions = [
    {
      id: 'root',
      projectionValues: {
        turnCost: view({
          turns: { '1': ownTurn(1, 1, 0) },
          spawns: { kid: { turn: 1, at: 2, mode: 'one-shot', label: '目录标签' } },
        }),
      },
    },
    { id: 'kid', parentId: 'root', origin: 'subagent', projectionValues: { turnCost: view({ turns: { '1': ownTurn(9, 1, 3) } }) } },
    { id: 'kid2', parentId: 'root', origin: 'subagent', projectionValues: { turnCost: view({ turns: { '1': ownTurn(9, 1, 3) } }) } },
  ]
  const rollup = rollupSubagentCost('root', sessions, sessions[0].projectionValues.turnCost)
  const byId = Object.fromEntries(rollup.rows.map(row => [row.id, row.label]))
  assert.equal(byId.kid, '目录标签')
  assert.equal(byId.kid2, 'kid2')
})
