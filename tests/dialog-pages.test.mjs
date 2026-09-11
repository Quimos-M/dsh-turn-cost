/**
 * 弹窗分页（`lib/client/dialog-pages.js` 的纯函数）与页列表装配的单测。
 *
 * 覆盖：页数计算、当前页钳制（子代理变少时必须夹住）、两端步进与循环翻页、
 * **无子代理时退化为单页**（行与分页前逐条一致）、有子代理时的三页结构与归属文案，
 * 以及"用到的文案键在 zh/en 里都存在"。
 *
 * 这里跑的就是两个 pill 打开弹窗时走的那条路径（行装配 + 页装配），不涉及 React。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  agentPages, clampPage, cyclePage, pageCount, pageIndicator, stepPage,
} from '../lib/client/dialog-pages.js'
import { en, zh } from '../lib/client/locales.js'

/** 真词典座位：键缺失即断言失败（防止新代码用了没登记的键）。 */
const t = (key) => {
  const value = zh[key]
  assert.equal(typeof value, 'string', `zh 缺少文案键: ${String(key)}`)
  return value
}

/** 三桶（金额与 token 用同一个构造器，方便构造测试数据）。 */
const buckets = (hit, miss, out) => ({ hit, miss, out, total: hit + miss + out })

/** 一个代理的账。 */
const ledger = (cost, tok, models = []) => ({ cost, tok, models })

/** 一个子代理行。 */
const subRow = (over = {}) => ({
  id: 'kid', label: '审计', depth: 1, cost: 500, tokens: 50, mode: 'one-shot', exact: true, turns: [2],
  ...over,
})

/** 一个子代理细目。 */
const detail = (cost = buckets(0, 500, 0), tok = buckets(0, 50, 0), models = ['m-kid']) => ({ cost, tok, models })

/** 子代理来源（会话级 rollup / 某一轮切片的公共形状）。 */
const source = (rows, details = {}) => ({
  cost: rows.reduce((sum, row) => sum + row.cost, 0),
  costBuckets: buckets(0, rows.reduce((sum, row) => sum + row.cost, 0), 0),
  tokBuckets: buckets(0, rows.reduce((sum, row) => sum + row.tokens, 0), 0),
  rows,
  details,
})

// ------------------------------------------------------------------ 页数计算

test('页数：没有子代理 = 单页；有 N 个子代理 = N + 2 页', () => {
  assert.equal(pageCount(0), 1)
  assert.equal(pageCount(1), 3)
  assert.equal(pageCount(4), 6)
})

test('页数：脏输入一律按 0 个（退化单页），绝不产生 0 页或负页', () => {
  for (const dirty of [-1, -100, Number.NaN, Number.POSITIVE_INFINITY, undefined, null, '3', {}]) {
    assert.equal(pageCount(dirty), 1, `脏输入 ${String(dirty)} 应退化为单页`)
  }
  assert.equal(pageCount(2.7), 4)
})

// -------------------------------------------------------------- 当前页钳制

test('钳制：越界页码夹回 [0, 页数-1]，脏输入归 0', () => {
  assert.equal(clampPage(0, 4), 0)
  assert.equal(clampPage(3, 4), 3)
  assert.equal(clampPage(4, 4), 3)
  assert.equal(clampPage(99, 4), 3)
  assert.equal(clampPage(-1, 4), 0)
  assert.equal(clampPage(Number.NaN, 4), 0)
  assert.equal(clampPage(1.9, 4), 1)
})

test('钳制：单页（页数 1 / 脏页数）恒为第 0 页 —— 无子代理时不会翻到空白页', () => {
  assert.equal(clampPage(0, 1), 0)
  assert.equal(clampPage(2, 1), 0)
  assert.equal(clampPage(2, 0), 0)
  assert.equal(clampPage(2, Number.NaN), 0)
})

