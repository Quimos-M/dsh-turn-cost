/**
 * `turnCost` 投影单元 —— 本插件唯一的 host 侧物。
 *
 * 折叠规则（与原生 `tokenUsage` / `turn-usage` 的计费语义逐条对齐）：
 *   * 路由归因：优先取最近一次 `request/header` 的 `{provider, model}`，回退到
 *     `assistant/message.message.source`；
 *   * 计价：三桶 token ×（该模型在该请求时刻的官方单价，含峰谷）× ⇒ 微元整数；
 *   * 替换：同一 `(turn, step)` 的新样本**先减旧值再加新值**（流式样本会被最终
 *     样本覆盖，与原生一致）；
 *   * 重试：`llm/retry-started` 清掉替换槽，于是重试后的 attempt **累加**（失败
 *     重试的每一次请求都真实计费）；
 *   * 未收录模型 → 兜底档估算并标 `≈`；非计价 provider（默认只认
 *     `deepseek-official`）→ 跳过，不污染累计。
 *
 * **健壮性契约（本插件的硬要求）**：`apply` 被框架在**每个会话的每个事件**上
 * 同步调用（见 session-projection 的 drive/advanceCell），因此
 *   * `apply` 内部整体 try/catch，任何异常都返回原状态、绝不外抛；
 *   * `wire.view` 与两个 schema 的 `parse` 都是**全函数**（对任意输入都返回合法
 *     形状，永不抛错）—— 框架对 `viewSchema.parse` 没有 try/catch，抛错会顺着
 *     会话事件链路冒泡，那才会真的伤到宿主；
 *   * 状态是纯 JSON、不可变更新，无变化时返回同一引用（零下游工作）。
 *
 * @module dsh-turn-cost/projection
 */

import type { ZodType } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { PRICE_AS_OF, PRICE_REVISION, costOf, resolvePrice } from './prices.ts'
import type {
  CostBucketsMicro, TokenBuckets, TurnCostAccumulator, TurnCostEntry, TurnCostOwnTurn,
  TurnCostPlacement, TurnCostProjection, TurnCostSpawn, TurnCostState, TurnCostStateOwnTurn,
  TurnCostStateSpawn, TurnCostStateTurn,
} from './types.ts'

/** 投影键。 */
export const TURN_COST_KEY = 'turnCost'

/**
 * 折叠**结构演进**策略（重要取舍，勿轻易改回"改形状就 +stateVersion"）。
 *
 * 持久缓存行以 `(sessionId,key,ver)` 为准：`ver` 不匹配 ⇒ 整行作废、由零重折。
 * 那是"旧值语义已经错了"时的正确做法（例如价表改了）。但**加字段**不是那种情况：
 * 一个冷会话（未挂载）的旧行如果被作废，它的 wire 值就整体消失 —— 客户端据此
 * 聚合子代理花费时，这个子会话会**静默掉出父会话的总账**，直到该会话被重新折叠
 * （可能永远不发生：用户不会去点开每一个旧子会话）。
 *
 * 所以加字段时**不动 `stateVersion`**，改用显式的**覆盖标记**（状态里的
 * `ownComplete`）：由 `init`（从 seq 0 折起，覆盖整段日志）写 1，由 `stateSchema.parse`
 * （只可能出现在"从持久行恢复"的两条路径上）**保留**旧值、缺省 0。旧行因此照旧
 * 可用，只是客户端知道"这个值的自身口径没有覆盖整段日志"，从而退回整段口径的
 * 兼容读法并标注为近似（见 `src/client/subagent-cost.ts`）。
 *
 * 只有当一个改动会让**已有字段的语义**变得不可解释时，才在 `PRICE_REVISION`
 * 之外再加一个结构修订号（那就该作废旧行了）。
 */
const PROJECTION_STATE_VERSION = PRICE_REVISION

/** 直接子会话锚点：`subagent/catalog`（父会话自有事实，不带用量）。 */
const EVENT_SUBAGENT_CATALOG = 'subagent/catalog'

