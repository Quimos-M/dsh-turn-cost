/**
 * dsh-turn-cost —— client 半（浏览器）。
 *
 * 只做两件事：注册文案字典，并把两个 pill 追加到两个 **list 槽位** 上：
 *   * `conversation.composer.dock`（会话花费，order 1 —— 紧随原生统计 pill）；
 *   * `conversation.chat.assistant-actions`（每轮花费，order 50 —— 与原生
 *     「用量 / 耗时」同一动作行）。
 *
 * 全程不覆盖任何原生条目、不占用 chain 槽位、不 import 任何 DSH 内部模块：
 * 运行时只用平台模块表里的 `react` 与 `@deepseek-ai/dsh-client-ui-primitives`；
 * `ctx.slots` / `ctx.locale` 都是 cordis 服务，其余 DSH 包一律 type-only。
 *
 * 所有注册都包在 try/catch 里，且每个 pill 外面还套了错误边界（guard.tsx）：
 * **本插件任何一环失败都只是"这个 pill 不出现"，不会影响 DSH 的启动与运行。**
 *
 * @module dsh-turn-cost/client
 */

import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
// type-only：拉入 ctx.slots / ctx.locale / SlotMap / useProjection 的类型合并。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { CostBoundary } from './guard.tsx'
import { SessionCostPill, type SessionCostPillProps } from './SessionCostPill.tsx'
import { TurnCostAction, type TurnCostActionProps } from './TurnCostAction.tsx'
import { en, zh } from './locales.ts'
import type { TurnCostKey } from './locales.ts'

export type { TurnCostKey } from './locales.ts'
export type { CostDialogPage, CostDialogPagerLabels, CostDialogProps, CostDialogRow } from './CostDialog.tsx'

/** 插件名（client 半独立命名，避免与 host 半的诊断名混淆）。 */
export const name = 'turn-cost-client'

/** 需要的服务：槽位注册表与文案运行时（缺任一则保持 pending，而不是硬失败）。 */
export const inject = ['slots', 'locale']

/** 本插件拥有的字典命名空间。 */
const NS = 'turn-cost'

/**
 * 给槽位组件套上错误边界（渲染异常 → 该 pill 消失，宿主 UI 不受影响）。
 * @param Inner - 本插件的槽位组件。
 * @returns 带错误边界的同名组件。
 */
function guarded<P extends object>(Inner: (props: P) => ReactNode): (props: P) => ReactNode {
  return function Guarded(props: P): ReactNode {
    return <CostBoundary><Inner {...props} /></CostBoundary>
  }
}

/** 会话 pill（带错误边界）。 */
const SafeSessionCostPill = guarded<SessionCostPillProps>(SessionCostPill)

/** 每轮 pill（带错误边界）。 */
const SafeTurnCostAction = guarded<TurnCostActionProps>(TurnCostAction)

/**
 * client 插件体：字典 + 两个追加式槽位条目。
 * @param ctx - client 根上下文。
 */
export function apply(ctx: Context): void {
  try {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-turn-cost: dictionaries')

    // 槽位核心对同 (slot, id, priority) 的第二次注册会抛错；插件被重复装配
    // （运行时注入与 profile bundle 同时生效）时，这里保留先注册的那一份、
    // 静默让位 —— 结果是最多一组 pill，而不是控制台报错或重复 UI。
    ctx.slots.inject('conversation.composer.dock', () => {
      try {
        return ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'turn-cost',
          order: 1,
          locale: NS,
        }, SafeSessionCostPill)
      } catch (error) {
        warn(error)
        return () => {}
      }
    })

    ctx.slots.inject('conversation.chat.assistant-actions', () => {
      try {
        return ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'turn-cost',
          order: 50,
          locale: NS,
        }, SafeTurnCostAction)
      } catch (error) {
        warn(error)
        return () => {}
      }
    })
  } catch (error) {
    warn(error)
  }
}

/** 注册失败只记录，绝不外抛（client 插件抛错会打断整条客户端装配链）。 */
function warn(error: unknown): void {
  try {
    console.warn('[dsh-turn-cost] client 装配失败（已忽略，界面照常）：', error)
  } catch {
    // 保持静默。
  }
}
