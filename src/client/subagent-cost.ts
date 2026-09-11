/**
 * 子代理花费聚合（**纯函数**，无 React、无 DSH 运行时依赖，可直接单测）。
 *
 * ## 为什么聚合发生在客户端
 *
 * 每个会话的 `turnCost` 投影**只折叠它自己的日志**（这是本插件的纯度底线：
 * 父会话的值必须能被持久缓存与重放一致地重建）。而父会话的日志里**没有**子会话
 * 的用量：`subagent/catalog`（父会话自有事实）只带 `childId` / 创建时刻 / 形态 /
 * 标签，用量事件全部在**子会话自己的日志**里（证据见 DESIGN.md §11）。
 *
 * 因此"父会话把子代理花费算进来"只能是一次**客户端聚合**：父会话的 `turnCost`
 * 加上各子会话 `turnCost` 的 `ownTurns`。客户端读别的会话投影走的是官方通道 ——
 * 会话列表状态 `useSessions(state => state.byId)` 里每一行的 `projectionValues`
 * （host 为每一行算好的、已校验的 wire 值），官方自己的 ui-subagent 也是这样读
 * 子会话的 `subagentTiming` / `tokenUsage` 的。
 *
 * ## 归属规则（哪一轮的子代理花费算哪一轮）
 *
 * 框架**没有**给出"子会话的第 N 轮属于父会话的第 M 轮"这样一条显式边。本模块用
 * 两条依次降级的规则：
 *
 * 1. **时间窗**：取子会话自己那一轮 `turnCost.ownTurns[k].startedAt`（host 从
 *    子会话日志的 `turn/start` 折叠），落到**本会话最后一个不晚于它的轮起点**上
 *    （`ownTurns[t].startedAt`）。子会话的一轮总是被"触发它的那次父会话工具调用"
 *    所在的那一轮包住，所以这条规则对一次性子代理（父会话 await 结果）是精确的，
 *    对可持续子代理的后续激活也是"触发轮"（激活时机就在那一轮里）。
 * 2. **创建锚点兜底**：子会话那一轮没有起点时刻（老日志 / 缺 `turn/start`）时，
 *    退回父会话日志里 `subagent/catalog` 记录的创建轮（`spawns[childId].turn`）；
 *    跨层后代则先把祖先那一轮映射上来。这种行标 `exact: false`，UI 会显式标注。
 *
 * 两条都用不上（既无时刻、又无锚点，例如目标会话不在会话列表里）时，该笔花费只
 * 计入**会话合计**、不落到任何一轮，并计入 `unattributed`。
 *
 * 已知边界（如实记录，不掩饰）：
 *   * 后台/可持续子代理可能在父会话某一轮**结束后**继续跑；它的花费按"触发轮"
 *     归属（时间窗规则取的是那一轮的起点），而不是按它实际消耗的时刻摊到多轮。
 *   * 只聚合**会话列表里可见**的后代；列表里没有的会话（已被删除、未加载）看不见。
 *   * 子会话的 `turnCost` 缺失（例如该会话还没被折叠过）时该子会话不参与聚合：
 *     宁可少显示，不猜。
 *   * 子会话的值来自"插件新增自身口径之前写下的持久缓存行"时（`ownComplete !== true`），
 *     退回整段日志口径并把归属标注为近似 —— 不让这个子会话从父会话总账里静默消失。
 *
 * @module dsh-turn-cost/client/subagent-cost
 */

import type { CostBucketsTotal, TokenBucketsTotal, TurnCostProjection } from '../types.ts'

/** 我们真正会读的会话行（结构化声明，避免依赖 DSH 内部类型）。 */
export interface SubagentSessionRow {
  readonly id: string
  readonly parentId?: string
  readonly origin?: 'subagent'
  readonly title?: string
  readonly displayTitle?: string
  readonly projectionValues?: { readonly turnCost?: TurnCostProjection } | undefined
}

