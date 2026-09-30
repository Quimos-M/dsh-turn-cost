/**
 * 每轮花费 pill：注册在 `conversation.chat.assistant-actions`（list 槽位、全新
 * id、order 50），React 会把它挂进该轮的动作行。
 *
 * 落位为什么这么绕（两轮实测教训）：
 *   1. 槽位渲染会给条目套**包裹元素**，所以 `root.parentElement` 不是动作行 ——
 *      在包裹层里查原生 pill 永远是空，落位静默失效（表现为 pill 一直留在槽位
 *      原位＝分支之前）。修法：向上寻找"内部含原生弹窗 pill 的最近祖先"。
 *   2. 跨父节点手工搬节点会让 React 卸载时的 `removeChild` 抛 NotFoundError。
 *      修法：用 **React portal** 把 pill 送进动作行（React 自己管理挂载/卸载），
 *      再用 `insertBefore` 在**同一个容器内**重排到目标位置。
 *   3. 原生「用量 / 耗时」pill 可能比本条目晚一个提交出现。修法：加一个只观察本
 *      轮 `[data-turn-tail]` 子树的 MutationObserver，pill 一到就补一次落位。
 *
 * 任何一步失败都只是"位置退化"：pill 仍在槽位原位可见、功能完整。
 *
 * @module dsh-turn-cost/client/TurnCostAction
 */

