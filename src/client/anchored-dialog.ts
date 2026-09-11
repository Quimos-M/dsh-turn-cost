/**
 * 一个"触发器锚定"的弹窗座位：开关状态、视口内钳制的落位、点外部/Escape 关闭。
 *
 * 与原生 `stat-dialog`（`packages/client/ui-chat/src/client/chat/stat-dialog.ts`）
 * 行为一致 —— 关键是复用同一个平台模块
 * `@deepseek-ai/dsh-client-ui-primitives` 导出的 `useAnchoredPosition` /
 * `useDismissOnOutsidePointer`，因此落位算法与原生逐像素相同，且不依赖任何
 * DSH 内部模块。
 *
 * @module dsh-turn-cost/client/anchored-dialog
 */

import { useEffect, useRef, useState, type CSSProperties, type MutableRefObject } from 'react'
import { useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'

/** 与原生一致的视口留白（Menu portal margin）。 */
const PANEL_MARGIN = 12

/** 与原生一致的触发器上沿到面板下沿的距离。 */
const PANEL_GAP = 8

/** 未定位的 portal 面板：隐藏但仍参与布局，供钳制算法测量真实尺寸。 */
export const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/** 一个弹窗座位。 */
export interface AnchoredDialogSeat {
  open: boolean
  setOpen: (open: boolean) => void
  rootRef: MutableRefObject<HTMLSpanElement | null>
  panelRef: MutableRefObject<HTMLDivElement | null>
  pos: CSSProperties | null
}

/**
 * 创建触发器锚定的弹窗座位。
 * @returns 座位；把 `pos ?? MEASURE_STYLE` 铺到 portal 面板的 style 上。
 */
export function useAnchoredDialog(): AnchoredDialogSeat {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const pos = useAnchoredPosition({
    open,
    anchorRef: rootRef,
    panelRef,
    side: 'top',
    gap: PANEL_GAP,
    margin: PANEL_MARGIN,
  })

  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  return { open, setOpen, rootRef, panelRef, pos }
}