test('钳制：子代理数变少（页数缩水）时，原本的当前页被夹到最后一页', () => {
  const before = clampPage(4, pageCount(3)) // 4/… 里的最后一页
  assert.equal(before, 4)
  const after = clampPage(before, pageCount(1)) // 子代理从 3 个变 1 个
  assert.equal(after, 2)
})

// ------------------------------------------------------------------ 翻页步进

test('步进：两端夹住不环绕（翻页按钮与左右方向键的口径）', () => {
  assert.equal(stepPage(0, 1, 4), 1)
  assert.equal(stepPage(3, 1, 4), 3)
  assert.equal(stepPage(0, -1, 4), 0)
  assert.equal(stepPage(2, -1, 4), 1)
  assert.equal(stepPage(1, 1, 1), 0)
  assert.equal(stepPage(Number.NaN, 1, 4), 1)
})

test('循环：首尾相接（回车键的口径），单页恒为 0', () => {
  assert.equal(cyclePage(0, 1, 4), 1)
  assert.equal(cyclePage(3, 1, 4), 0)
  assert.equal(cyclePage(0, -1, 4), 3)
  assert.equal(cyclePage(2, 0, 4), 2)
  assert.equal(cyclePage(0, 1, 1), 0)
  assert.equal(cyclePage(5, 1, 0), 0)
})

test('页码指示串：语言无关的 `当前/总数`', () => {
  assert.equal(pageIndicator(0, 4), '1/4')
  assert.equal(pageIndicator(3, 4), '4/4')
  assert.equal(pageIndicator(9, 4), '4/4')
  assert.equal(pageIndicator(0, 1), '1/1')
})

// --------------------------------------------------- 装配：无子代理 = 单页退化

test('没有子代理：装配出且仅装配出 1 页（调用方因此不渲染翻页控件）', () => {
  const pages = agentPages(t, {
    own: ledger(buckets(0, 1000, 0), buckets(0, 100, 0)),
    ownTotalLabel: 'cost.ownTotal',
    ownModelOnSinglePage: false,
  })
  assert.equal(pages.length, 1)
  assert.equal(pageCount(0), 1)
})

test('没有子代理（会话口径）：单页的行与分页前逐条一致 —— 命中率 + 三桶 + 合计，且无模型行', () => {
  const pages = agentPages(t, {
    own: ledger(buckets(0, 1000, 0), buckets(0, 100, 0), ['m-root']),
    ownTotalLabel: 'cost.ownTotal',
    ownModelOnSinglePage: false,
  })
  assert.deepEqual(pages[0].rows.map(row => row.label), [
    zh['cost.hitRate'], zh['cost.cacheHitInput'], zh['cost.cacheMissInput'], zh['cost.output'], zh['cost.total'],
  ])
  assert.equal(pages[0].total, '0.0010 CNY')
})

test('没有子代理（每轮口径）：单页保留模型行（与分页前的每轮弹窗一致）', () => {
  const pages = agentPages(t, {
    own: ledger(buckets(0, 1000, 0), buckets(0, 100, 0), ['deepseek-v4.1-flash']),
    ownTotalLabel: 'cost.ownTurnTotal',
    ownModelOnSinglePage: true,
  })
  assert.equal(pages.length, 1)
  assert.equal(pages[0].rows[0].label, zh['cost.model'])
  assert.equal(pages[0].rows[0].value, 'deepseek-v4.1-flash')
})

// ------------------------------------------------------- 装配：总计 / 主 Agent / 子代理

