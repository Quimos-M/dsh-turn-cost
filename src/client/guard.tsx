/**
 * 渲染期错误隔离：把本插件的每个槽位组件包在一个错误边界里。
 *
 * 这是"插件有 bug 也不能拖垮 DSH"的最后一道闸：React 子树里未捕获的渲染异常会
 * 卸载整棵树，而错误边界能把爆炸范围限制在本插件自己的 pill 上（失败即不渲染，
 * 页面其余部分照常工作）。同时 `componentDidCatch` 只在本插件出问题时被调用。
 *
 * @module dsh-turn-cost/client/guard
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface CostBoundaryProps {
  /** 本插件的槽位组件。 */
  children: ReactNode
}

interface CostBoundaryState {
  failed: boolean
}

/** 只包住本插件 UI 的错误边界：出错 → 渲染 null，绝不冒泡给宿主。 */
export class CostBoundary extends Component<CostBoundaryProps, CostBoundaryState> {
  override state: CostBoundaryState = { failed: false }

  static getDerivedStateFromError(): CostBoundaryState {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    try {
      console.warn('[dsh-turn-cost] 花费 pill 渲染失败，已停用该 pill：', error, info.componentStack)
    } catch {
      // 连日志都不可用时不做事：本插件不得成为宿主的故障点。
    }
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}
