/**
 * 弹窗**分页**：页数 / 当前页钳制 / 翻页步进（纯函数，可单测）+ 页列表装配。
 *
 * 页序（用户口径：第 1 页看总计，往后看各代理）：
 *
 * ```
 * 第 1 页  总计      合计口径的三桶 + 一行"由 N 个代理构成"（主 Agent ¥x + 子代理 ¥y）
 * 第 2 页  主 Agent  本会话 / 本轮自身：模型、缓存命中率、三桶、合计
 * 第 3 页+ 每个子代理 一页：模型、三桶、合计、归属轮次（精确 / 按创建轮归属 / 未归属）
 * ```
 *
 * **没有子代理时退化为单页**：此时返回的页数恒为 1（`pageCount(0) === 1`），弹窗不渲染
 * 任何翻页控件，行也与分页前逐条一致 —— 常见情形不因为这次改造多出任何东西。
 *
 * 会话累计 pill 与每轮 pill 共用本模块：会话传全量 `rollup`，每轮传该轮切片
 * （`rollup.byTurn[turn]`），于是每轮 pill 的子代理页只包含**该轮调用的**子代理。
 *
 * @module dsh-turn-cost/client/dialog-pages
 */

import type { CostBucketsTotal, TokenBucketsTotal } from '../types.ts'
import type { CostDialogPage } from './CostDialog.tsx'
import type { SubagentCostDetail, SubagentCostRow } from './subagent-cost.ts'
import { formatCost } from './cost-format.ts'
import { agentRows, overviewRows, subagentPageRows, type AgentLedger, type Translate } from './rows.ts'
import type { TurnCostKey } from './locales.ts'

/** 无子代理时的页数（单页：总计即自身）。 */
const SINGLE_PAGE = 1

/** 主 Agent 页之前固定有的两页（总计 + 主 Agent）。 */
const LEADING_PAGES = 2

/** 把外部输入清洗成"页数意义上的个数"（非负整数；脏输入 → 0）。 */
function countOf(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

/** 把外部输入清洗成"合法页数"（至少 1 页）。 */
function totalPages(count: number): number {
  const total = countOf(count)
  return total > SINGLE_PAGE ? total : SINGLE_PAGE
}

/**
 * 子代理个数 → 页数。
 * @param subagentCount - 有花费的子代理个数。
 * @returns `0` → 1 页（单页退化）；`n > 0` → `n + 2` 页（总计 + 主 Agent + 每个子代理一页）。
 */
export function pageCount(subagentCount: number): number {
  const count = countOf(subagentCount)
  return count === 0 ? SINGLE_PAGE : count + LEADING_PAGES
}

/**
 * 把页码钳进合法范围（子代理数变化会让页数变少，当前页必须跟着夹住）。
 * @param index - 期望的页码（0 起）。
 * @param count - 页数。
 * @returns `[0, 页数 - 1]` 内的整数；`count ≤ 1` 恒为 0。
 */
export function clampPage(index: number, count: number): number {
  const total = totalPages(count)
  const wanted = typeof index === 'number' && Number.isFinite(index) ? Math.trunc(index) : 0
  return Math.min(Math.max(wanted, 0), total - 1)
}

/**
 * 步进翻页（两端夹住，不环绕）—— 翻页按钮与左右方向键用它。
 * @param index - 当前页码（0 起）。
 * @param delta - 步长（±1）。
 * @param count - 页数。
 * @returns 新页码。
 */
export function stepPage(index: number, delta: number, count: number): number {
  const move = typeof delta === 'number' && Number.isFinite(delta) ? Math.trunc(delta) : 0
  return clampPage(clampPage(index, count) + move, count)
}

/**
 * 循环翻页（首尾相接）—— 回车键用它，连按即可把每页都过一遍。
 * @param index - 当前页码（0 起）。
 * @param delta - 步长（±1）。
 * @param count - 页数。
 * @returns 新页码。
 */
export function cyclePage(index: number, delta: number, count: number): number {
  const total = totalPages(count)
  const from = clampPage(index, total)
  const move = typeof delta === 'number' && Number.isFinite(delta) ? Math.trunc(delta) : 0
  if (move === 0) return from
  return ((from + move) % total + total) % total
}

/**
 * 页码指示串（`2/4`；语言无关，因此不进词典）。
 * @param index - 当前页码（0 起）。
 * @param count - 页数。
 * @returns 例如 `2/4`。
 */
export function pageIndicator(index: number, count: number): string {
  return `${String(clampPage(index, count) + 1)}/${String(totalPages(count))}`
}

/** 分页视图要用的子代理来源（会话级 `rollup` 或某一轮切片）。 */
export interface SubagentPagesSource {
  /** 子代理合计（µ¥）。 */
  readonly cost: number
  /** 子代理合计三桶金额。 */
  readonly costBuckets: CostBucketsTotal
  /** 子代理合计三桶 token。 */
  readonly tokBuckets: TokenBucketsTotal
  /** 逐个子代理的行（每个一行 = 一页）。 */
  readonly rows: readonly SubagentCostRow[]
  /** 逐子代理细目（三桶 / 模型），键与 `rows[].id` 一致。 */
  readonly details: Readonly<Record<string, SubagentCostDetail>>
}

/** 页列表装配输入。 */
export interface AgentPagesInput {
  /** 主 Agent（本会话 / 本轮自身）的账。 */
  readonly own: AgentLedger
  /** 主 Agent 页合计行的文案键（会话 = 本会话自身；本轮 = 本轮自身）。 */
  readonly ownTotalLabel: TurnCostKey
  /** 单页（无子代理）时是否在主 Agent 页显示模型行（每轮 pill 一直显示）。 */
  readonly ownModelOnSinglePage: boolean
  /** 子代理；缺省或没有行 = 单页形态（与分页前外观一致）。 */
  readonly subagents?: SubagentPagesSource
}

/**
 * 装配弹窗的页列表。
 * @param t - 文案座位。
 * @param input - 见 {@link AgentPagesInput}。
 * @returns 页列表（长度恒 ≥ 1；长度 1 时调用方不渲染翻页控件）。
 */
export function agentPages(t: Translate, input: AgentPagesInput): CostDialogPage[] {
  const sub = input.subagents
  const ownTotal = input.own.cost.total
  // 单页退化：外观与分页前逐条一致（会话弹窗这一页不含模型行，见 §4.2 的口径说明）。
  if (sub === undefined || sub.rows.length === 0) {
    return [{
      total: formatCost(ownTotal),
      rows: agentRows(t, input.own, t('cost.total'), { withModel: input.ownModelOnSinglePage }),
    }]
  }
  const pages: CostDialogPage[] = [
    {
      total: formatCost(ownTotal + sub.cost),
      rows: overviewRows(t, { own: input.own, sub, subagentCount: sub.rows.length }),
    },
    {
      total: formatCost(ownTotal),
      rows: agentRows(t, input.own, t(input.ownTotalLabel)),
    },
  ]
  for (const row of sub.rows) {
    pages.push({ total: formatCost(row.cost), rows: subagentPageRows(t, row, sub.details[row.id]) })
  }
  return pages
}
