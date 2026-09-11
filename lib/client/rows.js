import { formatCost, formatCostWithTokens, formatHitRate } from "./cost-format.js";
//#region src/client/rows.ts
/** 模型行的多个模型之间的分隔符（与 pill 里的 ` · ` 同款）。 */
const MODEL_SEP = " · ";
/** 三桶金额相加（不改动入参）。 */
function sumCost(left, right) {
	return {
		hit: left.hit + right.hit,
		miss: left.miss + right.miss,
		out: left.out + right.out,
		total: left.total + right.total
	};
}
/** 三桶 token 相加（不改动入参）。 */
function sumTok(left, right) {
	return {
		hit: left.hit + right.hit,
		miss: left.miss + right.miss,
		out: left.out + right.out,
		total: left.total + right.total
	};
}
/**
* 三桶明细行 + 合计行（原生 stat-dialog 的"缓存命中输入 / 缓存未命中输入 / 输出"
* 口径）。
* @param t - 文案座位。
* @param cost - 三桶金额（µ¥）。
* @param tok - 三桶 token。
* @param totalLabel - 合计行的标签（合计 / 本会话自身 / 合计（含子代理））。
* @returns 明细行。
*/
function bucketRows(t, cost, tok, totalLabel) {
	return [
		{
			label: t("cost.cacheHitInput"),
			value: formatCostWithTokens(cost.hit, tok.hit)
		},
		{
			label: t("cost.cacheMissInput"),
			value: formatCostWithTokens(cost.miss, tok.miss)
		},
		{
			label: t("cost.output"),
			value: formatCostWithTokens(cost.out, tok.out)
		},
		{
			label: totalLabel,
			value: formatCost(cost.total)
		}
	];
}
/**
* 单个代理的明细行（模型 → 缓存命中率 → 三桶 → 合计）。
* @param t - 文案座位。
* @param ledger - 该代理的账。
* @param totalLabel - 合计行标签。
* @param options - 见 {@link AgentRowOptions}。
* @returns 明细行。
*/
function agentRows(t, ledger, totalLabel, options = {}) {
	const models = ledger.models.filter((model) => model !== "");
	const rate = formatHitRate(ledger.tok.hit, ledger.tok.miss);
	return [
		...options.withModel !== false && models.length > 0 ? [{
			label: t("cost.model"),
			value: models.join(MODEL_SEP),
			wrap: true
		}] : [],
		...options.withHitRate === false || rate === null ? [] : [{
			label: t("cost.hitRate"),
			value: rate
		}],
		...bucketRows(t, ledger.cost, ledger.tok, totalLabel)
	];
}
/**
* 第 1 页（总计）的明细行：合计口径的三桶 + 构成摘要。
* @param t - 文案座位。
* @param input - 见 {@link OverviewInput}。
* @returns 明细行。
*/
function overviewRows(t, input) {
	const buckets = sumCost(input.own.cost, input.sub.costBuckets);
	const tok = sumTok(input.own.tok, input.sub.tokBuckets);
	const cost = {
		...buckets,
		total: input.own.cost.total + input.sub.cost
	};
	const rate = formatHitRate(tok.hit, tok.miss);
	return [
		...rate === null ? [] : [{
			label: t("cost.hitRate"),
			value: rate
		}],
		...bucketRows(t, cost, tok, t("cost.grandTotal")),
		{
			label: `${t("cost.agentsLead")} ${String(Math.max(0, input.subagentCount) + 1)} ${t("cost.agentsTail")}`,
			value: `${t("cost.mainAgent")} ${formatCost(input.own.cost.total)} + ${t("cost.subagent")} ${formatCost(input.sub.cost)}`,
			wrap: true
		}
	];
}
/**
* 归属文案：这个子代理的花费落到了本会话的哪一轮（沿用聚合的标注口径）。
* @param t - 文案座位。
* @param row - 子代理行。
* @returns 例如 `第 12 轮、第 13 轮 · 精确` / `第 13 轮 · 按创建轮归属` / 未归属说明。
*/
function attributionText(t, row) {
	if (row.turns.length === 0) return t("cost.subagentUnattributed");
	const turns = row.turns.map((turn) => `${t("cost.turnLead")}${String(turn)}${t("cost.turnTail")}`).join(t("cost.turnSep"));
	const mark = row.exact ? t("cost.attributedExact") : t("cost.subagentAnchored");
	return `${turns}${t("cost.turnMark")}${mark}`;
}
/**
* 一个子代理一页的明细行：名称（含层级缩进）→ 模型 / 三桶 / 合计 → 归属。
*
* 这一页不显示缓存命中率：用户要的是"哪个代理花了多少、算在哪一轮"，行数与第 1 / 2 页
* 对齐（最长 7 行）后翻页时面板高度不抖（见 `dialog.module.css` 的 `.detailsPaged`）。
* @param t - 文案座位。
* @param row - 子代理行（来自会话级 rollup 或某一轮切片）。
* @param detail - 该子代理的展开细目（三桶 / 模型）；读不到时退回行上的合计。
* @returns 明细行。
*/
function subagentPageRows(t, row, detail) {
	const indent = "· ".repeat(Math.max(0, row.depth - 1));
	const ledger = {
		cost: detail?.cost ?? {
			hit: 0,
			miss: 0,
			out: 0,
			total: row.cost
		},
		tok: detail?.tok ?? {
			hit: 0,
			miss: 0,
			out: 0,
			total: row.tokens
		},
		models: detail?.models ?? []
	};
	return [
		{
			label: t("cost.subagent"),
			value: `${indent}${row.label}`,
			wrap: true
		},
		...agentRows(t, ledger, t("cost.total"), {
			withModel: true,
			withHitRate: false
		}),
		{
			label: t("cost.agentTurn"),
			value: attributionText(t, row),
			wrap: true
		}
	];
}
/**
* 价格口径脚注：说明这些数字是按哪一版官方价、按峰还是按谷算出来的。
* @param t - 文案座位。
* @param peak - 末次计价请求是否高峰；null 表示无从判断（不写峰谷）。
* @param priceAsOf - 口径标签（价表版本）。
* @param estimated - 是否含未收录模型的估算。
* @param notes - 追加说明（例如"含子代理"的口径说明）。
* @returns 脚注文本。
*/
function footnote(t, peak, priceAsOf, estimated, notes = []) {
	const parts = [t("cost.priceNote")];
	if (peak !== null) parts.push(peak ? t("cost.peak") : t("cost.valley"));
	parts.push(priceAsOf);
	if (estimated) parts.push(t("cost.estimated"));
	parts.push(...notes);
	return parts.join(" · ");
}
//#endregion
export { agentRows, attributionText, bucketRows, footnote, overviewRows, subagentPageRows };
