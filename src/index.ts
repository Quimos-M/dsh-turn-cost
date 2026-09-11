/**
 * dsh-turn-cost —— host 半（Node）。
 *
 * 只做一件事：把 `turnCost` 投影单元注册到 `ctx.sessionProjections`。投影是
 * DSH 的"能力接缝"：订阅、水位、变更推送与持久缓存全由框架负责，本插件只贡献
 * 一个纯 fold（见 ./projection.ts）。
 *
 * 健壮性：注册整体 try/catch；`inject` 声明让缺少投影注册表的环境保持 pending
 * 而不是失败；本插件**没有任何运行时 import**（host 半只 import type），因此
 * 不存在"依赖缺失导致加载失败"的路径。
 *
 * @module dsh-turn-cost
 */

import type { Context } from '@deepseek-ai/cordis'
import { createTurnCostProjection, type TurnCostOptions } from './projection.ts'

export type { TurnCostOptions } from './projection.ts'
export { TURN_COST_KEY } from './projection.ts'

/** 插件名。 */
export const name = 'turn-cost'

/** 没有投影注册表就保持 pending（不硬失败、不影响宿主启动）。 */
export const inject = ['sessionProjections']

/**
 * 注册 `turnCost` 投影单元。
 * @param ctx - host 上下文。
 * @param config - 可选配置（计价 provider、峰谷开关、pill 落位）。
 */
export function apply(ctx: Context, config: TurnCostOptions = {}): void {
  try {
    const projection = createTurnCostProjection(config ?? {})
    ctx.effect(
      () => ctx.sessionProjections.register(projection),
      'dsh-turn-cost: turnCost projection',
    )
  } catch (error) {
    warn(ctx, error)
  }
}

/** 注册失败只记录，绝不外抛（host 插件抛错会打断 loader 的装配链）。 */
function warn(ctx: Context, error: unknown): void {
  try {
    const logger = (ctx as unknown as { logger?: { warn?: (message: string) => void } }).logger
    logger?.warn?.(`[dsh-turn-cost] 注册 turnCost 投影失败（已忽略，DSH 不受影响）：${String(error)}`)
  } catch {
    // 保持静默。
  }
}