/** 一条后代行（会话弹窗里的"子代理"明细）。 */
export interface SubagentCostRow {
  /** 子会话 id。 */
  readonly id: string
  /** 展示标签（会话标题 → 创建标签 → id 前缀）。 */
  readonly label: string
  /** 1 = 直接子会话，2 = 孙会话…… */
  readonly depth: number
  /** 该子会话**自己**的花费（µ¥），不含它的后代（那些各算一行）。 */
  readonly cost: number
  /** 该子会话自己的 token 合计。 */
  readonly tokens: number
  /** 生命周期形态（来自父会话日志的目录事实）；`unknown` = 该锚点不可见。 */
  readonly mode: 'one-shot' | 'continuable' | 'unknown'
  /** 归属是否全部按时间窗精确落轮（false 表示用过创建锚点兜底，或干脆没落轮）。 */
  readonly exact: boolean
  /** 该子会话被归属到的本会话轮次（升序）。 */
  readonly turns: readonly number[]
}

/**
 * 一个子代理的**展开细目**（弹窗里"该子代理一页"要用的三桶与模型）。
 *
 * 为什么不直接塞进 {@link SubagentCostRow}：`rows` 是**列表行**（聚合列表只需
 * 金额 / 归属），细目是**展开页**才用的第二层信息；两者按 `id` 关联，行的形状
 * 保持不变，列表渲染与既有断言都不受影响。
 */
export interface SubagentCostDetail {
  /** 该子代理自己（不含它的后代）的三桶金额（µ¥）。 */
  readonly cost: CostBucketsTotal
  /** 该子代理自己的三桶 token。 */
  readonly tok: TokenBucketsTotal
  /** 该子代理用过的模型（去重、按首次出现序）；读不出时为空。 */
  readonly models: readonly string[]
}

/** 一段花费切片（会话级 / 某一轮）。 */
export interface SubagentCostSlice {
  /** 花费（µ¥）。 */
  readonly cost: number
  /** token 合计。 */
  readonly tokens: number
  readonly rows: readonly SubagentCostRow[]
  /** 该切片的三桶金额合计（= 切片内全部子代理之和）。 */
  readonly costBuckets: CostBucketsTotal
  /** 该切片的三桶 token 合计。 */
  readonly tokBuckets: TokenBucketsTotal
  /** 逐子代理细目，键与 `rows[].id` 一致。 */
  readonly details: Readonly<Record<string, SubagentCostDetail>>
}

/** 本会话全部后代的花费汇总。 */
export interface SubagentCostRollup extends SubagentCostSlice {
  /** 有花费的后代会话数。 */
  readonly count: number
  /** 没能落到任何一轮的后代花费（µ¥）：只进会话合计。 */
  readonly unattributed: number
  /** 按本会话轮次归属的切片，键为 turn 号字符串。 */
  readonly byTurn: Readonly<Record<string, SubagentCostSlice>>
}

/** 空汇总（无后代 / 数据不可用时的安全牌）。 */
export const NO_SUBAGENTS: SubagentCostRollup = {
  cost: 0,
  tokens: 0,
  rows: [],
  count: 0,
  unattributed: 0,
  byTurn: {},
  costBuckets: { hit: 0, miss: 0, out: 0, total: 0 },
  tokBuckets: { hit: 0, miss: 0, out: 0, total: 0 },
  details: {},
}

/** 安全取非负整数。 */
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/** 全零三桶金额。 */
function zeroCost(): CostBucketsTotal {
  return { hit: 0, miss: 0, out: 0, total: 0 }
}

/** 全零三桶 token。 */
function zeroTok(): TokenBucketsTotal {
  return { hit: 0, miss: 0, out: 0, total: 0 }
}

/** 把来源的三桶金额（清洗为非负整数）累加进目标。 */
function addCost(target: CostBucketsTotal, source: Partial<CostBucketsTotal> | undefined): void {
  target.hit += countOf(source?.hit)
  target.miss += countOf(source?.miss)
  target.out += countOf(source?.out)
  target.total += countOf(source?.total)
}

/** 把来源的三桶 token（清洗为非负整数）累加进目标。 */
function addTok(target: TokenBucketsTotal, source: Partial<TokenBucketsTotal> | undefined): void {
  target.hit += countOf(source?.hit)
  target.miss += countOf(source?.miss)
  target.out += countOf(source?.out)
  target.total += countOf(source?.total)
}

/**
 * 该会话日志里出现过的模型（去重、按轮次顺序）；读不出时为空数组。
 *
 * 两个 pill 的"主 Agent 页"要显示模型，而投影的 `totals` 不带模型（模型在逐轮条目
 * 上），因此这里按轮次把模型收集起来 —— 跨模型会话会列出全部，不假装只有一个。
 * @param view - 任一会话的 `turnCost` 投影。
 * @returns 模型 id 列表。
 */
