/**
 * 轮次动作行内的落位算法（纯 DOM 操作，抽出来是为了可单测）。
 *
 * 结构事实：原生「用量 / 耗时」pill 渲染成 `<span class="root"><button/></span>`，
 * 行（`MessageIconActions` 的 `.actions`）的直接子节点是**外层 span**。
 * 因此 `insertBefore` 的锚点必须是"行内直接子节点"，拿 pill 内部的 `button` 当锚点
 * 会抛 `NotFoundError`（待插入位置不是该父节点的子节点）—— 这正是第一轮实测里
 * "pill 留在分支之前"的根因。
 *
 * 本模块只做三件事：找原生 pill、把锚点收敛成行内直接子节点、只重排**自己的**节点。
 * 绝不修改 / 包裹 / 隐藏任何原生节点。
 *
 * @module dsh-turn-cost/client/row-placement
 */

import type { TurnCostPlacement } from '../types.ts'

/** 本插件根节点的标记属性：用于把自己从"原生 pill"里排除掉。 */
export const OWN_ATTRIBUTE = 'data-dsh-turn-cost'

/**
 * 原生 provider 弹窗 pill 的识别方式（两条独立线索，任一命中即算）：
 *   * `aria-haspopup="dialog"` —— 用量 / 耗时 pill 的显式声明；
 *   * `aria-expanded` —— 同一批 pill 折叠/展开状态，作为 tolerant 兜底
 *     （万一某个版本的 pill 少写了 haspopup，落位仍然成立）。
 * 插件自己的按钮两条都可能命中，由 `[data-dsh-turn-cost]` 过滤掉。
 */
const DIALOG_BUTTON_SELECTORS = ['button[aria-haspopup="dialog"]', 'button[aria-expanded]']

/**
 * 动作行内的原生 provider 弹窗 pill（用量、耗时），按 DOM 顺序。
 * @param row - 动作行元素。
 * @returns 原生 pill 的 button 元素数组（可能为空）。
 */
export function nativePills(row: Element): Element[] {
  // 逗号选择器本身已按文档序返回且去重。
  return Array.from(row.querySelectorAll(DIALOG_BUTTON_SELECTORS.join(',')))
    .filter(button => button.closest(`[${OWN_ATTRIBUTE}]`) === null)
}

/**
 * 把一个后代元素收敛成动作行的**直接子节点**。
 * @param element - 行内某个后代元素。
 * @param row - 动作行元素。
 * @returns 行内的直接子节点；element 不在行内时返回 null。
 */
export function rowCellOf(element: Element, row: Element): Element | null {
  let node: Element | null = element
  while (node !== null && node.parentElement !== row) node = node.parentElement
  return node
}

/**
 * 定位本插件所在的**轮次动作行**。
 *
 * 为什么不能直接用 `root.parentElement`：槽位渲染会给条目套包裹元素，
 * 于是父节点只是一个只含自己的包裹层，在其中查不到原生 pill —— 落位就会静默失效
 * （第一、二轮实测的症状：pill 一直留在槽位原位＝分支之前）。这里改为**向上寻找
 * 最近的、内部含原生弹窗 pill 的祖先**，即真正的动作行。
 *
 * 上界是 `[data-turn-tail]`（原生轮次尾容器）：到边界还没找到就返回 null，绝不
 * 越界去认领别的轮次的动作行。
 * @param node - 本插件节点（探针或已落位的 pill）。
 * @param maxDepth - 向上寻找的最大层数。
 * @returns 动作行元素；找不到返回 null。
 */
export function findActionRow(node: Element, maxDepth = 6): Element | null {
  let container: Element | null = node.parentElement
  for (let depth = 0; container !== null && depth < maxDepth; depth += 1) {
    if (nativePills(container).length > 0) return container
    if (container.hasAttribute('data-turn-tail')) return null
    container = container.parentElement
  }
  return null
}

/**
 * 把本插件根节点移动到目标位置（已就位则不动，避免无谓的 DOM 变更）。
 *
 * 只在**同一父节点内**重新排序，因此 React 的增删仍然安全。
 * @param root - 本插件根节点。
 * @param placement - 目标落位方式。
 * @param row - 目标动作行；缺省用 root 的父节点。
 */
export function reposition(root: HTMLElement, placement: TurnCostPlacement, row?: Element | null): void {
  if (placement === 'inline') return
  const container = row ?? root.parentElement
  if (container === null || container === undefined) return
  const pills = nativePills(container)
  if (pills.length === 0) return
  // 原生「用量 / 耗时」是本行最后两个带弹窗的按钮（usageAction 位于行尾附近）。
  // 以"组尾"为锚点而不是按下标取第 0/1 个：将来若有别的插件在同一行插入带弹窗
  // 的按钮，我们仍然贴着原生的这一对。
  const timeButton = pills[pills.length - 1]
  const usageButton = pills[pills.length - 2] ?? timeButton
  if (timeButton === undefined || usageButton === undefined) return
  const timeCell = rowCellOf(timeButton, container)
  const usageCell = rowCellOf(usageButton, container)
  if (timeCell === null || usageCell === null) return

  if (placement === 'after-time') {
    if (root.previousElementSibling === timeCell) return
    timeCell.after(root)
    return
  }

  const anchor = placement === 'between' && pills.length >= 2 ? timeCell : usageCell
  if (root.nextElementSibling === anchor) return
  container.insertBefore(root, anchor)
}
