/**
 * 真实会话日志回放验证（开发/验收工具，不参与插件运行）。
 *
 * 做三件事：
 *   1. 读 DSH 的会话日志（`sessions/<cwd>/<sessionId>/session.v3.jsonl.zstd`，
 *      Node 内置 zstd 解压）；
 *   2. 用本插件的 `turnCost` 折叠算出每轮 / 会话花费；
 *   3. **同时**用一份原生 `tokenUsage` 投影算法的复刻算出 token 总量，与我们的
 *      token 桶逐项对比 —— 一致即证明"账目口径与原生「用量」pill 相同，差异只在
 *      于我们额外乘了官方单价"。
 *
 * 加 `--tree` 还会扫描同一 `<sessions>/<cwd>/` 下的**子会话日志**（父会话日志里只
 * 有 `subagent/catalog` 目录事实、没有子会话用量），用**客户端那份纯函数**
 * `rollupSubagentCost` 做一次真实的树聚合：打印"自身 / 子代理 / 含子代理合计"和
 * 每轮的归属结果 —— 也就是说，这里跑的就是 UI 将来显示的那条计算路径。
 *
 * 加 `--pages` 会用客户端装配弹窗页列表的同一份纯函数（`agentPages`）把**每页内容**打出来：
 * 会话弹窗（总计 / 主 Agent / 每个子代理）与有子代理的每一轮弹窗 —— 不打开浏览器也能
 * 核对分页后的文案与数字落位。
 *
 * 用法：
 *   node scripts/replay-session.mjs <session-目录或 .jsonl.zstd 文件> [--tree] [--json] [--pages]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { createTurnCostProjection } from '../lib/projection.js'
import { rollupSubagentCost } from '../lib/client/subagent-cost.js'

/** 找到会话日志文件。 */
function locate(input) {
  const stats = statSync(input)
  if (stats.isFile()) return input
  const candidate = readdirSync(input).find(name => name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl'))
  if (candidate === undefined) throw new Error(`目录里没有会话日志: ${input}`)
  return join(input, candidate)
}

/** zstd 帧魔数。 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/**
 * 解压"多帧拼接"的 zstd 日志。
 *
 * DSH 的会话日志是**边追加边压**的：每次 flush 追加一个独立 zstd 帧，而 Node 内置
 * 的 `zstdDecompressSync` 只解第一帧。这里按帧魔数切分后逐帧解压；若某片解不出
 * （压缩数据里恰好出现同样的字节序列），就往后多吞一片重试。
 * @param raw - 整个文件的字节。
 * @returns {{ text: string, frames: number, failures: number }}
 */
function decompressFrames(raw) {
  if (!(raw[0] === ZSTD_MAGIC[0] && raw[1] === ZSTD_MAGIC[1])) return { text: raw.toString('utf8'), frames: 1, failures: 0 }
  const offsets = []
  for (let index = 0; index + 3 < raw.length; index += 1) {
    if (raw[index] === ZSTD_MAGIC[0] && raw[index + 1] === ZSTD_MAGIC[1]
      && raw[index + 2] === ZSTD_MAGIC[2] && raw[index + 3] === ZSTD_MAGIC[3]) offsets.push(index)
  }
  if (offsets[0] !== 0) offsets.unshift(0)
  const parts = []
  let failures = 0
  for (let index = 0; index < offsets.length; index += 1) {
    let decoded
    for (let extend = index + 1; extend <= offsets.length; extend += 1) {
      const end = extend < offsets.length ? offsets[extend] : raw.length
      try {
        decoded = zstdDecompressSync(raw.subarray(offsets[index], end))
        index = extend - 1
        break
      } catch {
        // 这一片不是完整帧：吞下一片再试。
      }
    }
    if (decoded === undefined) failures += 1
    else parts.push(decoded)
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: offsets.length, failures }
}

/** 读日志 → 事件数组。 */
function readEvents(file) {
  const raw = readFileSync(file)
  const { text, frames, failures } = decompressFrames(raw)
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed)
      if (typeof parsed?.type === 'string') events.push(parsed)
    } catch {
      // 尾部半行等：忽略。
    }
  }
  return { events, frames, failures, bytes: text.length }
}