export function modelsOfView(view: TurnCostProjection | undefined): string[] {
  const seen = new Set<string>()
  const models: string[] = []
  for (const key of Object.keys(view?.turns ?? {})) {
    const model = view?.turns?.[key]?.model
    if (typeof model !== 'string' || model === '' || seen.has(model)) continue
    seen.add(model)
    models.push(model)
  }
  return models
}

/** 一个会话的轮起点表（升序）。 */
interface TurnStart {
  turn: number
  at: number
}

function turnStartsOf(view: TurnCostProjection | undefined): TurnStart[] {
  const own = view?.ownTurns
  if (own === undefined || own === null) return []
  const starts: TurnStart[] = []
  for (const key of Object.keys(own)) {
    const turn = Number(key)
    const at = own[key]?.startedAt
    if (!Number.isFinite(turn) || typeof at !== 'number' || !Number.isFinite(at)) continue
    starts.push({ turn, at })
  }
  starts.sort((left, right) => left.at - right.at || left.turn - right.turn)
  return starts
}

/** 本会话里**最后一个不晚于 `at`** 的轮次；没有则 null。 */
function turnAtOrBefore(starts: readonly TurnStart[], at: number): number | null {
  let found: number | null = null
  for (const start of starts) {
    if (start.at > at) break
    found = start.turn
  }
  return found
}

/** 该会话自己那一轮的花费与 token（自身口径未覆盖整段日志时退回整段日志口径）。 */
interface OwnTurnSlice {
  turn: number
  cost: CostBucketsTotal
  tok: TokenBucketsTotal
  startedAt: number | null
}

function ownTurnsOf(view: TurnCostProjection | undefined): {
  turns: readonly OwnTurnSlice[]
  legacy: boolean
} {
  const own = view?.ownTurns
  // `ownComplete !== true` ⇒ 这个值是从"插件新增自身口径之前写下的持久缓存行"恢复的：
  // 自身口径只覆盖恢复点之后的事件，用它会把前面的花费丢掉。退回整段日志口径
  // （与"该会话自己的 pill"同源），并把归属标注为近似。
  if (own === undefined || own === null || view?.ownComplete !== true) {
    const turns = Object.keys(view?.turns ?? {}).flatMap((key) => {
      const entry = view?.turns?.[key]
      const turn = Number(key)
      if (entry === undefined || !Number.isFinite(turn)) return []
      const cost = zeroCost()
      const tok = zeroTok()
      addCost(cost, entry.cost)
      addTok(tok, entry.tok)
      return [{ turn, cost, tok, startedAt: null }]
    })
    return { turns, legacy: true }
  }
  const turns = Object.keys(own).flatMap((key) => {
    const entry = own[key]
    const turn = Number(key)
    if (entry === undefined || !Number.isFinite(turn)) return []
    const startedAt = entry.startedAt
    const cost = zeroCost()
    const tok = zeroTok()
    addCost(cost, entry.cost)
    addTok(tok, entry.tok)
    return [{
      turn,
      cost,
      tok,
      startedAt: typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : null,
    }]
  })
  return { turns, legacy: false }
}

/** 一个后代的静态事实（走一遍列表得到）。 */
interface Descendant {
  row: SubagentSessionRow
  depth: number
  ownerId: string
}

/** 取"某会话创建某子会话"的锚点轮号；`0` / 缺失表示未知。 */
function anchorTurnOf(
  owner: SubagentSessionRow | undefined,
  childId: string,
): { turn: number; mode: 'one-shot' | 'continuable' | 'unknown' } | null {
  const spawn = owner?.projectionValues?.turnCost?.spawns?.[childId]
  if (spawn === undefined || spawn === null) return null
  return {
    turn: countOf(spawn.turn),
    mode: spawn.mode === 'one-shot' || spawn.mode === 'continuable' ? spawn.mode : 'unknown',
  }
}

/**
 * 收集 `rootId` 的全部后代（含孙代；沿 `origin === 'subagent'` + `parentId` 向上
 * 回溯，带回环保护）。列表里断链的后代看不见 —— 也不可能有它们的投影值。
 */