/** 默认计价 provider：DeepSeek 官方路由。 */
const DEFAULT_PRICED_PROVIDERS: readonly string[] = ['deepseek-official']

/** 插件配置（loader 条目的 config）。 */
export interface TurnCostOptions {
  /** 参与计价的路由 provider；`'*'` 表示按模型 id 计价一切路由。 */
  pricedProviders?: readonly string[]
  /** 关闭峰谷分时（一律谷价）。 */
  peakPricing?: boolean
  /** 每轮 pill 相对原生「用量 / 耗时」的落位。 */
  placement?: TurnCostPlacement
}

/** 解析后的配置。 */
interface ResolvedOptions {
  pricedProviders: readonly string[]
  peakPricing: boolean
  placement: TurnCostPlacement
}

/** 三桶样本。 */
interface UsageSample {
  hit: number
  miss: number
  out: number
}

// ------------------------------------------------------------------ 输入清洗

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function optionalCountOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function placementOf(value: unknown): TurnCostPlacement {
  return value === 'between' || value === 'after-time' || value === 'inline' ? value : 'before-usage'
}

/** 某个事件是否携带可用的 provider 用量样本。 */
function normalizeUsage(value: unknown): UsageSample | undefined {
  const usage = recordOf(value)
  const miss = optionalCountOf(usage.inputTokens)
  const out = optionalCountOf(usage.outputTokens)
  if (miss === null || out === null) return undefined
  return { hit: optionalCountOf(usage.cacheReadTokens) ?? 0, miss, out }
}

/** 在 assistant 流记录里找最后一条 usage chunk（与原生 lastAssistantStreamChunk 同源语义）。 */
function streamUsage(stream: unknown): unknown {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = recordOf(stream[index])
    if (record.type === 'usage') return record.usage
    if (record.type !== 'chunk') continue
    const chunk = recordOf(record.chunk)
    if (chunk.type === 'usage') return chunk.usage
  }
  return undefined
}

/** 从 `{provider, model}` 形状里取路由。 */
function routePair(value: unknown): { provider: string; model: string } | null {
  const source = recordOf(value)
  const provider = textOf(source.provider)
  const model = textOf(source.model)
  return provider === '' && model === '' ? null : { provider, model }
}

// ------------------------------------------------------------------ 折叠累加

function zeroAccumulator(): TurnCostAccumulator {
  return { costHit: 0, costMiss: 0, costOut: 0, tokHit: 0, tokMiss: 0, tokOut: 0 }
}

function addAccumulator(base: TurnCostAccumulator, delta: TurnCostAccumulator): TurnCostAccumulator {
  return {
    costHit: base.costHit + delta.costHit,
    costMiss: base.costMiss + delta.costMiss,
    costOut: base.costOut + delta.costOut,
    tokHit: base.tokHit + delta.tokHit,
    tokMiss: base.tokMiss + delta.tokMiss,
    tokOut: base.tokOut + delta.tokOut,
  }
}

/** 同一替换槽的新旧差：`next - previous`（previous 为 null 时即 next）。 */
function replaceDelta(next: TurnCostAccumulator, previous: TurnCostAccumulator | null): TurnCostAccumulator {
  if (previous === null) return next
  return {
    costHit: next.costHit - previous.costHit,
    costMiss: next.costMiss - previous.costMiss,
    costOut: next.costOut - previous.costOut,
    tokHit: next.tokHit - previous.tokHit,
    tokMiss: next.tokMiss - previous.tokMiss,
    tokOut: next.tokOut - previous.tokOut,
  }
}

function isPriced(provider: string, options: ResolvedOptions): boolean {
  if (provider === '') return true
  return options.pricedProviders.includes('*') || options.pricedProviders.includes(provider)
}

/** 事件序号（缺失/非数字一律当 0；序号只用于"是否属于继承前缀"的判定）。 */
function seqOf(event: SessionEvent): number {
  const seq = (event as { seq?: unknown }).seq
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : 0
}