/**
 * 只读日志首行（会话 header）：从文件头部按 64 KiB / 256 KiB / 1 MiB 递增地
 * 解压，够第一行就停 —— 扫一遍会话目录时不必解压每个会话的全部历史。
 * @param file - 日志文件路径。
 * @returns header 对象，读不出返回 null。
 */
function readHeader(file) {
  const raw = readFileSync(file)
  for (const budget of [64 * 1024, 256 * 1024, 1024 * 1024, raw.length]) {
    const slice = raw.subarray(0, Math.min(budget, raw.length))
    try {
      const { text } = decompressFrames(slice)
      const line = text.split('\n').find(entry => entry.trim() !== '')
      if (line === undefined) continue
      const parsed = JSON.parse(line)
      if (parsed?.type === 'session') return parsed
    } catch {
      // 帧没解全：加预算再来。
    }
    if (budget >= raw.length) break
  }
  return null
}

/** 会话日志文件名（目录里第一个 .jsonl(.zstd)）。 */
function sessionFileIn(dir) {
  const name = readdirSync(dir).find(entry => entry.endsWith('.jsonl.zstd') || entry.endsWith('.jsonl'))
  return name === undefined ? undefined : join(dir, name)
}

/**
 * 扫出以 `rootFile` 所属会话为根的整棵会话树（父会话 → 全部后代）。
 *
 * 事实来源与插件一致：子会话 header 里的 `parentSession` / `origin`。扫的是同一
 * `<sessions>/<cwd>/` 目录（DSH 按 cwd 分目录，子会话与父会话同 cwd）。
 * @param rootFile - 根会话日志文件。
 * @returns `{ rootId, rows, errors }`；rows 为会话行（含折叠好的投影值）。
 */
function loadTree(rootFile) {
  const rootDir = dirname(resolve(rootFile))
  const cwdDir = dirname(rootDir)
  const rootHeader = readHeader(rootFile)
  const rootId = rootHeader?.id ?? null
  const byParent = new Map()
  const logs = new Map()
  let entries
  try {
    entries = readdirSync(cwdDir, { withFileTypes: true }).filter(entry => entry.isDirectory())
  } catch {
    entries = []
  }
  for (const entry of entries) {
    const dir = join(cwdDir, entry.name)
    const file = sessionFileIn(dir)
    if (file === undefined) continue
    const header = readHeader(file)
    if (header?.id === undefined) continue
    logs.set(header.id, { file, header })
    if (header.parentSession !== undefined) {
      const list = byParent.get(header.parentSession) ?? []
      list.push(header.id)
      byParent.set(header.parentSession, list)
    }
  }
  const rows = []
  const views = new Map()
  const ids = []
  const queue = rootId === null ? [] : [rootId]
  while (queue.length > 0) {
    const id = queue.shift()
    if (ids.includes(id)) continue
    ids.push(id)
    for (const childId of byParent.get(id) ?? []) queue.push(childId)
  }
  for (const id of ids) {
    const log = logs.get(id)
    if (log === undefined) continue
    const { events } = readEvents(log.file)
    const definition = createTurnCostProjection()
    // 与 host 注册表同参数：fork 继承前缀长度来自会话自身（此处日志即全量，前缀为 0）。
    let state = definition.init(log.header, 0)
    for (const event of events) state = definition.apply(state, event)
    const projection = definition.wire.view(state)
    views.set(id, { projection, events })
    rows.push({
      id,
      ...(log.header.parentSession === undefined ? {} : { parentId: log.header.parentSession }),
      ...(log.header.origin === undefined ? {} : { origin: log.header.origin }),
      ...(log.header.isSeeded === true ? { seeded: true } : {}),
      projectionValues: { turnCost: projection },
    })
  }
  return { rootId, rows, views }
}

// ---------------------------------------------------- 原生 tokenUsage 复刻
// 逐条对齐 packages/llm/token-meter/src/usage-projection.ts 的折叠语义。
const zero = () => ({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
const bucketsOf = usage => ({
  uncachedInputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cacheReadTokens: usage.cacheReadTokens ?? 0,
  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
})
const equal = (a, b) => a.uncachedInputTokens === b.uncachedInputTokens && a.outputTokens === b.outputTokens
  && a.cacheReadTokens === b.cacheReadTokens && a.cacheWriteTokens === b.cacheWriteTokens

function lastStreamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
    if (record?.type === 'usage') return record.usage
  }
  return undefined
}