function descendantsOf(
  rootId: string,
  sessions: readonly SubagentSessionRow[],
): Descendant[] {
  const byId = new Map<string, SubagentSessionRow>()
  for (const session of sessions) byId.set(session.id, session)
  const found: Descendant[] = []
  for (const session of sessions) {
    if (session.origin !== 'subagent' || session.parentId === undefined) continue
    const seen = new Set<string>([session.id])
    let current: SubagentSessionRow | undefined = session
    let depth = 0
    while (current !== undefined && current.origin === 'subagent' && current.parentId !== undefined) {
      if (seen.has(current.parentId)) {
        current = undefined
        break
      }
      seen.add(current.parentId)
      depth += 1
      if (current.parentId === rootId) {
        // `session.parentId` 才是这条后代的**直接**父会话：锚点事实记在它自己的
        // 日志里（`spawns`），跨层后代必须从直接父会话出发沿链换算。
        found.push({ row: session, depth, ownerId: session.parentId })
        break
      }
      current = byId.get(current.parentId)
      if (current === undefined) break
    }
  }
  return found
}

/**
 * 汇总 `rootId` 全部后代的花费，并按本会话轮次归属。
 * @param rootId - 当前会话 id。
 * @param sessions - 会话列表里的全部行（`useSessions(state => state.byId)` 的值）。
 * @param rootView - 当前会话自己的 `turnCost` 投影（轮起点表来自它）。
 * @returns 汇总；没有后代或数据不可用时返回 {@link NO_SUBAGENTS} 等价的空汇总。
 */
