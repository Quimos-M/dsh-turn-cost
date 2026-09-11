/**
 * 弹窗内容装配：把投影里的桶数据变成"标签 + 金额（tokens）"明细行与价格口径
 * 脚注。纯函数、无 React 依赖，两个 pill 共用；分页的"页"由
 * `./dialog-pages.ts` 组装，本模块只负责**行**。
 *
 * 三种行的来源：
 *   * **总计行**（`overviewRows`）：主 Agent + 全部子代理的三桶相加，再补一行
 *     "由 N 个代理构成"的构成摘要；
 *   * **单代理行**（`agentRows`）：模型 / 缓存命中率 / 三桶 / 合计 —— 主 Agent 页与
 *     每个子代理页共用同一套口径；
 *   * **子代理页行**（`subagentPageRows`）：单代理行 + 一行归属（精确 / 按创建轮
 *     归属 / 未归属到轮次），如实标注它是精确值还是兜底估算。
 *
 * 没有子代理时页面装配退回**单页**（见 `dialog-pages.ts`），行的形状与分页前完全
 * 一致 —— 常见情形不因分页改造多出任何东西。
 *
 * @module dsh-turn-cost/client/rows
 */

import type { CostBucketsMicro, CostBucketsTotal, TokenBuckets, TokenBucketsTotal } from '../types.ts'
import type { SubagentCostDetail, SubagentCostRow } from './subagent-cost.ts'
import { formatCost, formatCostWithTokens, formatHitRate } from './cost-format.ts'
import type { CostDialogRow } from './CostDialog.tsx'
import type { TurnCostKey } from './locales.ts'

/** 本插件 `t` 座位的最小结构类型。 */
export type Translate = (key: TurnCostKey) => string

/** 一个代理（主 Agent 或某个子代理）的账。 */
export interface AgentLedger {
  /** 三桶金额 + 合计（µ¥）。 */
  readonly cost: CostBucketsTotal
  /** 三桶 token + 合计。 */
  readonly tok: TokenBucketsTotal
  /** 该代理用过的模型（去重）；空数组 = 不显示模型行。 */
  readonly models: readonly string[]
}

/** 模型行的多个模型之间的分隔符（与 pill 里的 ` · ` 同款）。 */
const MODEL_SEP = ' · '

/** 三桶金额相加（不改动入参）。 */
function sumCost(
  left: CostBucketsMicro & { total: number },
  right: CostBucketsMicro & { total: number },
): CostBucketsTotal {
  return {
    hit: left.hit + right.hit,
    miss: left.miss + right.miss,
    out: left.out + right.out,
    total: left.total + right.total,
  }
}

/** 三桶 token 相加（不改动入参）。 */
function sumTok(
  left: TokenBuckets & { total: number },
  right: TokenBuckets & { total: number },
): TokenBucketsTotal {
  return {
    hit: left.hit + right.hit,
    miss: left.miss + right.miss,
    out: left.out + right.out,
    total: left.total + right.total,
  }
}

/**
 * 三桶明细行 + 合计行（原生 stat-dialog 的"缓存命中输入 / 缓存未命中输入 / 输出"
 * 口径）。
 * @param t - 文案座位。
 * @param cost - 三桶金额（µ¥）。
 * @param tok - 三桶 token。
 * @param totalLabel - 合计行的标签（合计 / 本会话自身 / 合计（含子代理））。
 * @returns 明细行。
 */
export function bucketRows(
  t: Translate,
  cost: { hit: number; miss: number; out: number; total: number },
  tok: { hit: number; miss: number; out: number; total: number },
  totalLabel: string,
): CostDialogRow[] {
  return [
    { label: t('cost.cacheHitInput'), value: formatCostWithTokens(cost.hit, tok.hit) },
    { label: t('cost.cacheMissInput'), value: formatCostWithTokens(cost.miss, tok.miss) },
    { label: t('cost.output'), value: formatCostWithTokens(cost.out, tok.out) },
    { label: totalLabel, value: formatCost(cost.total) },
  ]
}

/** 单代理行的可选行开关。 */
export interface AgentRowOptions {
  /** 是否显示模型行（默认 true）。 */
  withModel?: boolean
  /** 是否显示缓存命中率行（默认 true；子代理页不显示，见 `subagentPageRows`）。 */
  withHitRate?: boolean
}

/**
 * 单个代理的明细行（模型 → 缓存命中率 → 三桶 → 合计）。
 * @param t - 文案座位。
 * @param ledger - 该代理的账。
 * @param totalLabel - 合计行标签。
 * @param options - 见 {@link AgentRowOptions}。
 * @returns 明细行。
 */
export function agentRows(
  t: Translate,
  ledger: AgentLedger,
  totalLabel: string,
  options: AgentRowOptions = {},
): CostDialogRow[] {
  const models = ledger.models.filter(model => model !== '')
  const rate = formatHitRate(ledger.tok.hit, ledger.tok.miss)
  return [
    ...(options.withModel !== false && models.length > 0
      ? [{ label: t('cost.model'), value: models.join(MODEL_SEP), wrap: true }]
      : []),
    ...(options.withHitRate === false || rate === null
      ? []
      : [{ label: t('cost.hitRate'), value: rate }]),
    ...bucketRows(t, ledger.cost, ledger.tok, totalLabel),
  ]
}