/** 事件时刻（缺失/非法时返回 null，不写假时间）。 */
function timeOf(event: SessionEvent): number | null {
  const time = (event as { time?: unknown }).time
  return typeof time === 'number' && Number.isFinite(time) ? time : null
}

/** 在"自身视角"里加一笔（越界为负时钳到 0：正常路径不会触发，见 ownLast 注释）。 */
function addOwnTurn(
  base: TurnCostStateOwnTurn | undefined,
  delta: TurnCostAccumulator,
  startedAt: number | undefined,
): TurnCostStateOwnTurn {
  const previous = base ?? { costHit: 0, costMiss: 0, costOut: 0, tokHit: 0, tokMiss: 0, tokOut: 0 }
  const next: TurnCostStateOwnTurn = {
    costHit: Math.max(0, previous.costHit + delta.costHit),
    costMiss: Math.max(0, previous.costMiss + delta.costMiss),
    costOut: Math.max(0, previous.costOut + delta.costOut),
    tokHit: Math.max(0, previous.tokHit + delta.tokHit),
    tokMiss: Math.max(0, previous.tokMiss + delta.tokMiss),
    tokOut: Math.max(0, previous.tokOut + delta.tokOut),
  }
  const start = startedAt ?? previous.startedAt
  return start === undefined ? next : { ...next, startedAt: start }
}

/** 一次 usage 采样 → 新状态（替换语义 + 每轮/累计双写）。 */
function accrue(
  state: TurnCostState,
  event: SessionEvent,
  options: ResolvedOptions,
): TurnCostState {
  const data = recordOf((event as { data?: unknown }).data)
  const turn = optionalCountOf(data.turn)
  const step = optionalCountOf(data.step)
  if (turn === null || step === null) return state

  const usage = normalizeUsage(data.usage) ?? normalizeUsage(streamUsage(data.stream))
  if (usage === undefined) return state

  const route = routePair(recordOf(data.message).source) ?? state.header
  const provider = route?.provider ?? ''
  if (!isPriced(provider, options)) return state

  const model = route?.model ?? ''
  const at = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now()
  const price = resolvePrice(model, at, { peakPricing: options.peakPricing })
  const tokens: TokenBuckets = { hit: usage.hit, miss: usage.miss, out: usage.out }
  const money: CostBucketsMicro = costOf(tokens, price)

  const next: TurnCostAccumulator = {
    costHit: money.hit,
    costMiss: money.miss,
    costOut: money.out,
    tokHit: tokens.hit,
    tokMiss: tokens.miss,
    tokOut: tokens.out,
  }

  const key = String(turn)
  const previousTurn = state.turns[key]
  const sameSlot = state.last !== null && state.last.turn === turn && state.last.step === step
  const delta = replaceDelta(next, sameSlot ? state.last : null)

  const turnValue: TurnCostStateTurn = {
    ...addAccumulator(previousTurn ?? zeroAccumulator(), delta),
    peak: price.peak ? 1 : 0,
    model: model === '' ? previousTurn?.model ?? '' : model,
    ...price.asOf === state.asOf ? {} : { asOf: price.asOf },
    ...price.estimated || previousTurn?.est === 1 ? { est: 1 } : {},
  }

  // 逐键复制后只替换本轮：写进的是新对象，旧状态不被改动。
  const turns: Record<string, TurnCostStateTurn> = { ...state.turns }
  turns[key] = turnValue

  // 自身视角（只有本会话自己那段日志）：fork 继承前缀属于祖辈，不计入。
  // 它有自己的替换槽：若某次替换跨越了继承边界（理论上的病态情形），两个视角
  // 各自做减法也不会互相把对方的账减成负数。
  const ownSame = state.ownLast !== null && state.ownLast.turn === turn && state.ownLast.step === step
  const ownDelta = replaceDelta(next, ownSame ? state.ownLast : null)
  const owned = seqOf(event) >= state.inherited
  const ownTurns: Record<string, TurnCostStateOwnTurn> = { ...state.ownTurns }
  if (owned) {
    ownTurns[key] = addOwnTurn(ownTurns[key], ownDelta, undefined)
  }

  return {
    ...state,
    totals: addAccumulator(state.totals, delta),
    turns,
    last: { turn, step, ...next },
    ownTurns,
    ownLast: owned ? { turn, step, ...next } : state.ownLast,
  }
}