function usageOf(event) {
  if (event.type === 'assistant/message' && event.data?.usage !== undefined) return event.data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  return lastStreamUsage(event.data?.stream)
}

function nativeTokenUsage(events) {
  let totals = zero()
  let last = null
  for (const event of events) {
    if (event.type === 'llm/retry-started') {
      if (last !== null && last.turn === event.data?.turn && last.step === event.data?.step) last = null
      continue
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const usage = usageOf(event)
    if (usage === undefined || typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') continue
    const buckets = bucketsOf(usage)
    const { turn, step } = event.data ?? {}
    const previous = last !== null && last.turn === turn && last.step === step ? last.buckets : undefined
    if (previous !== undefined && equal(previous, buckets)) continue
    totals = {
      uncachedInputTokens: totals.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + buckets.uncachedInputTokens,
      outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + buckets.outputTokens,
      cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + buckets.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + buckets.cacheWriteTokens,
    }
    last = { turn, step, buckets }
  }
  return totals
}

// ------------------------------------------------------------------- 主流程
const input = process.argv[2]
if (input === undefined) {
  console.error('用法: node scripts/replay-session.mjs <session-目录或日志文件> [--json]')
  process.exit(2)
}
const asJson = process.argv.includes('--json')
const file = locate(input)
const { events, frames, failures, bytes } = readEvents(file)

const definition = createTurnCostProjection()
let state = definition.init()
for (const event of events) state = definition.apply(state, event)
const view = definition.wire.view(state)
const native = nativeTokenUsage(events)

const yuan = micro => `¥${(micro / 1e6).toFixed(6)}`
const turns = Object.keys(view.turns).map(Number).sort((a, b) => a - b)
const rows = turns.map(turn => {
  const entry = view.turns[String(turn)]
  return {
    turn,
    model: entry.model,
    period: entry.peak ? 'peak' : 'valley',
    priceAsOf: entry.asOf ?? view.priceAsOf,
    tokens: entry.tok,
    costMicro: entry.cost,
    costYuan: {
      hit: yuan(entry.cost.hit), miss: yuan(entry.cost.miss), out: yuan(entry.cost.out), total: yuan(entry.cost.total),
    },
    estimated: entry.est === true,
  }
})

const tokenMatch = view.totals.tok.hit === native.cacheReadTokens
  && view.totals.tok.miss === native.uncachedInputTokens
  && view.totals.tok.out === native.outputTokens

const summary = {
  file,
  frames,
  frameFailures: failures,
  decodedBytes: bytes,
  events: events.length,
  turns: rows.length,
  totalCostYuan: yuan(view.totals.cost.total),
  totalCostMicro: view.totals.cost.total,
  tokenTotalsOurs: view.totals.tok,
  tokenTotalsNativeReplica: {
    hit: native.cacheReadTokens,
    miss: native.uncachedInputTokens,
    out: native.outputTokens,
  },
  tokenAccountingMatchesNative: tokenMatch,
  cacheWriteTokensSeen: native.cacheWriteTokens,
  rows,
}

if (asJson) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  console.log(`日志: ${file}`)
  console.log(`事件 ${events.length} 条，折叠出 ${rows.length} 轮`)
  console.log('')
  console.log('轮次  时段    模型                          命中/tokens  未命中/tokens  输出/tokens   命中¥        未命中¥      输出¥        合计¥')
  for (const row of rows) {
    console.log([
      String(row.turn).padStart(3),
      row.period.padEnd(6),
      (row.model || '(未知)').padEnd(28),
      String(row.tokens.hit).padStart(11),
      String(row.tokens.miss).padStart(13),
      String(row.tokens.out).padStart(12),
      row.costYuan.hit.padStart(11),
      row.costYuan.miss.padStart(12),
      row.costYuan.out.padStart(12),
      row.costYuan.total.padStart(12),
    ].join(' '))
  }
  console.log('')
  console.log(`会话自身累计: ${summary.totalCostYuan}  ` +
    `(命中 ${view.totals.tok.hit} / 未命中 ${view.totals.tok.miss} / 输出 ${view.totals.tok.out} tokens)`)
  console.log(`token 口径与原生 tokenUsage 投影一致: ${tokenMatch ? '是 ✓' : '否 ✗'}`)
  if (native.cacheWriteTokens !== 0) console.log(`注意: 出现了 ${native.cacheWriteTokens} 个 cacheWrite token（DeepSeek 不该有）`)
}

// ---------------------------------------------------------------- 会话树聚合（--tree）
if (process.argv.includes('--tree')) {
  const tree = loadTree(file)
  const rootRow = tree.rows.find(row => row.id === tree.rootId)
  const rollup = rollupSubagentCost(tree.rootId, tree.rows, rootRow?.projectionValues.turnCost)
  const own = rootRow?.projectionValues.turnCost.totals.cost.total ?? 0
  const yuan = micro => `¥${(micro / 1e6).toFixed(6)}`

  // 逐会话自检：自身口径 = 整段口径（未 fork 时）且 token 与原生复刻一致。
  const checks = []
  for (const row of tree.rows) {
    const entry = tree.views.get(row.id)
    if (entry === undefined) continue
    const { projection, events: list } = entry
    const ownSum = Object.values(projection.ownTurns ?? {})
      .reduce((sum, turn) => sum + turn.cost.total, 0)
    const full = projection.totals.cost.total
    const replica = nativeTokenUsage(list)
    const nativeMatch = projection.totals.tok.hit === replica.cacheReadTokens
      && projection.totals.tok.miss === replica.uncachedInputTokens
      && projection.totals.tok.out === replica.outputTokens
    checks.push({
      id: row.id,
      self: row.id === tree.rootId,
      seeded: row.seeded === true,
      costYuan: yuan(full),
      ownCostYuan: yuan(ownSum),
      ownEqualsWhole: ownSum === full,
      ownTurnsExceedTotal: ownSum > full,
      nativeTokenMatch: nativeMatch,
      turns: Object.keys(projection.turns).length,
      spawns: Object.keys(projection.spawns ?? {}).length,
      costMicro: full,
      ownMicro: ownSum,
    })
  }

  const childCost = rollup.cost
  const treeTotal = own + childCost
  const childOwnSum = checks.filter(check => !check.self).reduce((sum, check) => sum + check.ownMicro, 0)
  const consistency = childOwnSum === childCost
  const overcount = checks.some(check => check.ownTurnsExceedTotal)

  const out = {
    rootId: tree.rootId,
    sessions: checks.length,
    ownCostMicro: own,
    subagentCostMicro: childCost,
    treeTotalMicro: treeTotal,
    ownCostYuan: yuan(own),
    subagentCostYuan: yuan(childCost),
    treeTotalYuan: yuan(treeTotal),
    subagentCount: rollup.count,
    unattributedMicro: rollup.unattributed,
    /** 逐会话自身口径之和 == 聚合出的子代理合计（防重复计数）。 */
    aggregationConsistent: consistency,
    /** 任一会话出现"自身口径 > 整段口径"即为折叠错误。 */
    ownTurnsWithinTotal: !overcount,
    /** 全部会话的 token 口径仍与原生 tokenUsage 复刻一致。 */
    allNativeTokenMatch: checks.every(check => check.nativeTokenMatch),
    checks,
    rows: rollup.rows,
    byTurn: rollup.byTurn,
  }

  if (asJson) {
    console.log(JSON.stringify(out, null, 2))
  } else {
    console.log('')
    console.log('===== 会话树聚合（客户端 rollupSubagentCost 的真实计算路径）=====')
    console.log('会话'.padEnd(44) + '轮 子代理 花费¥       自身¥       自身=整段 原生token')
    for (const check of checks) {
      console.log([
        (check.self ? '* ' : '  ') + check.id.padEnd(42),
        String(check.turns).padStart(2),
        String(check.spawns).padStart(5),
        check.costYuan.padStart(13),
        check.ownCostYuan.padStart(12),
        (check.ownEqualsWhole ? '是' : check.seeded ? '否(种子)' : '否').padEnd(9),
        check.nativeTokenMatch ? '✓' : '✗',
      ].join(' '))
    }
    console.log('')
    console.log(`本会话自身: ${out.ownCostYuan}    子代理(${out.subagentCount} 个): ${out.subagentCostYuan}    ` +
      `含子代理合计: ${out.treeTotalYuan}`)
    if (out.unattributedMicro > 0) console.log(`未归属到轮次的子代理花费: ${yuan(out.unattributedMicro)}`)
    const turns = Object.keys(out.byTurn).map(Number).sort((a, b) => a - b)
    if (turns.length > 0) {
      console.log('')
      console.log('轮次  该轮自身¥      该轮子代理¥    该轮合计¥      子代理明细')
      for (const turn of turns) {
        const entry = view.turns[String(turn)]
        const ownTurn = entry?.cost.total ?? 0
        const slice = out.byTurn[String(turn)]
        console.log([
          String(turn).padStart(3),
          yuan(ownTurn).padStart(12),
          yuan(slice.cost).padStart(14),
          yuan(ownTurn + slice.cost).padStart(13),
          `  ${slice.rows.map(row => `${row.label}=${yuan(row.cost)}${row.exact ? '' : '(锚点)'}`).join(', ')}`,
        ].join(' '))
      }
    }
    console.log('')
    console.log(`逐会话自身口径之和 == 子代理聚合合计: ${consistency ? '是 ✓' : '否 ✗'}`)
    console.log(`自身口径未超出整段口径（无重复计数）: ${overcount ? '否 ✗' : '是 ✓'}`)
    console.log(`全部会话 token 口径仍与原生 tokenUsage 复刻一致: ${out.allNativeTokenMatch ? '是 ✓' : '否 ✗'}`)
  }

  // -------------------------------------------------- 弹窗分页内容（--pages）
  // 跑的是客户端装配页列表的那份纯函数（`agentPages`）+ 真词典，因此这里打印的就是
  // 用户点开弹窗后逐页看到的内容 —— 不打开浏览器也能核对文案与数字落位。
  if (process.argv.includes('--pages')) {
    const { agentPages } = await import('../lib/client/dialog-pages.js')
    const { modelsOfView } = await import('../lib/client/subagent-cost.js')
    const { zh } = await import('../lib/client/locales.js')
    const t = key => zh[key] ?? String(key)
    const printPages = (heading, pages) => {
      console.log('')
      console.log(`----- ${heading}：共 ${pages.length} 页` +
        `${pages.length > 1 ? '（渲染翻页控件 ‹ n/N ›）' : '（单页，不渲染翻页控件）'} -----`)
      pages.forEach((page, index) => {
        console.log(`第 ${index + 1}/${pages.length} 页   标题合计 ${page.total}`)
        for (const row of page.rows) console.log(`    ${row.label} : ${row.value}`)
      })
    }
    const ownView = rootRow?.projectionValues.turnCost
    if (ownView !== undefined) {
      printPages('会话弹窗（会话累计 pill）', agentPages(t, {
        own: { cost: ownView.totals.cost, tok: ownView.totals.tok, models: modelsOfView(ownView) },
        ownTotalLabel: 'cost.ownTotal',
        ownModelOnSinglePage: false,
        subagents: rollup,
      }))
      const subagentTurns = Object.keys(rollup.byTurn).map(Number).sort((a, b) => a - b)
      for (const turn of subagentTurns) {
        const entry = ownView.turns[String(turn)]
        printPages(`每轮弹窗（第 ${turn} 轮 pill）`, agentPages(t, {
          own: {
            cost: entry?.cost ?? { hit: 0, miss: 0, out: 0, total: 0 },
            tok: entry?.tok ?? { hit: 0, miss: 0, out: 0, total: 0 },
            models: entry === undefined || entry.model === '' ? [] : [entry.model],
          },
          ownTotalLabel: 'cost.ownTurnTotal',
          ownModelOnSinglePage: true,
          subagents: rollup.byTurn[String(turn)],
        }))
      }
    }
  }
}
