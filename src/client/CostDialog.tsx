/**
 * 花费明细弹窗：与原生 stat-dialog 同一套皮肤与排布（标题行 + 分隔线 +
 * dt/dd 两列明细 + 脚注），子代理存在时**分页**显示（总计 / 主 Agent / 每个子代理一页）。
 *
 * 本组件是**纯展示**：所有数字都已由调用方算好格式化成字符串（页由
 * `./dialog-pages.ts` 装配），因此它内部没有任何可能抛错的逻辑（渲染期异常是唯一
 * 会波及宿主 UI 的路径）；翻页只是"选中哪一页"，任何非法页码都被 `clampPage` 夹住。
 *
 * 翻页交互：`‹ 2/4 ›` 极简控件 + 左右方向键（两端夹住）+ 回车（循环）+ Esc 关闭
 * （Esc 由 `./anchored-dialog.ts` 的座位负责）。**单页时不渲染任何翻页控件**，弹窗
 * 与分页改造前完全一致 —— 没有子代理的常见情形不该多出噪音。
 *
 * @module dsh-turn-cost/client/CostDialog
 */

import { Fragment, useEffect, useState, type CSSProperties, type MutableRefObject, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MEASURE_STYLE } from './anchored-dialog.ts'
import { clampPage, cyclePage, pageIndicator, stepPage } from './dialog-pages.ts'
import css from './dialog.module.css'

/** 一行明细（dt/dd 对）。 */
export interface CostDialogRow {
  label: string
  value: string
  /** 值较长（如模型名 / provider 路由）时允许任意位置换行。 */
  wrap?: boolean
}

/** 一页明细（标题右侧的合计 + 行）。 */
export interface CostDialogPage {
  /** 该页合计（已格式化）。 */
  readonly total: string
  /** 该页明细行。 */
  readonly rows: readonly CostDialogRow[]
}

/** 翻页控件的无障碍文案（词典座位在调用方，本组件保持字符串无关）。 */
export interface CostDialogPagerLabels {
  /** 上一页按钮。 */
  readonly prev: string
  /** 下一页按钮。 */
  readonly next: string
}

/** 弹窗 props。 */
export interface CostDialogProps {
  panelRef: MutableRefObject<HTMLDivElement | null>
  /** 原生钳制算出的落位；null = 仍在测量。 */
  pos: CSSProperties | null
  /** 标题左侧图标。 */
  icon: ReactNode
  /** 标题文案。 */
  title: string
  /** 页列表（长度恒 ≥ 1；长度 1 = 不显示翻页控件）。 */
  pages: readonly CostDialogPage[]
  /** 价格口径脚注（每页都显示）。 */
  footnote: string
  /** 翻页控件文案。 */
  pager: CostDialogPagerLabels
}

/** 页数据缺失时的兜底（宁可为空，也不让渲染期抛错）。 */
const EMPTY_PAGE: CostDialogPage = { total: '', rows: [] }

/** 翻页控件容器标记：键盘处理据此让位给按钮自身的激活行为。 */
const PAGER_ATTR = 'data-turn-cost-pager'

/** 事件目标是否在翻页控件内（不在 DOM 环境 / 无法判断时一律当作"不在"）。 */
function isPagerTarget(target: EventTarget | null): boolean {
  try {
    return typeof Element !== 'undefined'
      && target instanceof Element
      && target.closest(`[${PAGER_ATTR}]`) !== null
  } catch {
    return false
  }
}

/**
 * 渲染花费明细弹窗（portal 到 body，层级与原生 stat-dialog 同级）。
 * @param props - 见 {@link CostDialogProps}。
 * @returns 面板元素。
 */
export function CostDialog({
  panelRef, pos, icon, title, pages, footnote, pager,
}: CostDialogProps): ReactNode {
  const count = pages.length > 0 ? pages.length : 1
  const paged = count > 1
  // 存"期望页码"而不是"已夹住的页码"：页数会随会话列表变化，夹取放在渲染时做，
  // 于是子代理变少时当前页自动回到最后一页，而不是渲染出空白页。
  const [wanted, setWanted] = useState(0)
  const current = clampPage(wanted, count)
  const page = pages[current] ?? pages[0] ?? EMPTY_PAGE

  useEffect(() => {
    if (!paged) return
    const onKeyDown = (event: KeyboardEvent): void => {
      try {
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
        // 焦点在翻页按钮上时让按钮自己处理（否则回车会被本处吞掉）。
        if (isPagerTarget(event.target)) return
        if (event.key === 'ArrowLeft') setWanted(stepPage(current, -1, count))
        else if (event.key === 'ArrowRight') setWanted(stepPage(current, 1, count))
        else if (event.key === 'Enter') setWanted(cyclePage(current, 1, count))
        else return
        // 阻止"触发器按钮因回车被重新激活而关闭弹窗"这类默认行为。
        event.preventDefault()
      } catch {
        // 键盘处理绝不外抛：翻页失败只表现为没翻页。
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [paged, current, count])

  return createPortal(
    <div
      ref={panelRef}
      className={css.panel}
      role="dialog"
      aria-label={paged ? `${title} ${pageIndicator(current, count)}` : title}
      style={pos ?? MEASURE_STYLE}
    >
      <div className={css.title}>
        <span className={css.titleLabel}>
          {icon}
          {title}
        </span>
        <span className={css.titleValue}>{page.total}</span>
      </div>
      <div className={css.titleRule} aria-hidden />
      <dl className={`${css.details}${paged ? ` ${css.detailsPaged}` : ''}`} data-turn-cost-details>
        {page.rows.map((row, index) => (
          // 键用"页码 + 序号 + 标签"：子代理明细里两行可能同名（两个子会话标题相同），
          // 只用标签会撞键；带上页码则翻页时不会把上一页的节点复用成新页的。
          <Fragment key={`${String(current)}:${String(index)}:${row.label}`}>
            <dt>{row.label}</dt>
            <dd className={row.wrap === true ? css.route : undefined}>{row.value}</dd>
          </Fragment>
        ))}
      </dl>
      {paged && (
        <div className={css.pager} {...{ [PAGER_ATTR]: '' }}>
          <button
            type="button"
            className={css.pageButton}
            aria-label={pager.prev}
            disabled={current === 0}
            onClick={() => { setWanted(stepPage(current, -1, count)) }}
          >
            <span aria-hidden>‹</span>
          </button>
          <span className={css.pageIndicator}>{pageIndicator(current, count)}</span>
          <button
            type="button"
            className={css.pageButton}
            aria-label={pager.next}
            disabled={current === count - 1}
            onClick={() => { setWanted(stepPage(current, 1, count)) }}
          >
            <span aria-hidden>›</span>
          </button>
        </div>
      )}
      <div className={css.footnote}>{footnote}</div>
    </div>,
    document.body,
  )
}