/** 单个事件的纯折叠（异常由调用方兜住）。 */
function fold(state: TurnCostState, event: SessionEvent, options: ResolvedOptions): TurnCostState {
  const data = recordOf((event as { data?: unknown }).data)
  switch ((event as { type?: unknown }).type) {
    case 'request/header': {
      const route = routePair(recordOf(recordOf(data.header).config))
      if (route === null) return state
      if (state.header !== null && state.header.provider === route.provider && state.header.model === route.model) {
        return state
      }
      return { ...state, header: route }
    }
    case 'llm/retry-started': {
      const turn = optionalCountOf(data.turn)
      const step = optionalCountOf(data.step)
      if (turn === null || step === null) return state
      const dropped = state.last !== null && state.last.turn === turn && state.last.step === step
      const droppedOwn = state.ownLast !== null && state.ownLast.turn === turn && state.ownLast.step === step
      if (!dropped && !droppedOwn) return state
      return {
        ...state,
        ...dropped ? { last: null } : {},
        ...droppedOwn ? { ownLast: null } : {},
      }
    }
    case 'turn/start': {
      // 轮边界：记下"当前轮"（子会话锚点靠它归属）与该轮起点（父会话靠它把子代理
      // 的某一轮落到自己的某一轮上）。继承前缀里的轮边界不属于本会话自己的轮次表。
      const turn = optionalCountOf(data.turn)
      if (turn === null) return state
      if (seqOf(event) < state.inherited) {
        return state.currentTurn === turn ? state : { ...state, currentTurn: turn }
      }
      const key = String(turn)
      const previous = state.ownTurns[key]
      // 起点**先到先得**：同一轮重复出现 `turn/start`（重试轮）不改写首次起点。
      const start = previous?.startedAt ?? timeOf(event) ?? undefined
      if (previous !== undefined && previous.startedAt === start) {
        return state.currentTurn === turn ? state : { ...state, currentTurn: turn }
      }
      const nextOwn: TurnCostStateOwnTurn = {
        ...previous ?? {
          costHit: 0, costMiss: 0, costOut: 0, tokHit: 0, tokMiss: 0, tokOut: 0,
        },
        ...start === undefined ? {} : { startedAt: start },
      }
      return { ...state, currentTurn: turn, ownTurns: { ...state.ownTurns, [key]: nextOwn } }
    }
    case EVENT_SUBAGENT_CATALOG: {
      // 直接子会话的**父会话自有**发现事实（`subagent/catalog`）：只有 childId /
      // 创建时刻 / 形态 / 标签，**不含用量**（用量在子会话自己的日志里）。继承前缀
      // 里的目录事实属于祖辈的子会话，必须跳过 —— 否则 fork 出来的子会话会把祖辈
      // 的孩子认成自己的孩子，客户端聚合时重复计费。
      if (seqOf(event) < state.inherited) return state
      const childId = textOf(data.childId)
      if (childId === '' || childId === undefined) return state
      const mode = data.mode === 'one-shot' ? 'one-shot' as const : 'continuable' as const
      const at = timeOf(event) ?? optionalCountOf(data.childCreatedAt) ?? 0
      const label = textOf(data.label)
      const spawn: TurnCostStateSpawn = {
        turn: state.currentTurn ?? 0,
        at,
        mode,
        ...label === '' ? {} : { label },
      }
      const previous = state.spawns[childId]
      if (previous !== undefined && previous.turn === spawn.turn && previous.at === spawn.at
        && previous.mode === spawn.mode && previous.label === spawn.label) {
        return state
      }
      return { ...state, spawns: { ...state.spawns, [childId]: spawn } }
    }
    case 'assistant/message':
    case 'assistant/attempt':
      return accrue(state, event, options)
    default:
      return state
  }
}

