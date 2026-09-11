import { formatCost } from "./cost-format.js";
import { agentRows, overviewRows, subagentPageRows } from "./rows.js";
//#region src/client/dialog-pages.ts
/** 无子代理时的页数（单页：总计即自身）。 */
const SINGLE_PAGE = 1;
/** 主 Agent 页之前固定有的两页（总计 + 主 Agent）。 */
const LEADING_PAGES = 2;
/** 把外部输入清洗成"页数意义上的个数"（非负整数；脏输入 → 0）。 */
function countOf(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}
/** 把外部输入清洗成"合法页数"（至少 1 页）。 */
function totalPages(count) {
	const total = countOf(count);
	return total > SINGLE_PAGE ? total : SINGLE_PAGE;
}
/**
* 子代理个数 → 页数。
* @param subagentCount - 有花费的子代理个数。
* @returns `0` → 1 页（单页退化）；`n > 0` → `n + 2` 页（总计 + 主 Agent + 每个子代理一页）。
*/
function pageCount(subagentCount) {
	const count = countOf(subagentCount);
	return count === 0 ? SINGLE_PAGE : count + LEADING_PAGES;
}
/**
* 把页码钳进合法范围（子代理数变化会让页数变少，当前页必须跟着夹住）。
* @param index - 期望的页码（0 起）。
* @param count - 页数。
* @returns `[0, 页数 - 1]` 内的整数；`count ≤ 1` 恒为 0。
*/
function clampPage(index, count) {
	const total = totalPages(count);
	return Math.min(Math.max(typeof index === "number" && Number.isFinite(index) ? Math.trunc(index) : 0, 0), total - 1);
}
/**
* 步进翻页（两端夹住，不环绕）—— 翻页按钮与左右方向键用它。
* @param index - 当前页码（0 起）。
* @param delta - 步长（±1）。
* @param count - 页数。
* @returns 新页码。
*/
function stepPage(index, delta, count) {
	const move = typeof delta === "number" && Number.isFinite(delta) ? Math.trunc(delta) : 0;
	return clampPage(clampPage(index, count) + move, count);
}
/**
* 循环翻页（首尾相接）—— 回车键用它，连按即可把每页都过一遍。
* @param index - 当前页码（0 起）。
* @param delta - 步长（±1）。
* @param count - 页数。
* @returns 新页码。
*/
function cyclePage(index, delta, count) {
	const total = totalPages(count);
	const from = clampPage(index, total);
	const move = typeof delta === "number" && Number.isFinite(delta) ? Math.trunc(delta) : 0;
	if (move === 0) return from;
	return ((from + move) % total + total) % total;
}
/**
* 页码指示串（`2/4`；语言无关，因此不进词典）。
* @param index - 当前页码（0 起）。
* @param count - 页数。
* @returns 例如 `2/4`。
*/
function pageIndicator(index, count) {
	return `${String(clampPage(index, count) + 1)}/${String(totalPages(count))}`;
}
/**
* 装配弹窗的页列表。
* @param t - 文案座位。
* @param input - 见 {@link AgentPagesInput}。
* @returns 页列表（长度恒 ≥ 1；长度 1 时调用方不渲染翻页控件）。
*/
function agentPages(t, input) {
	const sub = input.subagents;
	const ownTotal = input.own.cost.total;
	if (sub === void 0 || sub.rows.length === 0) return [{
		total: formatCost(ownTotal),
		rows: agentRows(t, input.own, t("cost.total"), { withModel: input.ownModelOnSinglePage })
	}];
	const pages = [{
		total: formatCost(ownTotal + sub.cost),
		rows: overviewRows(t, {
			own: input.own,
			sub,
			subagentCount: sub.rows.length
		})
	}, {
		total: formatCost(ownTotal),
		rows: agentRows(t, input.own, t(input.ownTotalLabel))
	}];
	for (const row of sub.rows) pages.push({
		total: formatCost(row.cost),
		rows: subagentPageRows(t, row, sub.details[row.id])
	});
	return pages;
}
//#endregion
export { agentPages, clampPage, cyclePage, pageCount, pageIndicator, stepPage };
