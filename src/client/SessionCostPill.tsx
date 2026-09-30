/**
 * 会话累计花费 pill：挂在 `conversation.composer.dock`（list 槽位、全新 id、
 * order 1），因此它**追加**在原生统计 pill 之后，不覆盖任何东西。
 *
 * 关键点：dock 是一个**纵向堆叠的 list 槽位**，直接渲染会让本 pill 掉到原生
 * 「耗时 · 用量」那一行的**下面一行**。所以这里用 React **portal** 把 pill 送进
 * 原生统计行（`[data-composer-stats]`），于是三者在同一行里居中排布：
 *
 *     耗时 · 用量 · 花费
 *
 * 用 portal 而不是手工 `appendChild`：portal 让 React 继续管理这个节点的挂载与
 * 卸载（跨父节点搬迁时手搬节点会让 React 的 removeChild 抛 NotFoundError）。
 * 探测不到原生统计行时退回原位渲染（多占一行，但功能完整）。
 *
 * @module dsh-turn-cost/client/SessionCostPill
 */

import { useLayoutEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// type-only：拉入 SlotMap / 标准座位（useProjection、useSessions、useChat）的类型合并。
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { TurnCostProjection } from '../types.ts'
import { CostDialog } from './CostDialog.tsx'
import { useAnchoredDialog } from './anchored-dialog.ts'
import { formatCost, formatProviders } from './cost-format.ts'
import { agentPages } from './dialog-pages.ts'
import { IconCoinOutline16 } from './icons.tsx'
import { footnote, unpricedNotes } from './rows.ts'
import { NO_SUBAGENTS, modelsOfView, rollupSubagentCost, type SubagentCostRollup } from './subagent-cost.ts'
import css from './pill.module.css'

/** 会话 pill 的完整 props（运行时座位 + 本插件文案座位）。 */
export type SessionCostPillProps =
  PropsRuntime<'conversation.composer.dock'> & PropsLocale<'turn-cost'>

/**
 * `useSessions` 缺席时的替身（老宿主 / 纯本体环境）。
 *
 * 为什么用"换一个函数"而不是条件调用 hook：hook 的调用与否必须在每次渲染里一致，
 * 条件调用本身就是违规；而这里替身与原 hook 的调用位置完全相同，只是永远返回
 * `undefined` —— 于是"读不到别的会话"只表现为子代理不显示，绝不是报错。
 */
const NO_LIST = (() => undefined) as unknown as SessionCostPillProps['useSessions']

/** 未测量完成时的隐形探针：只为拿到 DOM 位置，不显示、不占位。 */
const PROBE_STYLE: CSSProperties = { display: 'none' }

/** 向上寻找的层数上限（原生统计行就在本条目容器附近，越界即视为结构不可用）。 */
const MAX_ANCESTOR_DEPTH = 8

/**
 * 定位本会话的原生统计行（`[data-composer-stats]`）。
 *
 * 从本节点向上逐层找**最近的**、包含该行的祖先：最近匹配保证只会命中本会话自己
 * 的输入区（别的会话的输入区是兄弟节点，不是祖先）。
 * @param node - 本插件的节点。
 * @returns 原生统计行元素；找不到返回 null。
 */
function findStatsRow(node: Element): Element | null {
  let ancestor: Element | null = node.parentElement
  for (let depth = 0; ancestor !== null && depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    const row = ancestor.querySelector('[data-composer-stats]')
    if (row !== null) return row
    ancestor = ancestor.parentElement
  }
  return null
}

/** 取最近一轮的峰谷上下文（用于脚注）。 */
function latestTurn(value: TurnCostProjection): { peak: boolean; asOf: string; est: boolean } | null {
  let best: number | null = null
  for (const key of Object.keys(value.turns)) {
    const turn = Number(key)
    if (!Number.isFinite(turn)) continue
    if (best === null || turn > best) best = turn
  }
  if (best === null) return null
  const entry = value.turns[String(best)]
  if (entry === undefined) return null
  return { peak: entry.peak, asOf: entry.asOf ?? value.priceAsOf, est: entry.est === true }
}

/**
 * 会话累计花费 pill 与明细弹窗。
 *
 * 金额 = **本会话自身**（纯折叠的自有日志）+ **全部后代子会话的自有花费**。后者
 * 只能由客户端聚合：父会话日志里没有子会话的用量（详见 `./subagent-cost.ts` 的
 * 模块注释与 DESIGN.md §11）。读不到会话列表时子代理部分自动缺席，弹窗回到原样。
 *
 * @param props - 见 {@link SessionCostPillProps}。
 * @returns pill 元素；没有花费数据时不渲染任何东西。
 */
export function SessionCostPill({ useProjection, useSessions, sessionId, t }: SessionCostPillProps): ReactNode {
  const value = useProjection('turnCost')
  const seat = useAnchoredDialog()
  // undefined = 还没测到原生统计行；null = 测过但没有（退回原位渲染）。
  const [host, setHost] = useState<Element | null | undefined>(undefined)
  // 官方全局会话列表（每行都带 host 算好的投影值）。缺席时退回"没有子代理"。
  const readList = typeof useSessions === 'function' ? useSessions : NO_LIST
  const sessions = readList(state => state.byId)
  // `Object.values` 的结果按列表快照记忆：聚合的依赖项只在列表真的换了一版时才变。
  const rows = useMemo(
    () => sessions === undefined ? undefined : Object.values(sessions),
    [sessions],
  )
  const rollup: SubagentCostRollup = useMemo(
    () => rows === undefined || sessionId === undefined
      ? NO_SUBAGENTS
      : rollupSubagentCost(sessionId, rows, value),
    [rows, sessionId, value],
  )

  // 每次提交后确认落位：宿主被换掉（切会话/重挂载）→ 重新测量。
  useLayoutEffect(() => {
    if (host !== undefined) {
      if (host !== null && !host.isConnected) setHost(undefined)
      return
    }
    const node = seat.rootRef.current
    if (node === null) return
    setHost(findStatsRow(node))
  })

  const own = value === undefined ? 0 : value.totals.cost.total
  const grand = own + rollup.cost
  const unpriced = value?.unpriced
  const unpricedIds = unpriced === undefined ? '' : formatProviders(unpriced.providers)
  const hasAmount = grand > 0
  // 无投影（host 半未装配）时不渲染。没有花费**且**没有被跳过的请求时也不渲染
  // （原生界面保持原样）；但只要有未计价的请求就一定要显示 —— 那正是过去静默失效
  // 的情形：钱花了，pill 却干脆不出现。
  if (value === undefined || (!hasAmount && unpricedIds === '')) return null

  const latest = latestTurn(value)
  const marker = rollup.count === 0 ? '' : ` · ${t('cost.withSubagents')} ${String(rollup.count)}`
  // 金额为 0 时不说 "0 CNY"，改说"未计价（provider）"：避免用 0 假装精确。
  const amount = hasAmount
    ? `${formatCost(grand)}${marker}${unpricedIds === '' ? '' : ` · ${t('cost.unpricedMarker')} ${unpricedIds}`}`
    : `${t('cost.unpricedAmount')}（${unpricedIds}）`
  // 分页：第 1 页总计（主 Agent + 全部子代理）、第 2 页本会话自身、第 3 页起每个子代理
  // 一页；没有子代理时退化为单页（不渲染翻页控件）。
  const pages = agentPages(t, {
    own: { cost: value.totals.cost, tok: value.totals.tok, models: modelsOfView(value) },
    ownTotalLabel: 'cost.ownTotal',
    // 单页形态沿用旧外观：会话弹窗只在分页时（有子代理）才多出模型行。
    ownModelOnSinglePage: false,
    subagents: rollup,
  })
  const pill = (
    <span ref={seat.rootRef} className={css.anchor}>
      <button
        type="button"
        className={`${css.trigger} ${css.dock}`}
        aria-haspopup="dialog"
        aria-expanded={seat.open}
        aria-label={`${t('session.consumed')} ${amount}`}
        onClick={() => { seat.setOpen(!seat.open) }}
      >
        <IconCoinOutline16 />
        <span className={css.label}>{`${t('cost.spend')} ${amount}`}</span>
      </button>
      {seat.open && (
        <CostDialog
          panelRef={seat.panelRef}
          pos={seat.pos}
          icon={<IconCoinOutline16 />}
          title={t('session.title')}
          pages={pages}
          footnote={footnote(
            t,
            latest?.peak ?? null,
            latest?.asOf ?? value.priceAsOf,
            value.est === true,
            [
              ...rollup.rows.length === 0 ? [] : [t('cost.subagentNote')],
              ...unpricedNotes(t, unpriced?.providers ?? []),
            ],
          )}
          pager={{ prev: t('cost.prevPage'), next: t('cost.nextPage') }}
        />
      )}
    </span>
  )

  // 尚未测到宿主：先渲染隐形探针，避免"先在第二行闪一下再跳进统计行"。
  if (host === undefined) return <span ref={seat.rootRef} className={css.anchor} style={PROBE_STYLE} />
  // 测过但没找到：退回原位渲染（功能完整，只是另起一行）。
  if (host === null) return pill
  return createPortal(pill, host)
}