// ------------------------------------------------------------------ wire 视图

function project(state: TurnCostState): TurnCostProjection {
  const turns: Record<string, TurnCostEntry> = {}
  let estimated = false
  for (const key of Object.keys(state.turns)) {
    const value = state.turns[key]
    if (value === undefined) continue
    turns[key] = {
      cost: {
        hit: value.costHit,
        miss: value.costMiss,
        out: value.costOut,
        total: value.costHit + value.costMiss + value.costOut,
      },
      tok: {
        hit: value.tokHit,
        miss: value.tokMiss,
        out: value.tokOut,
        total: value.tokHit + value.tokMiss + value.tokOut,
      },
      peak: value.peak === 1,
      model: value.model,
      ...value.asOf === undefined ? {} : { asOf: value.asOf },
      ...value.est === 1 ? { est: true } : {},
    }
    if (value.est === 1) estimated = true
  }
  const ownTurns: Record<string, TurnCostOwnTurn> = {}
  for (const key of Object.keys(state.ownTurns)) {
    const value = state.ownTurns[key]
    if (value === undefined) continue
    ownTurns[key] = {
      cost: {
        hit: value.costHit,
        miss: value.costMiss,
        out: value.costOut,
        total: value.costHit + value.costMiss + value.costOut,
      },
      tok: {
        hit: value.tokHit,
        miss: value.tokMiss,
        out: value.tokOut,
        total: value.tokHit + value.tokMiss + value.tokOut,
      },
      ...value.startedAt === undefined ? {} : { startedAt: value.startedAt },
    }
  }
  const spawns: Record<string, TurnCostSpawn> = {}
  for (const key of Object.keys(state.spawns)) {
    const value = state.spawns[key]
    if (value === undefined) continue
    spawns[key] = {
      turn: value.turn,
      at: value.at,
      mode: value.mode,
      ...value.label === undefined ? {} : { label: value.label },
    }
  }
  return {
    totals: {
      cost: {
        hit: state.totals.costHit,
        miss: state.totals.costMiss,
        out: state.totals.costOut,
        total: state.totals.costHit + state.totals.costMiss + state.totals.costOut,
      },
      tok: {
        hit: state.totals.tokHit,
        miss: state.totals.tokMiss,
        out: state.totals.tokOut,
        total: state.totals.tokHit + state.totals.tokMiss + state.totals.tokOut,
      },
    },
    turns,
    priceAsOf: state.asOf,
    placement: state.placement,
    ...estimated ? { est: true } : {},
    ownTurns,
    spawns,
    ownComplete: state.ownComplete === 1,
  }
}

/** 空视图：view 万一失手时的安全牌（宁可少显示，不可抛错）。 */
const EMPTY_PROJECTION: TurnCostProjection = {
  totals: {
    cost: { hit: 0, miss: 0, out: 0, total: 0 },
    tok: { hit: 0, miss: 0, out: 0, total: 0 },
  },
  turns: {},
  priceAsOf: PRICE_AS_OF,
  placement: 'before-usage',
  ownTurns: {},
  spawns: {},
  ownComplete: true,
}

// ------------------------------------------------------------------- 全函数 schema
//
// 说明（重要设计取舍）：投影注册表把 schema 抹成 `{ parse(value): unknown }`
// 后只用 `.parse()`（session-projection/src/index.ts:142/462/521/689/707），
// 且 drive 路径对 `viewSchema.parse` **没有** try/catch。因此这里不用会抛错的
// zod 校验器，而是提供"强制清洗、永不抛错"的全函数实现 —— 既拿到了零运行时依
// 赖（本插件 host 半不含任何 import），又消除了"schema 抛错拖垮宿主"的风险。

