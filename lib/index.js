import { TURN_COST_KEY, createTurnCostProjection } from "./projection.js";
//#region src/index.ts
/** 插件名。 */
const name = "turn-cost";
/** 没有投影注册表就保持 pending（不硬失败、不影响宿主启动）。 */
const inject = ["sessionProjections"];
/**
* 注册 `turnCost` 投影单元。
* @param ctx - host 上下文。
* @param config - 可选配置（计价 provider、峰谷开关、pill 落位）。
*/
function apply(ctx, config = {}) {
	try {
		const projection = createTurnCostProjection(config ?? {});
		ctx.effect(() => ctx.sessionProjections.register(projection), "dsh-turn-cost: turnCost projection");
	} catch (error) {
		warn(ctx, error);
	}
}
/** 注册失败只记录，绝不外抛（host 插件抛错会打断 loader 的装配链）。 */
function warn(ctx, error) {
	try {
		ctx.logger?.warn?.(`[dsh-turn-cost] 注册 turnCost 投影失败（已忽略，DSH 不受影响）：${String(error)}`);
	} catch {}
}
//#endregion
export { TURN_COST_KEY, apply, inject, name };
