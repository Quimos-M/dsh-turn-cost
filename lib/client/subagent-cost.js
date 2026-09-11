//#region src/client/subagent-cost.ts
/** 空汇总（无后代 / 数据不可用时的安全牌）。 */
const NO_SUBAGENTS = {
	cost: 0,
	tokens: 0,
	rows: [],
	count: 0,
	unattributed: 0,
	byTurn: {},
	costBuckets: {
		hit: 0,
		miss: 0,
		out: 0,
		total: 0
	},
	tokBuckets: {
		hit: 0,
		miss: 0,
		out: 0,
		total: 0
	},
	details: {}
};
/** 安全取非负整数。 */
function countOf(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
/** 全零三桶金额。 */
function zeroCost() {
	return {
		hit: 0,
		miss: 0,
		out: 0,
		total: 0
	};
}
/** 全零三桶 token。 */
function zeroTok() {
	return {
		hit: 0,
		miss: 0,
		out: 0,
		total: 0
	};
}
/** 把来源的三桶金额（清洗为非负整数）累加进目标。 */
function addCost(target, source) {
	target.hit += countOf(source?.hit);
	target.miss += countOf(source?.miss);
	target.out += countOf(source?.out);
	target.total += countOf(source?.total);
}
/** 把来源的三桶 token（清洗为非负整数）累加进目标。 */
function addTok(target, source) {
	target.hit += countOf(source?.hit);
	target.miss += countOf(source?.miss);
	target.out += countOf(source?.out);
	target.total += countOf(source?.total);
}
/**
* 该会话日志里出现过的模型（去重、按轮次顺序）；读不出时为空数组。
*
* 两个 pill 的"主 Agent 页"要显示模型，而投影的 `totals` 不带模型（模型在逐轮条目
* 上），因此这里按轮次把模型收集起来 —— 跨模型会话会列出全部，不假装只有一个。
* @param view - 任一会话的 `turnCost` 投影。
* @returns 模型 id 列表。
*/
function modelsOfView(view) {
	const seen = /* @__PURE__ */ new Set();
	const models = [];
	for (const key of Object.keys(view?.turns ?? {})) {
		const model = view?.turns?.[key]?.model;
		if (typeof model !== "string" || model === "" || seen.has(model)) continue;
		seen.add(model);
		models.push(model);
	}
	return models;
}
function turnStartsOf(view) {
	const own = view?.ownTurns;
	if (own === void 0 || own === null) return [];
	const starts = [];
	for (const key of Object.keys(own)) {
		const turn = Number(key);
		const at = own[key]?.startedAt;
		if (!Number.isFinite(turn) || typeof at !== "number" || !Number.isFinite(at)) continue;
		starts.push({
			turn,
			at
		});
	}
	starts.sort((left, right) => left.at - right.at || left.turn - right.turn);
	return starts;
}
/** 本会话里**最后一个不晚于 `at`** 的轮次；没有则 null。 */
function turnAtOrBefore(starts, at) {
	let found = null;
	for (const start of starts) {
		if (start.at > at) break;
		found = start.turn;
	}
	return found;
}
function ownTurnsOf(view) {
	const own = view?.ownTurns;
	if (own === void 0 || own === null || view?.ownComplete !== true) return {
		turns: Object.keys(view?.turns ?? {}).flatMap((key) => {
			const entry = view?.turns?.[key];
			const turn = Number(key);
			if (entry === void 0 || !Number.isFinite(turn)) return [];
			const cost = zeroCost();
			const tok = zeroTok();
			addCost(cost, entry.cost);
			addTok(tok, entry.tok);
			return [{
				turn,
				cost,
				tok,
				startedAt: null
			}];
		}),
		legacy: true
	};
	return {
		turns: Object.keys(own).flatMap((key) => {
			const entry = own[key];
			const turn = Number(key);
			if (entry === void 0 || !Number.isFinite(turn)) return [];
			const startedAt = entry.startedAt;
			const cost = zeroCost();
			const tok = zeroTok();
			addCost(cost, entry.cost);
			addTok(tok, entry.tok);
			return [{
				turn,
				cost,
				tok,
				startedAt: typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : null
			}];
		}),
		legacy: false
	};
}
/** 取"某会话创建某子会话"的锚点轮号；`0` / 缺失表示未知。 */
function anchorTurnOf(owner, childId) {
	const spawn = owner?.projectionValues?.turnCost?.spawns?.[childId];
	if (spawn === void 0 || spawn === null) return null;
	return {
		turn: countOf(spawn.turn),
		mode: spawn.mode === "one-shot" || spawn.mode === "continuable" ? spawn.mode : "unknown"
	};
}
/**
* 收集 `rootId` 的全部后代（含孙代；沿 `origin === 'subagent'` + `parentId` 向上
* 回溯，带回环保护）。列表里断链的后代看不见 —— 也不可能有它们的投影值。
*/
function descendantsOf(rootId, sessions) {
	const byId = /* @__PURE__ */ new Map();
	for (const session of sessions) byId.set(session.id, session);
	const found = [];
	for (const session of sessions) {
		if (session.origin !== "subagent" || session.parentId === void 0) continue;
		const seen = new Set([session.id]);
		let current = session;
		let depth = 0;
		while (current !== void 0 && current.origin === "subagent" && current.parentId !== void 0) {
			if (seen.has(current.parentId)) {
				current = void 0;
				break;
			}
			seen.add(current.parentId);
			depth += 1;
			if (current.parentId === rootId) {
				found.push({
					row: session,
					depth,
					ownerId: session.parentId
				});
				break;
			}
			current = byId.get(current.parentId);
			if (current === void 0) break;
		}
	}
	return found;
}
/**
* 汇总 `rootId` 全部后代的花费，并按本会话轮次归属。
* @param rootId - 当前会话 id。
* @param sessions - 会话列表里的全部行（`useSessions(state => state.byId)` 的值）。
* @param rootView - 当前会话自己的 `turnCost` 投影（轮起点表来自它）。
* @returns 汇总；没有后代或数据不可用时返回 {@link NO_SUBAGENTS} 等价的空汇总。
*/
function rollupSubagentCost(rootId, sessions, rootView) {
	const descendants = descendantsOf(rootId, sessions);
	if (descendants.length === 0) return NO_SUBAGENTS;
	const byId = /* @__PURE__ */ new Map();
	for (const session of sessions) byId.set(session.id, session);
	const rootStarts = turnStartsOf(rootView);
	/** 祖先链兜底：把"某祖先会话的某一轮"换算成本会话的轮次。 */
	const resolveTurn = (ownerId, turn, seen) => {
		if (ownerId === rootId) return turn > 0 ? turn : null;
		if (seen.has(ownerId)) return null;
		seen.add(ownerId);
		const owner = byId.get(ownerId);
		if (owner === void 0) return null;
		const startAt = turnStartsOf(owner.projectionValues?.turnCost).find((entry) => entry.turn === turn)?.at;
		if (startAt !== void 0) {
			const mapped = turnAtOrBefore(rootStarts, startAt);
			if (mapped !== null) return mapped;
		}
		const ownerOfOwner = owner.parentId;
		if (ownerOfOwner === void 0) return null;
		const anchor = anchorTurnOf(byId.get(ownerOfOwner), ownerId);
		return anchor === null ? null : resolveTurn(ownerOfOwner, anchor.turn, seen);
	};
	const rows = [];
	const perTurn = /* @__PURE__ */ new Map();
	const details = {};
	const totalCostBuckets = zeroCost();
	const totalTokBuckets = zeroTok();
	let total = 0;
	let totalTokens = 0;
	let unattributed = 0;
	let count = 0;
	for (const descendant of descendants) {
		const view = descendant.row.projectionValues?.turnCost;
		const own = ownTurnsOf(view);
		const anchor = anchorTurnOf(byId.get(descendant.ownerId), descendant.row.id);
		const label = labelOf(descendant.row, anchorLabelOf(byId.get(descendant.ownerId), descendant.row.id));
		const mode = anchor === null ? "unknown" : anchor.mode;
		const models = modelsOfView(view);
		/** 逐轮归属：先时间窗，再创建锚点兜底；两者都没有则只进会话合计。 */
		const place = (startedAt) => {
			const mapped = startedAt === null ? null : turnAtOrBefore(rootStarts, startedAt);
			if (mapped !== null) return {
				key: String(mapped),
				exact: true
			};
			const fallback = anchor === null ? null : resolveTurn(descendant.ownerId, anchor.turn, /* @__PURE__ */ new Set());
			return fallback === null ? null : {
				key: String(fallback),
				exact: false
			};
		};
		let cost = 0;
		let tokens = 0;
		let exact = !own.legacy;
		const attributed = /* @__PURE__ */ new Set();
		const rowCost = zeroCost();
		const rowTok = zeroTok();
		for (const turn of own.turns) {
			cost += turn.cost.total;
			tokens += turn.tok.total;
			addCost(rowCost, turn.cost);
			addTok(rowTok, turn.tok);
			const placed = place(turn.startedAt);
			if (placed === null) {
				exact = false;
				unattributed += turn.cost.total;
				continue;
			}
			if (!placed.exact) exact = false;
			attributed.add(Number(placed.key));
			const slice = perTurn.get(placed.key) ?? {
				cost: 0,
				tokens: 0,
				rows: [],
				costBuckets: zeroCost(),
				tokBuckets: zeroTok(),
				details: {}
			};
			slice.cost += turn.cost.total;
			slice.tokens += turn.tok.total;
			addCost(slice.costBuckets, turn.cost);
			addTok(slice.tokBuckets, turn.tok);
			slice.rows.push({
				id: descendant.row.id,
				label,
				depth: descendant.depth,
				cost: turn.cost.total,
				tokens: turn.tok.total,
				mode,
				exact: placed.exact,
				turns: [Number(placed.key)]
			});
			const sliceDetail = slice.details[descendant.row.id] ?? {
				cost: zeroCost(),
				tok: zeroTok(),
				models
			};
			addCost(sliceDetail.cost, turn.cost);
			addTok(sliceDetail.tok, turn.tok);
			slice.details[descendant.row.id] = sliceDetail;
			perTurn.set(placed.key, slice);
		}
		if (cost <= 0 && tokens <= 0) continue;
		count += 1;
		total += cost;
		totalTokens += tokens;
		addCost(totalCostBuckets, rowCost);
		addTok(totalTokBuckets, rowTok);
		details[descendant.row.id] = {
			cost: rowCost,
			tok: rowTok,
			models
		};
		rows.push({
			id: descendant.row.id,
			label,
			depth: descendant.depth,
			cost,
			tokens,
			mode,
			exact,
			turns: [...attributed].sort((left, right) => left - right)
		});
	}
	if (count === 0) return NO_SUBAGENTS;
	rows.sort((left, right) => left.depth - right.depth || right.cost - left.cost || left.id.localeCompare(right.id));
	const byTurn = {};
	for (const [key, slice] of perTurn) byTurn[key] = {
		cost: slice.cost,
		tokens: slice.tokens,
		rows: slice.rows.sort((left, right) => left.depth - right.depth || right.cost - left.cost || left.id.localeCompare(right.id)),
		costBuckets: slice.costBuckets,
		tokBuckets: slice.tokBuckets,
		details: slice.details
	};
	return {
		cost: total,
		tokens: totalTokens,
		rows,
		count,
		unattributed,
		byTurn,
		costBuckets: totalCostBuckets,
		tokBuckets: totalTokBuckets,
		details
	};
}
/** 该子会话在创建锚点里的标签（来自父会话日志的 `subagent/catalog`）。 */
function anchorLabelOf(owner, childId) {
	const spawn = owner?.projectionValues?.turnCost?.spawns?.[childId];
	return typeof spawn?.label === "string" && spawn.label !== "" ? spawn.label : void 0;
}
/** 展示标签：会话标题 → 创建标签 → id 前 8 位。 */
function labelOf(row, anchorLabelValue) {
	const title = row.title ?? row.displayTitle;
	if (typeof title === "string" && title !== "") return title;
	if (anchorLabelValue !== void 0) return anchorLabelValue;
	return row.id.length > 8 ? row.id.slice(0, 8) : row.id;
}
//#endregion
export { NO_SUBAGENTS, modelsOfView, rollupSubagentCost };
