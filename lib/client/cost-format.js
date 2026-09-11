//#region src/client/cost-format.ts
/**
* 金额与 token 的显示格式化。
*
* 金额在插件内部一律以**微元 µ¥**（整数）存放与累加，只在这里换算成显示串；
* 不足 ¥0.0001 的金额显示为 `<0.0001`，避免用一长串 0 假装精确。
*
* **货币标注只出现一次**：数值后跟 ISO 代码 `CNY`（人民币），配合金币图标表达
* "这是钱"。因此这里不再输出 `¥` 符号 —— 图标 + 符号重复标注对用户是噪音。
*
* @module dsh-turn-cost/client/cost-format
*/
/** 1 元 = 1e6 微元。 */
const MICRO_PER_YUAN = 1e6;
/** 低于该微元值（= 0.0001 元）时改用下限写法。 */
const DISPLAY_FLOOR_MICRO = 100;
/** 人民币 ISO 代码（唯一的货币标注）。 */
const UNIT = "CNY";
/**
* 微元 → 金额显示串（数值 + 货币单位）。
* @param micro - 金额（微元）。
* @returns 例如 `0.0123 CNY`；零为 `0 CNY`；不足四位小数的正值为 `<0.0001 CNY`。
*/
function formatCost(micro) {
	if (!Number.isFinite(micro) || micro <= 0) return `0 ${UNIT}`;
	if (micro < DISPLAY_FLOOR_MICRO) return `<0.0001 ${UNIT}`;
	return `${(micro / MICRO_PER_YUAN).toFixed(4)} ${UNIT}`;
}
/**
* token 数的精确显示（千分位）。
* @param count - token 数。
* @returns 例如 `12,345`。
*/
function formatTokens(count) {
	if (!Number.isFinite(count) || count <= 0) return "0";
	return Math.round(count).toLocaleString("en-US");
}
/**
* 缓存命中率（命中 / 全部提示侧输入）。
* @param hit - 缓存命中输入的 token 数。
* @param miss - 缓存未命中输入的 token 数。
* @returns 例如 `93.4%`；没有输入时返回 null。
*/
function formatHitRate(hit, miss) {
	const total = hit + miss;
	if (!Number.isFinite(total) || total <= 0) return null;
	return `${(hit / total * 100).toFixed(1)}%`;
}
/**
* 「金额（tokens）」组合串，用于弹窗明细行。
* @param micro - 金额（微元）。
* @param tokens - 该桶 token 数。
* @returns 例如 `0.0012 CNY（1,234 tokens）` / `<0.0001 CNY（12 tokens）`。
*/
function formatCostWithTokens(micro, tokens) {
	return `${formatCost(micro)}（${formatTokens(tokens)} tokens）`;
}
//#endregion
export { formatCost, formatCostWithTokens, formatHitRate, formatTokens };