const stateSchema = {
  parse(value: unknown): TurnCostState {
    const raw = recordOf(value)
    const totalsRaw = recordOf(raw.totals)
    const turnsRaw = recordOf(raw.turns)
    const turns: Record<string, TurnCostStateTurn> = {}
    for (const key of Object.keys(turnsRaw)) {
      const turnRaw = recordOf(turnsRaw[key])
      turns[key] = {
        costHit: countOf(turnRaw.costHit),
        costMiss: countOf(turnRaw.costMiss),
        costOut: countOf(turnRaw.costOut),
        tokHit: countOf(turnRaw.tokHit),
        tokMiss: countOf(turnRaw.tokMiss),
        tokOut: countOf(turnRaw.tokOut),
        peak: turnRaw.peak === 1 ? 1 : 0,
        model: textOf(turnRaw.model),
        ...textOf(turnRaw.asOf) === '' ? {} : { asOf: textOf(turnRaw.asOf) },
        ...turnRaw.est === 1 ? { est: 1 as const } : {},
      }
    }
    const lastRaw = raw.last === null || raw.last === undefined ? null : recordOf(raw.last)
    const headerRaw = raw.header === null || raw.header === undefined ? null : recordOf(raw.header)
    const ownTurnsRaw = recordOf(raw.ownTurns)
    const ownTurns: Record<string, TurnCostStateOwnTurn> = {}
    for (const key of Object.keys(ownTurnsRaw)) {
      const turnRaw = recordOf(ownTurnsRaw[key])
      const startedAt = optionalCountOf(turnRaw.startedAt)
      ownTurns[key] = {
        costHit: countOf(turnRaw.costHit),
        costMiss: countOf(turnRaw.costMiss),
        costOut: countOf(turnRaw.costOut),
        tokHit: countOf(turnRaw.tokHit),
        tokMiss: countOf(turnRaw.tokMiss),
        tokOut: countOf(turnRaw.tokOut),
        ...startedAt === null ? {} : { startedAt },
      }
    }
    const ownLastRaw = raw.ownLast === null || raw.ownLast === undefined ? null : recordOf(raw.ownLast)
    const spawnsRaw = recordOf(raw.spawns)
    const spawns: Record<string, TurnCostStateSpawn> = {}
    for (const key of Object.keys(spawnsRaw)) {
      const spawnRaw = recordOf(spawnsRaw[key])
      const label = textOf(spawnRaw.label)
      spawns[key] = {
        turn: countOf(spawnRaw.turn),
        at: countOf(spawnRaw.at),
        mode: spawnRaw.mode === 'one-shot' ? 'one-shot' : 'continuable',
        ...label === '' ? {} : { label },
      }
    }
    const currentTurn = optionalCountOf(raw.currentTurn)
    return {
      totals: {
        costHit: countOf(totalsRaw.costHit),
        costMiss: countOf(totalsRaw.costMiss),
        costOut: countOf(totalsRaw.costOut),
        tokHit: countOf(totalsRaw.tokHit),
        tokMiss: countOf(totalsRaw.tokMiss),
        tokOut: countOf(totalsRaw.tokOut),
      },
      turns,
      header: headerRaw === null
        ? null
        : { provider: textOf(headerRaw.provider), model: textOf(headerRaw.model) },
      last: lastRaw === null
        ? null
        : {
          turn: countOf(lastRaw.turn),
          step: countOf(lastRaw.step),
          costHit: countOf(lastRaw.costHit),
          costMiss: countOf(lastRaw.costMiss),
          costOut: countOf(lastRaw.costOut),
          tokHit: countOf(lastRaw.tokHit),
          tokMiss: countOf(lastRaw.tokMiss),
          tokOut: countOf(lastRaw.tokOut),
        },
      asOf: textOf(raw.asOf) === '' ? PRICE_AS_OF : textOf(raw.asOf),
      placement: placementOf(raw.placement),
      inherited: countOf(raw.inherited),
      // 关键：这一步只出现在"从持久缓存行恢复"的两条路径上（viewCheckpoint / restore）。
      // 旧行没有这个字段 ⇒ 0（自身口径未覆盖整段日志），且此后一直保持 0（前缀已经补不回来）。
      ownComplete: raw.ownComplete === 1 ? 1 : 0,
      currentTurn,
      ownTurns,
      ownLast: ownLastRaw === null
        ? null
        : {
          turn: countOf(ownLastRaw.turn),
          step: countOf(ownLastRaw.step),
          costHit: countOf(ownLastRaw.costHit),
          costMiss: countOf(ownLastRaw.costMiss),
          costOut: countOf(ownLastRaw.costOut),
          tokHit: countOf(ownLastRaw.tokHit),
          tokMiss: countOf(ownLastRaw.tokMiss),
          tokOut: countOf(ownLastRaw.tokOut),
        },
      spawns,
    }
  },
}