export function rollupSubagentCost(
  rootId: string,
  sessions: readonly SubagentSessionRow[],
  rootView: TurnCostProjection | undefined,
): SubagentCostRollup {
  const descendants = descendantsOf(rootId, sessions)
  if (descendants.length === 0) return NO_SUBAGENTS

  const byId = new Map<string, SubagentSessionRow>()
  for (const session of sessions) byId.set(session.id, session)

  const rootStarts = turnStartsOf(rootView)

  /** 祖先链兜底：把"某祖先会话的某一轮"换算成本会话的轮次。 */
  const resolveTurn = (ownerId: string, turn: number, seen: Set<string>): number | null => {
    if (ownerId === rootId) return turn > 0 ? turn : null
    if (seen.has(ownerId)) return null
    seen.add(ownerId)
    const owner = byId.get(ownerId)
    if (owner === undefined) return null
    const startAt = turnStartsOf(owner.projectionValues?.turnCost)
      .find(entry => entry.turn === turn)?.at
    if (startAt !== undefined) {
      const mapped = turnAtOrBefore(rootStarts, startAt)
      if (mapped !== null) return mapped
    }
    const ownerOfOwner = owner.parentId
    if (ownerOfOwner === undefined) return null
    const anchor = anchorTurnOf(byId.get(ownerOfOwner), ownerId)
    return anchor === null ? null : resolveTurn(ownerOfOwner, anchor.turn, seen)
  }

  const rows: SubagentCostRow[] = []
  /** 某一轮的切片累加器（行 + 三桶 + 逐代理细目）。 */
  interface SliceAccumulator {
    cost: number
    tokens: number
    rows: SubagentCostRow[]
    costBuckets: CostBucketsTotal
    tokBuckets: TokenBucketsTotal
    details: Record<string, SubagentCostDetail>
  }
  const perTurn = new Map<string, SliceAccumulator>()
  const details: Record<string, SubagentCostDetail> = {}
  const totalCostBuckets = zeroCost()
  const totalTokBuckets = zeroTok()
  let total = 0
  let totalTokens = 0
  let unattributed = 0
  let count = 0

  for (const descendant of descendants) {
    const view = descendant.row.projectionValues?.turnCost
    const own = ownTurnsOf(view)
    const anchor = anchorTurnOf(byId.get(descendant.ownerId), descendant.row.id)
    const label = labelOf(descendant.row, anchorLabelOf(byId.get(descendant.ownerId), descendant.row.id))
    const mode = anchor === null ? 'unknown' as const : anchor.mode
    const models = modelsOfView(view)

    /** 逐轮归属：先时间窗，再创建锚点兜底；两者都没有则只进会话合计。 */
    const place = (startedAt: number | null): { key: string; exact: boolean } | null => {
      const mapped = startedAt === null ? null : turnAtOrBefore(rootStarts, startedAt)
      if (mapped !== null) return { key: String(mapped), exact: true }
      const fallback = anchor === null ? null : resolveTurn(descendant.ownerId, anchor.turn, new Set())
      return fallback === null ? null : { key: String(fallback), exact: false }
    }

    let cost = 0
    let tokens = 0
    let exact = !own.legacy
    const attributed = new Set<number>()
    const rowCost = zeroCost()
    const rowTok = zeroTok()

    for (const turn of own.turns) {
      cost += turn.cost.total
      tokens += turn.tok.total
      addCost(rowCost, turn.cost)
      addTok(rowTok, turn.tok)
      const placed = place(turn.startedAt)
      if (placed === null) {
        exact = false
        unattributed += turn.cost.total
        continue
      }
      if (!placed.exact) exact = false
      attributed.add(Number(placed.key))
      const slice = perTurn.get(placed.key) ?? {
        cost: 0, tokens: 0, rows: [], costBuckets: zeroCost(), tokBuckets: zeroTok(), details: {},
      }
      slice.cost += turn.cost.total
      slice.tokens += turn.tok.total
      addCost(slice.costBuckets, turn.cost)
      addTok(slice.tokBuckets, turn.tok)
      slice.rows.push({
        id: descendant.row.id,
        label,
        depth: descendant.depth,
        cost: turn.cost.total,
        tokens: turn.tok.total,
        mode,
        exact: placed.exact,
        turns: [Number(placed.key)],
      })
      // 同一个子代理可能有多轮落进同一轮（可持续子代理）：细目按 id 累加。
      const sliceDetail = slice.details[descendant.row.id] ?? { cost: zeroCost(), tok: zeroTok(), models }
      addCost(sliceDetail.cost, turn.cost)
      addTok(sliceDetail.tok, turn.tok)
      slice.details[descendant.row.id] = sliceDetail
      perTurn.set(placed.key, slice)
    }

    if (cost <= 0 && tokens <= 0) continue
    count += 1
    total += cost
    totalTokens += tokens
    addCost(totalCostBuckets, rowCost)
    addTok(totalTokBuckets, rowTok)
    details[descendant.row.id] = { cost: rowCost, tok: rowTok, models }
    rows.push({
      id: descendant.row.id,
      label,
      depth: descendant.depth,
      cost,
      tokens,
      mode,
      exact,
      turns: [...attributed].sort((left, right) => left - right),
    })
  }

  if (count === 0) return NO_SUBAGENTS

  rows.sort((left, right) => left.depth - right.depth
    || right.cost - left.cost
    || left.id.localeCompare(right.id))

  const byTurn: Record<string, SubagentCostSlice> = {}
  for (const [key, slice] of perTurn) {
    byTurn[key] = {
      cost: slice.cost,
      tokens: slice.tokens,
      rows: slice.rows.sort((left, right) => left.depth - right.depth
        || right.cost - left.cost
        || left.id.localeCompare(right.id)),
      costBuckets: slice.costBuckets,
      tokBuckets: slice.tokBuckets,
      details: slice.details,
    }
  }

  return {
    cost: total,
    tokens: totalTokens,
    rows,
    count,
    unattributed,
    byTurn,
    costBuckets: totalCostBuckets,
    tokBuckets: totalTokBuckets,
    details,
  }
}

/** 该子会话在创建锚点里的标签（来自父会话日志的 `subagent/catalog`）。 */
function anchorLabelOf(owner: SubagentSessionRow | undefined, childId: string): string | undefined {
  const spawn = owner?.projectionValues?.turnCost?.spawns?.[childId]
  return typeof spawn?.label === 'string' && spawn.label !== '' ? spawn.label : undefined
}

/** 展示标签：会话标题 → 创建标签 → id 前 8 位。 */
function labelOf(row: SubagentSessionRow, anchorLabelValue: string | undefined): string {
  const title = row.title ?? row.displayTitle
  if (typeof title === 'string' && title !== '') return title
  if (anchorLabelValue !== undefined) return anchorLabelValue
  return row.id.length > 8 ? row.id.slice(0, 8) : row.id
}