/** 第 1 页（总计）的输入。 */
export interface OverviewInput {
  /** 主 Agent（本会话 / 本轮自身）的账。 */
  readonly own: AgentLedger
  /** 子代理合计（µ¥）与三桶。 */
  readonly sub: {
    readonly cost: number
    readonly costBuckets: CostBucketsTotal
    readonly tokBuckets: TokenBucketsTotal
  }
  /** 子代理个数（用于"由 N 个代理构成"）。 */
  readonly subagentCount: number
}

/**
 * 第 1 页（总计）的明细行：合计口径的三桶 + 构成摘要。
 * @param t - 文案座位。
 * @param input - 见 {@link OverviewInput}。
 * @returns 明细行。
 */
export function overviewRows(t: Translate, input: OverviewInput): CostDialogRow[] {
  const buckets = sumCost(input.own.cost, input.sub.costBuckets)
  const tok = sumTok(input.own.tok, input.sub.tokBuckets)
  // 合计以"主 Agent + 子代理"的金额口径为准：与两个 pill 显示的数字同源。
  const cost: CostBucketsTotal = { ...buckets, total: input.own.cost.total + input.sub.cost }
  const rate = formatHitRate(tok.hit, tok.miss)
  return [
    ...rate === null ? [] : [{ label: t('cost.hitRate'), value: rate }],
    ...bucketRows(t, cost, tok, t('cost.grandTotal')),
    {
      // "由 N 个代理构成"：N = 主 Agent 1 个 + 有花费的子代理数。
      label: `${t('cost.agentsLead')} ${String(Math.max(0, input.subagentCount) + 1)} ${t('cost.agentsTail')}`,
      value: `${t('cost.mainAgent')} ${formatCost(input.own.cost.total)}`
        + ` + ${t('cost.subagent')} ${formatCost(input.sub.cost)}`,
      wrap: true,
    },
  ]
}

/**
 * 归属文案：这个子代理的花费落到了本会话的哪一轮（沿用聚合的标注口径）。
 * @param t - 文案座位。
 * @param row - 子代理行。
 * @returns 例如 `第 12 轮、第 13 轮 · 精确` / `第 13 轮 · 按创建轮归属` / 未归属说明。
 */
export function attributionText(t: Translate, row: SubagentCostRow): string {
  if (row.turns.length === 0) return t('cost.subagentUnattributed')
  const turns = row.turns
    .map(turn => `${t('cost.turnLead')}${String(turn)}${t('cost.turnTail')}`)
    .join(t('cost.turnSep'))
  const mark = row.exact ? t('cost.attributedExact') : t('cost.subagentAnchored')
  return `${turns}${t('cost.turnMark')}${mark}`
}

/**
 * 一个子代理一页的明细行：名称（含层级缩进）→ 模型 / 三桶 / 合计 → 归属。
 *
 * 这一页不显示缓存命中率：用户要的是"哪个代理花了多少、算在哪一轮"，行数与第 1 / 2 页
 * 对齐（最长 7 行）后翻页时面板高度不抖（见 `dialog.module.css` 的 `.detailsPaged`）。
 * @param t - 文案座位。
 * @param row - 子代理行（来自会话级 rollup 或某一轮切片）。
 * @param detail - 该子代理的展开细目（三桶 / 模型）；读不到时退回行上的合计。
 * @returns 明细行。
 */
export function subagentPageRows(
  t: Translate,
  row: SubagentCostRow,
  detail: SubagentCostDetail | undefined,
): CostDialogRow[] {
  const indent = '· '.repeat(Math.max(0, row.depth - 1))
  const ledger: AgentLedger = {
    cost: detail?.cost ?? { hit: 0, miss: 0, out: 0, total: row.cost },
    tok: detail?.tok ?? { hit: 0, miss: 0, out: 0, total: row.tokens },
    models: detail?.models ?? [],
  }
  return [
    { label: t('cost.subagent'), value: `${indent}${row.label}`, wrap: true },
    ...agentRows(t, ledger, t('cost.total'), { withModel: true, withHitRate: false }),
    { label: t('cost.agentTurn'), value: attributionText(t, row), wrap: true },
  ]
}

/**
 * 价格口径脚注：说明这些数字是按哪一版官方价、按峰还是按谷算出来的。
 * @param t - 文案座位。
 * @param peak - 末次计价请求是否高峰；null 表示无从判断（不写峰谷）。
 * @param priceAsOf - 口径标签（价表版本）。
 * @param estimated - 是否含未收录模型的估算。
 * @param notes - 追加说明（例如"含子代理"的口径说明）。
 * @returns 脚注文本。
 */
export function footnote(
  t: Translate,
  peak: boolean | null,
  priceAsOf: string,
  estimated: boolean,
  notes: readonly string[] = [],
): string {
  const parts = [t('cost.priceNote')]
  if (peak !== null) parts.push(peak ? t('cost.peak') : t('cost.valley'))
  parts.push(priceAsOf)
  if (estimated) parts.push(t('cost.estimated'))
  parts.push(...notes)
  return parts.join(' · ')
}