import { useEffect, useLayoutEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// type-only：assistant-actions SlotMap + useChat / useProjection / useSessions 标准座位。
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { TurnCostEntry, TurnCostPlacement } from '../types.ts'
import { CostDialog } from './CostDialog.tsx'
import { useAnchoredDialog } from './anchored-dialog.ts'
import { formatCost, formatProviders } from './cost-format.ts'
import { agentPages } from './dialog-pages.ts'
import { IconCoinOutline16 } from './icons.tsx'
import { footnote, unpricedNotes } from './rows.ts'
import { OWN_ATTRIBUTE, findActionRow, reposition } from './row-placement.ts'
import { NO_SUBAGENTS, rollupSubagentCost, type SubagentCostRollup } from './subagent-cost.ts'
import css from './pill.module.css'

/** 每轮 pill 的完整 props。 */
export type TurnCostActionProps =
  PropsRuntime<'conversation.chat.assistant-actions'> & PropsLocale<'turn-cost'>

/** 未测量完成时的隐形探针：只为拿到 DOM 位置，不显示、不占位。 */
const PROBE_STYLE: CSSProperties = { display: 'none' }

/** `useSessions` 缺席时的替身（见 SessionCostPill 的同名说明）。 */
const NO_LIST = (() => undefined) as unknown as TurnCostActionProps['useSessions']

/** 本轮自己没有请求、只有子代理花费时的占位条目（全零、无模型）。 */
const EMPTY_ENTRY: TurnCostEntry = {
  cost: { hit: 0, miss: 0, out: 0, total: 0 },
  tok: { hit: 0, miss: 0, out: 0, total: 0 },
  peak: false,
  model: '',
}

/**
 * 每轮花费 pill 与明细弹窗。
 *
 * 金额 = 本会话这一轮自己的花费（纯折叠）+ **归属到这一轮的后代子会话花费**
 * （客户端聚合：父会话日志里没有子会话的用量）。归属规则见
 * `./subagent-cost.ts` 的模块注释。
 *
 * @param props - 见 {@link TurnCostActionProps}。
 * @returns pill 元素；这一轮（含其子代理）没有花费数据时不渲染任何东西。
 */
export function TurnCostAction({
  messageId, useChat, useProjection, useSessions, sessionId, t,
}: TurnCostActionProps): ReactNode {
  const value = useProjection('turnCost')
  const seat = useAnchoredDialog()
  // undefined = 还没测到动作行；null = 测过但没有（退回槽位原位渲染）。
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

  // 关闭该轮 assistant 消息所属的 turn：assistant-actions 只拿得到 messageId。
  const turn = useChat((snapshot) => {
    if (messageId === undefined) return null
    for (const node of snapshot.legacy.nodes) {
      if (node.kind === 'assistant' && node.messageId === messageId) return node.turn
    }
    return null
  })
  const placement: TurnCostPlacement = value?.placement ?? 'before-usage'

  // 每次提交后确认：先测动作行，再（portal 之后）在行内重排。幂等，已就位不写 DOM。
  useLayoutEffect(() => {
    const root = seat.rootRef.current
    if (root === null) return
    if (host === undefined) {
      setHost(findActionRow(root))
      return
    }
    if (host !== null && !host.isConnected) {
      setHost(undefined)
      return
    }
    try {
      reposition(root, placement, host)
    } catch {
      // 落位失败不是功能失败：留在当前可见位置即可。
    }
  })

  // 兜底：原生 pill 可能晚到，或被 React 重新插入 —— 观察本轮尾容器，随时补齐落位。
  useEffect(() => {
    const anchorNode = host ?? seat.rootRef.current?.closest('[data-turn-tail]') ?? null
    if (anchorNode === null) return
    const observer = new MutationObserver(() => {
      const root = seat.rootRef.current
      if (root === null) return
      try {
        if (host === null || host === undefined) {
          const row = findActionRow(root)
          if (row !== null) setHost(row)
          return
        }
        reposition(root, placement, host)
      } catch {
        // 同上：位置退化，不影响功能。
      }
    })
    observer.observe(anchorNode, { childList: true, subtree: true })
    return () => { observer.disconnect() }
  }, [host, placement, seat.rootRef])

  const entry = value === undefined || turn === null ? undefined : value.turns[String(turn)]
  const slice = turn === null ? undefined : rollup.byTurn[String(turn)]
  const ownCost = entry?.cost.total ?? 0
  const grand = ownCost + (slice?.cost ?? 0)
  // 本轮未计价的 provider（会话级 wire 里按轮记着）。金额为 0 但有它时必须显示：
  // 这正是过去"钱花了但 pill 不出现"的静默情形。
  const unpricedTurn = turn === null || value?.unpriced === undefined
    ? []
    : value.unpriced.byTurn[String(turn)] ?? []
  const unpricedIds = formatProviders(unpricedTurn)
  const hasAmount = grand > 0
  if (value === undefined || turn === null || (!hasAmount && unpricedIds === '')) return null

  // 落位降级（没找到原生动作行）时在标签里显式标出来：这是"肉眼可见的自证"，
  // 避免"看起来一样、其实没落位"的沉默失败。
  const placed = host !== undefined && host !== null
  const marker = slice === undefined ? '' : ` · ${t('cost.withSubagents')} ${String(slice.rows.length)}`
  // 金额为 0 时不说 "0 CNY"，改说"未计价（provider）"：避免用 0 假装精确。
  const amount = hasAmount
    ? `${formatCost(grand)}${marker}${unpricedIds === '' ? '' : ` · ${t('cost.unpricedMarker')} ${unpricedIds}`}`
    : `${t('cost.unpricedAmount')}（${unpricedIds}）`
  const label = placed
    ? `${t('cost.spend')} ${amount}`
    : `${t('cost.spend')} ${amount} · ${t('cost.placeFallback')}`
  // 分页：第 1 页总计（本轮自身 + 归属到本轮的子代理）、第 2 页本轮自身、第 3 页起
  // 该轮调用的每个子代理一页；本轮没有子代理时退化为单页（不渲染翻页控件）。
  const own = entry ?? EMPTY_ENTRY
  const pages = agentPages(t, {
    own: {
      cost: own.cost,
      tok: own.tok,
      models: entry === undefined || entry.model === '' ? [] : [entry.model],
    },
    ownTotalLabel: 'cost.ownTurnTotal',
    ownModelOnSinglePage: true,
    subagents: slice,
  })
  const pill = (
    <span
      ref={seat.rootRef}
      className={css.anchor}
      data-cost-place={host === undefined ? 'probe' : host === null ? 'inline' : 'row'}
      {...{ [OWN_ATTRIBUTE]: '' }}
    >
      <button
        type="button"
        className={`${css.trigger} ${css.row}`}
        aria-haspopup="dialog"
        aria-expanded={seat.open}
        aria-label={placed ? `${t('turn.consumed')} ${amount}` : `${t('turn.consumed')} ${amount}（${t('cost.placeFallback')}）`}
        onClick={() => { seat.setOpen(!seat.open) }}
      >
        <IconCoinOutline16 />
        <span className={css.label}>{label}</span>
      </button>
      {seat.open && (
        <CostDialog
          panelRef={seat.panelRef}
          pos={seat.pos}
          icon={<IconCoinOutline16 />}
          title={t('turn.title')}
          pages={pages}
          footnote={footnote(
            t,
            entry === undefined ? null : entry.peak,
            entry?.asOf ?? value.priceAsOf,
            entry?.est === true,
            [
              ...slice === undefined || slice.rows.length === 0 ? [] : [t('cost.subagentNote')],
              ...unpricedNotes(t, unpricedTurn),
            ],
          )}
          pager={{ prev: t('cost.prevPage'), next: t('cost.nextPage') }}
        />
      )}
    </span>
  )

  // 尚未测到动作行：先渲染隐形探针（避免"先在原位闪一下再跳走"）。
  if (host === undefined) {
    return <span ref={seat.rootRef} className={css.anchor} style={PROBE_STYLE} {...{ [OWN_ATTRIBUTE]: '' }} />
  }
  // 测过但没找到：退回槽位原位渲染（功能完整，位置退化为分支之前）。
  if (host === null) return pill
  return createPortal(pill, host)
}