const viewSchema = {
  parse(value: unknown): TurnCostProjection {
    const raw = recordOf(value)
    const totalsRaw = recordOf(raw.totals)
    const totalsCost = recordOf(totalsRaw.cost)
    const totalsTok = recordOf(totalsRaw.tok)
    const turnsRaw = recordOf(raw.turns)
    const turns: Record<string, TurnCostEntry> = {}
    let estimated = false
    for (const key of Object.keys(turnsRaw)) {
      const entry = recordOf(turnsRaw[key])
      const cost = recordOf(entry.cost)
      const tok = recordOf(entry.tok)
      const hit = countOf(cost.hit)
      const miss = countOf(cost.miss)
      const out = countOf(cost.out)
      const tokHit = countOf(tok.hit)
      const tokMiss = countOf(tok.miss)
      const tokOut = countOf(tok.out)
      const isEst = entry.est === true
      if (isEst) estimated = true
      turns[key] = {
        cost: { hit, miss, out, total: hit + miss + out },
        tok: { hit: tokHit, miss: tokMiss, out: tokOut, total: tokHit + tokMiss + tokOut },
        peak: entry.peak === true,
        model: textOf(entry.model),
        ...textOf(entry.asOf) === '' ? {} : { asOf: textOf(entry.asOf) },
        ...isEst ? { est: true } : {},
      }
    }
    const hit = countOf(totalsCost.hit)
    const miss = countOf(totalsCost.miss)
    const out = countOf(totalsCost.out)
    const tokHit = countOf(totalsTok.hit)
    const tokMiss = countOf(totalsTok.miss)
    const tokOut = countOf(totalsTok.out)
    const ownTurnsRaw = recordOf(raw.ownTurns)
    const ownTurns: Record<string, TurnCostOwnTurn> = {}
    for (const key of Object.keys(ownTurnsRaw)) {
      const entry = recordOf(ownTurnsRaw[key])
      const cost = recordOf(entry.cost)
      const tok = recordOf(entry.tok)
      const ownHit = countOf(cost.hit)
      const ownMiss = countOf(cost.miss)
      const ownOut = countOf(cost.out)
      const ownTokHit = countOf(tok.hit)
      const ownTokMiss = countOf(tok.miss)
      const ownTokOut = countOf(tok.out)
      const startedAt = optionalCountOf(entry.startedAt)
      ownTurns[key] = {
        cost: { hit: ownHit, miss: ownMiss, out: ownOut, total: ownHit + ownMiss + ownOut },
        tok: {
          hit: ownTokHit,
          miss: ownTokMiss,
          out: ownTokOut,
          total: ownTokHit + ownTokMiss + ownTokOut,
        },
        ...startedAt === null ? {} : { startedAt },
      }
    }
    const spawnsRaw = recordOf(raw.spawns)
    const spawns: Record<string, TurnCostSpawn> = {}
    for (const key of Object.keys(spawnsRaw)) {
      const entry = recordOf(spawnsRaw[key])
      const label = textOf(entry.label)
      spawns[key] = {
        turn: countOf(entry.turn),
        at: countOf(entry.at),
        mode: entry.mode === 'one-shot' ? 'one-shot' : 'continuable',
        ...label === '' ? {} : { label },
      }
    }
    return {
      totals: {
        cost: { hit, miss, out, total: hit + miss + out },
        tok: { hit: tokHit, miss: tokMiss, out: tokOut, total: tokHit + tokMiss + tokOut },
      },
      turns,
      priceAsOf: textOf(raw.priceAsOf) === '' ? PRICE_AS_OF : textOf(raw.priceAsOf),
      placement: placementOf(raw.placement),
      ...estimated || raw.est === true ? { est: true } : {},
      ownTurns,
      spawns,
      // 只有显式 true 才算"覆盖整段日志"：缺失/非法一律按"未覆盖"处理（保守读法）。
      ownComplete: raw.ownComplete === true,
    }
  },
}