test('有子代理：页数 = 2 + 子代理数，第 1 页是总计、第 2 页是主 Agent、第 3 页起各一页', () => {
  const rows = [subRow({ id: 'a', label: '审计' }), subRow({ id: 'b', label: '检索', cost: 300, tokens: 30 })]
  const pages = agentPages(t, {
    own: ledger(buckets(0, 1000, 0), buckets(0, 100, 0), ['m-root']),
    ownTotalLabel: 'cost.ownTotal',
    ownModelOnSinglePage: false,
    subagents: source(rows, { a: detail(), b: detail(buckets(0, 300, 0), buckets(0, 30, 0)) }),
  })
  assert.equal(pages.length, pageCount(rows.length))
  assert.equal(pages.length, 4)
  // 第 1 页：合计（自身 1000 + 子代理 800）
  assert.equal(pages[0].total, '0.0018 CNY')
  // 第 2 页：主 Agent 自身
  assert.equal(pages[1].total, '0.0010 CNY')
  // 第 3 / 4 页：各一个子代理
  assert.equal(pages[2].total, '0.0005 CNY')
  assert.equal(pages[3].total, '0.0003 CNY')
})

test('第 1 页：合计口径的三桶 + 一行"由 N 个代理构成"的构成摘要（主 Agent + 子代理）', () => {
  const rows = [subRow({ id: 'a', cost: 500 }), subRow({ id: 'b', cost: 300 })]
  const pages = agentPages(t, {
    own: ledger(buckets(10, 990, 100), buckets(10, 990, 100), ['m-root']),
    ownTotalLabel: 'cost.ownTotal',
    ownModelOnSinglePage: false,
    subagents: source(rows, { a: detail(), b: detail() }),
  })
  const labels = pages[0].rows.map(row => row.label)
  // 总计页不带模型行（模型属于各代理页），行序：命中率 → 三桶 → 合计 → 构成
  assert.deepEqual(labels, [
    zh['cost.hitRate'], zh['cost.cacheHitInput'], zh['cost.cacheMissInput'], zh['cost.output'],
    zh['cost.grandTotal'], `${zh['cost.agentsLead']} 3 ${zh['cost.agentsTail']}`,
  ])
  const composition = pages[0].rows[labels.length - 1].value
  assert.equal(composition, `${zh['cost.mainAgent']} 0.0011 CNY + ${zh['cost.subagent']} 0.0008 CNY`)
  // 三桶与合计相加一致：1100（自身）+ 800（子代理）
  assert.equal(pages[0].total, '0.0019 CNY')
})

test('第 2 页：主 Agent 的模型 / 命中率 / 三桶 / 合计，合计标签按会话或本轮区分', () => {
  for (const [ownTotalLabel, expected] of [['cost.ownTotal', zh['cost.ownTotal']], ['cost.ownTurnTotal', zh['cost.ownTurnTotal']]]) {
    const pages = agentPages(t, {
      own: ledger(buckets(10, 990, 100), buckets(10, 990, 100), ['m-root', 'm-other']),
      ownTotalLabel,
      ownModelOnSinglePage: false,
      subagents: source([subRow()], { kid: detail() }),
    })
    assert.equal(pages[1].rows[0].value, 'm-root · m-other')
    assert.deepEqual(pages[1].rows.map(row => row.label), [
      zh['cost.model'], zh['cost.hitRate'], zh['cost.cacheHitInput'], zh['cost.cacheMissInput'],
      zh['cost.output'], expected,
    ])
  }
})

test('第 3 页起：每页是一个子代理（名称 / 模型 / 三桶 / 合计 / 归属轮次），合计等于它的花费', () => {
  const row = subRow({ id: 'a', label: '审计', cost: 700, tokens: 70, turns: [12, 13], exact: true })
  const pages = agentPages(t, {
    own: ledger(buckets(0, 1000, 0), buckets(0, 100, 0)),
    ownTotalLabel: 'cost.ownTotal',
    ownModelOnSinglePage: false,
    subagents: source([row], { a: detail(buckets(0, 700, 0), buckets(0, 70, 0), ['m-kid']) }),
  })
  const page = pages[2]
  assert.equal(page.total, '0.0007 CNY')
  // 子代理页：名称 / 模型 / 三桶 / 合计 / 归属（不含命中率行 —— 与第 1、2 页行数对齐，
  // 翻页时面板高度不抖，见 dialog.module.css 的 .detailsPaged）。
  assert.deepEqual(page.rows.map(item => item.label), [
    zh['cost.subagent'], zh['cost.model'], zh['cost.cacheHitInput'],
    zh['cost.cacheMissInput'], zh['cost.output'], zh['cost.total'], zh['cost.agentTurn'],
  ])
  assert.equal(page.rows[0].value, '审计')
  assert.equal(page.rows[1].value, 'm-kid')
  assert.equal(page.rows[page.rows.length - 1].value, `${zh['cost.turnLead']}12${zh['cost.turnTail']}${zh['cost.turnSep']}${zh['cost.turnLead']}13${zh['cost.turnTail']}${zh['cost.turnMark']}${zh['cost.attributedExact']}`)
})

test('子代理页：归属标注如实反映兜底与未归属（按创建轮归属 / 未归属到轮次）', () => {
  const anchored = subRow({ id: 'a', exact: false, turns: [13] })
  const orphan = subRow({ id: 'b', exact: false, turns: [], cost: 100, tokens: 10 })
  const pages = agentPages(t, {
    own: ledger(buckets(0, 1, 0), buckets(0, 1, 0)),
    ownTotalLabel: 'cost.ownTotal',
    ownModelOnSinglePage: false,
    subagents: source([anchored, orphan]),
  })
  const markOf = page => page.rows[page.rows.length - 1].value
  assert.match(markOf(pages[2]), new RegExp(zh['cost.subagentAnchored']))
  assert.equal(markOf(pages[3]), zh['cost.subagentUnattributed'])
})

test('子代理页：细目缺失时退回行上的合计（金额不消失，只是没有模型/三桶细分）', () => {
  const pages = agentPages(t, {
    own: ledger(buckets(0, 1, 0), buckets(0, 1, 0)),
    ownTotalLabel: 'cost.ownTotal',
    ownModelOnSinglePage: false,
    subagents: source([subRow({ id: 'a', cost: 250, tokens: 25 })]),
  })
  const labels = pages[2].rows.map(row => row.label)
  assert.equal(pages[2].total, '0.0003 CNY')
  assert.equal(labels.includes(zh['cost.model']), false, '没有细目时不编造模型行')
  assert.equal(pages[2].rows.find(row => row.label === zh['cost.total'])?.value, '0.0003 CNY')
  assert.equal(pages[2].rows.at(-1).label, zh['cost.agentTurn'])
})

test('页数不变量：装配出的页数恒等于 pageCount(子代理数)，且没有子代理的行不进页', () => {
  for (const count of [0, 1, 2, 5]) {
    const rows = Array.from({ length: count }, (_, index) => subRow({ id: `k${String(index)}` }))
    const pages = agentPages(t, {
      own: ledger(buckets(0, 10, 0), buckets(0, 10, 0)),
      ownTotalLabel: 'cost.ownTotal',
      ownModelOnSinglePage: false,
      subagents: source(rows),
    })
    assert.equal(pages.length, pageCount(count))
  }
})

// ------------------------------------------------------------------ 文案字典

test('新增的分页文案在 zh/en 里成对存在，且都不含插值占位符', () => {
  const added = [
    'cost.mainAgent', 'cost.agentsLead', 'cost.agentsTail', 'cost.agentTurn',
    'cost.turnLead', 'cost.turnTail', 'cost.turnSep', 'cost.turnMark',
    'cost.attributedExact', 'cost.ownTurnTotal', 'cost.prevPage', 'cost.nextPage',
  ]
  for (const key of added) {
    assert.equal(typeof zh[key], 'string', `zh 缺少 ${key}`)
    assert.equal(typeof en[key], 'string', `en 缺少 ${key}`)
    for (const value of [zh[key], en[key]]) {
      assert.ok(!/[{}%$]|\{n\}/.test(value), `文案不应含占位符: ${value}`)
    }
  }
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
})