// -------------------------------------------------------------------- 单元装配

function resolveOptions(options: TurnCostOptions): ResolvedOptions {
  const providers = Array.isArray(options.pricedProviders) && options.pricedProviders.length > 0
    ? options.pricedProviders.filter(entry => typeof entry === 'string' && entry.length > 0)
    : DEFAULT_PRICED_PROVIDERS
  return {
    pricedProviders: providers.length > 0 ? providers : DEFAULT_PRICED_PROVIDERS,
    peakPricing: options.peakPricing !== false,
    placement: placementOf(options.placement),
  }
}

/**
 * 本单元的定义类型：`wire` 必填。
 *
 * 注册表对"同时出现在客户端投影表里的键"要求必须带 wire（另一个重载服务于
 * host-only 键）；显式写出这个交叉类型，能让 register 的重载解析命中前者。
 */
export type TurnCostProjectionDefinition =
  Omit<ProjectionDefinition<'turnCost', TurnCostState>, 'wire'> & {
    wire: {
      viewSchema: ZodType<TurnCostProjection>
      view(state: TurnCostState): TurnCostProjection
    }
  }

/**
 * 创建 `turnCost` 投影单元定义。
 * @param options - 插件配置（计价 provider、峰谷开关、pill 落位）。
 * @returns 可直接注册到 `ctx.sessionProjections` 的单元定义。
 */
export function createTurnCostProjection(
  options: TurnCostOptions = {},
): TurnCostProjectionDefinition {
  const resolved = resolveOptions(options)
  return {
    key: TURN_COST_KEY,
    // 价表修订号即状态版本：改价表 ⇒ 旧持久缓存行作废并重算。
    // （加字段这类结构演进**不**动它，改走状态里的 `ownComplete` 覆盖标记，见文件头。）
    stateVersion: PROJECTION_STATE_VERSION,
    // 见上文"全函数 schema"：注册表只用到 parse，且必须永不抛错。
    stateSchema: stateSchema as unknown as ZodType<TurnCostState>,
    init: (_header, inheritedEventCount) => ({
      totals: zeroAccumulator(),
      turns: {},
      header: null,
      last: null,
      asOf: PRICE_AS_OF,
      placement: resolved.placement,
      inherited: typeof inheritedEventCount === 'number' && Number.isSafeInteger(inheritedEventCount)
        && inheritedEventCount > 0
        ? inheritedEventCount
        : 0,
      currentTurn: null,
      ownTurns: {},
      // 从 seq 0 折起 ⇒ 自身口径覆盖整段日志。
      ownComplete: 1,
      ownLast: null,
      spawns: {},
    }),
    apply: (state, event) => {
      try {
        return fold(state, event, resolved)
      } catch {
        return state
      }
    },
    wire: {
      viewSchema: viewSchema as unknown as ZodType<TurnCostProjection>,
      view: (state) => {
        try {
          return project(state)
        } catch {
          return EMPTY_PROJECTION
        }
      },
    },
  }
}
