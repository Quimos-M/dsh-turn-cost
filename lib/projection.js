import { PRICE_AS_OF, costOf, resolvePrice } from "./prices.js";
//#region src/projection.ts
/** 投影键。 */
const TURN_COST_KEY = "turnCost";
/**
* 折叠**结构演进**策略（重要取舍，勿轻易改回"改形状就 +stateVersion"）。
*
* 持久缓存行以 `(sessionId,key,ver)` 为准：`ver` 不匹配 ⇒ 整行作废、由零重折。
* 那是"旧值语义已经错了"时的正确做法（例如价表改了）。但**加字段**不是那种情况：
* 一个冷会话（未挂载）的旧行如果被作废，它的 wire 值就整体消失 —— 客户端据此
* 聚合子代理花费时，这个子会话会**静默掉出父会话的总账**，直到该会话被重新折叠
* （可能永远不发生：用户不会去点开每一个旧子会话）。
*
* 所以加字段时**不动 `stateVersion`**，改用显式的**覆盖标记**（状态里的
* `ownComplete`）：由 `init`（从 seq 0 折起，覆盖整段日志）写 1，由 `stateSchema.parse`
* （只可能出现在"从持久行恢复"的两条路径上）**保留**旧值、缺省 0。旧行因此照旧
* 可用，只是客户端知道"这个值的自身口径没有覆盖整段日志"，从而退回整段口径的
* 兼容读法并标注为近似（见 `src/client/subagent-cost.ts`）。
*
* 只有当一个改动会让**已有字段的语义**变得不可解释时，才在 `PRICE_REVISION`
* 之外再加一个结构修订号（那就该作废旧行了）。
*/
const PROJECTION_STATE_VERSION = 1;
/** 直接子会话锚点：`subagent/catalog`（父会话自有事实，不带用量）。 */
const EVENT_SUBAGENT_CATALOG = "subagent/catalog";
/** 默认计价 provider：DeepSeek 官方路由。 */
const DEFAULT_PRICED_PROVIDERS = ["deepseek-official"];
function recordOf(value) {
	return typeof value === "object" && value !== null ? value : {};
}
function countOf(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function optionalCountOf(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function textOf(value) {
	return typeof value === "string" ? value : "";
}
function placementOf(value) {
	return value === "between" || value === "after-time" || value === "inline" ? value : "before-usage";
}
/** 某个事件是否携带可用的 provider 用量样本。 */
function normalizeUsage(value) {
	const usage = recordOf(value);
	const miss = optionalCountOf(usage.inputTokens);
	const out = optionalCountOf(usage.outputTokens);
	if (miss === null || out === null) return void 0;
	return {
		hit: optionalCountOf(usage.cacheReadTokens) ?? 0,
		miss,
		out
	};
}
/** 在 assistant 流记录里找最后一条 usage chunk（与原生 lastAssistantStreamChunk 同源语义）。 */
function streamUsage(stream) {
	if (!Array.isArray(stream)) return void 0;
	for (let index = stream.length - 1; index >= 0; index -= 1) {
		const record = recordOf(stream[index]);
		if (record.type === "usage") return record.usage;
		if (record.type !== "chunk") continue;
		const chunk = recordOf(record.chunk);
		if (chunk.type === "usage") return chunk.usage;
	}
}
/** 从 `{provider, model}` 形状里取路由。 */
function routePair(value) {
	const source = recordOf(value);
	const provider = textOf(source.provider);
	const model = textOf(source.model);
	return provider === "" && model === "" ? null : {
		provider,
		model
	};
}
function zeroAccumulator() {
	return {
		costHit: 0,
		costMiss: 0,
		costOut: 0,
		tokHit: 0,
		tokMiss: 0,
		tokOut: 0
	};
}
function addAccumulator(base, delta) {
	return {
		costHit: base.costHit + delta.costHit,
		costMiss: base.costMiss + delta.costMiss,
		costOut: base.costOut + delta.costOut,
		tokHit: base.tokHit + delta.tokHit,
		tokMiss: base.tokMiss + delta.tokMiss,
		tokOut: base.tokOut + delta.tokOut
	};
}
/** 同一替换槽的新旧差：`next - previous`（previous 为 null 时即 next）。 */
function replaceDelta(next, previous) {
	if (previous === null) return next;
	return {
		costHit: next.costHit - previous.costHit,
		costMiss: next.costMiss - previous.costMiss,
		costOut: next.costOut - previous.costOut,
		tokHit: next.tokHit - previous.tokHit,
		tokMiss: next.tokMiss - previous.tokMiss,
		tokOut: next.tokOut - previous.tokOut
	};
}
function isPriced(provider, options) {
	if (provider === "") return true;
	return options.pricedProviders.includes("*") || options.pricedProviders.includes(provider);
}
/** 事件序号（缺失/非数字一律当 0；序号只用于"是否属于继承前缀"的判定）。 */
function seqOf(event) {
	const seq = event.seq;
	return typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0 ? seq : 0;
}
/** 事件时刻（缺失/非法时返回 null，不写假时间）。 */
function timeOf(event) {
	const time = event.time;
	return typeof time === "number" && Number.isFinite(time) ? time : null;
}
/** 在"自身视角"里加一笔（越界为负时钳到 0：正常路径不会触发，见 ownLast 注释）。 */
function addOwnTurn(base, delta, startedAt) {
	const previous = base ?? {
		costHit: 0,
		costMiss: 0,
		costOut: 0,
		tokHit: 0,
		tokMiss: 0,
		tokOut: 0
	};
	const next = {
		costHit: Math.max(0, previous.costHit + delta.costHit),
		costMiss: Math.max(0, previous.costMiss + delta.costMiss),
		costOut: Math.max(0, previous.costOut + delta.costOut),
		tokHit: Math.max(0, previous.tokHit + delta.tokHit),
		tokMiss: Math.max(0, previous.tokMiss + delta.tokMiss),
		tokOut: Math.max(0, previous.tokOut + delta.tokOut)
	};
	const start = startedAt ?? previous.startedAt;
	return start === void 0 ? next : {
		...next,
		startedAt: start
	};
}
/** 一次 usage 采样 → 新状态（替换语义 + 每轮/累计双写）。 */
function accrue(state, event, options) {
	const data = recordOf(event.data);
	const turn = optionalCountOf(data.turn);
	const step = optionalCountOf(data.step);
	if (turn === null || step === null) return state;
	const usage = normalizeUsage(data.usage) ?? normalizeUsage(streamUsage(data.stream));
	if (usage === void 0) return state;
	const route = routePair(recordOf(data.message).source) ?? state.header;
	if (!isPriced(route?.provider ?? "", options)) return state;
	const model = route?.model ?? "";
	const price = resolvePrice(model, typeof event.time === "number" && Number.isFinite(event.time) ? event.time : Date.now(), { peakPricing: options.peakPricing });
	const tokens = {
		hit: usage.hit,
		miss: usage.miss,
		out: usage.out
	};
	const money = costOf(tokens, price);
	const next = {
		costHit: money.hit,
		costMiss: money.miss,
		costOut: money.out,
		tokHit: tokens.hit,
		tokMiss: tokens.miss,
		tokOut: tokens.out
	};
	const key = String(turn);
	const previousTurn = state.turns[key];
	const delta = replaceDelta(next, state.last !== null && state.last.turn === turn && state.last.step === step ? state.last : null);
	const turnValue = {
		...addAccumulator(previousTurn ?? zeroAccumulator(), delta),
		peak: price.peak ? 1 : 0,
		model: model === "" ? previousTurn?.model ?? "" : model,
		...price.asOf === state.asOf ? {} : { asOf: price.asOf },
		...price.estimated || previousTurn?.est === 1 ? { est: 1 } : {}
	};
	const turns = { ...state.turns };
	turns[key] = turnValue;
	const ownDelta = replaceDelta(next, state.ownLast !== null && state.ownLast.turn === turn && state.ownLast.step === step ? state.ownLast : null);
	const owned = seqOf(event) >= state.inherited;
	const ownTurns = { ...state.ownTurns };
	if (owned) ownTurns[key] = addOwnTurn(ownTurns[key], ownDelta, void 0);
	return {
		...state,
		totals: addAccumulator(state.totals, delta),
		turns,
		last: {
			turn,
			step,
			...next
		},
		ownTurns,
		ownLast: owned ? {
			turn,
			step,
			...next
		} : state.ownLast
	};
}
/** 单个事件的纯折叠（异常由调用方兜住）。 */
function fold(state, event, options) {
	const data = recordOf(event.data);
	switch (event.type) {
		case "request/header": {
			const route = routePair(recordOf(recordOf(data.header).config));
			if (route === null) return state;
			if (state.header !== null && state.header.provider === route.provider && state.header.model === route.model) return state;
			return {
				...state,
				header: route
			};
		}
		case "llm/retry-started": {
			const turn = optionalCountOf(data.turn);
			const step = optionalCountOf(data.step);
			if (turn === null || step === null) return state;
			const dropped = state.last !== null && state.last.turn === turn && state.last.step === step;
			const droppedOwn = state.ownLast !== null && state.ownLast.turn === turn && state.ownLast.step === step;
			if (!dropped && !droppedOwn) return state;
			return {
				...state,
				...dropped ? { last: null } : {},
				...droppedOwn ? { ownLast: null } : {}
			};
		}
		case "turn/start": {
			const turn = optionalCountOf(data.turn);
			if (turn === null) return state;
			if (seqOf(event) < state.inherited) return state.currentTurn === turn ? state : {
				...state,
				currentTurn: turn
			};
			const key = String(turn);
			const previous = state.ownTurns[key];
			const start = previous?.startedAt ?? timeOf(event) ?? void 0;
			if (previous !== void 0 && previous.startedAt === start) return state.currentTurn === turn ? state : {
				...state,
				currentTurn: turn
			};
			const nextOwn = {
				...previous ?? {
					costHit: 0,
					costMiss: 0,
					costOut: 0,
					tokHit: 0,
					tokMiss: 0,
					tokOut: 0
				},
				...start === void 0 ? {} : { startedAt: start }
			};
			return {
				...state,
				currentTurn: turn,
				ownTurns: {
					...state.ownTurns,
					[key]: nextOwn
				}
			};
		}
		case EVENT_SUBAGENT_CATALOG: {
			if (seqOf(event) < state.inherited) return state;
			const childId = textOf(data.childId);
			if (childId === "" || childId === void 0) return state;
			const mode = data.mode === "one-shot" ? "one-shot" : "continuable";
			const at = timeOf(event) ?? optionalCountOf(data.childCreatedAt) ?? 0;
			const label = textOf(data.label);
			const spawn = {
				turn: state.currentTurn ?? 0,
				at,
				mode,
				...label === "" ? {} : { label }
			};
			const previous = state.spawns[childId];
			if (previous !== void 0 && previous.turn === spawn.turn && previous.at === spawn.at && previous.mode === spawn.mode && previous.label === spawn.label) return state;
			return {
				...state,
				spawns: {
					...state.spawns,
					[childId]: spawn
				}
			};
		}
		case "assistant/message":
		case "assistant/attempt": return accrue(state, event, options);
		default: return state;
	}
}
function project(state) {
	const turns = {};
	let estimated = false;
	for (const key of Object.keys(state.turns)) {
		const value = state.turns[key];
		if (value === void 0) continue;
		turns[key] = {
			cost: {
				hit: value.costHit,
				miss: value.costMiss,
				out: value.costOut,
				total: value.costHit + value.costMiss + value.costOut
			},
			tok: {
				hit: value.tokHit,
				miss: value.tokMiss,
				out: value.tokOut,
				total: value.tokHit + value.tokMiss + value.tokOut
			},
			peak: value.peak === 1,
			model: value.model,
			...value.asOf === void 0 ? {} : { asOf: value.asOf },
			...value.est === 1 ? { est: true } : {}
		};
		if (value.est === 1) estimated = true;
	}
	const ownTurns = {};
	for (const key of Object.keys(state.ownTurns)) {
		const value = state.ownTurns[key];
		if (value === void 0) continue;
		ownTurns[key] = {
			cost: {
				hit: value.costHit,
				miss: value.costMiss,
				out: value.costOut,
				total: value.costHit + value.costMiss + value.costOut
			},
			tok: {
				hit: value.tokHit,
				miss: value.tokMiss,
				out: value.tokOut,
				total: value.tokHit + value.tokMiss + value.tokOut
			},
			...value.startedAt === void 0 ? {} : { startedAt: value.startedAt }
		};
	}
	const spawns = {};
	for (const key of Object.keys(state.spawns)) {
		const value = state.spawns[key];
		if (value === void 0) continue;
		spawns[key] = {
			turn: value.turn,
			at: value.at,
			mode: value.mode,
			...value.label === void 0 ? {} : { label: value.label }
		};
	}
	return {
		totals: {
			cost: {
				hit: state.totals.costHit,
				miss: state.totals.costMiss,
				out: state.totals.costOut,
				total: state.totals.costHit + state.totals.costMiss + state.totals.costOut
			},
			tok: {
				hit: state.totals.tokHit,
				miss: state.totals.tokMiss,
				out: state.totals.tokOut,
				total: state.totals.tokHit + state.totals.tokMiss + state.totals.tokOut
			}
		},
		turns,
		priceAsOf: state.asOf,
		placement: state.placement,
		...estimated ? { est: true } : {},
		ownTurns,
		spawns,
		ownComplete: state.ownComplete === 1
	};
}
/** 空视图：view 万一失手时的安全牌（宁可少显示，不可抛错）。 */
const EMPTY_PROJECTION = {
	totals: {
		cost: {
			hit: 0,
			miss: 0,
			out: 0,
			total: 0
		},
		tok: {
			hit: 0,
			miss: 0,
			out: 0,
			total: 0
		}
	},
	turns: {},
	priceAsOf: PRICE_AS_OF,
	placement: "before-usage",
	ownTurns: {},
	spawns: {},
	ownComplete: true
};
const stateSchema = { parse(value) {
	const raw = recordOf(value);
	const totalsRaw = recordOf(raw.totals);
	const turnsRaw = recordOf(raw.turns);
	const turns = {};
	for (const key of Object.keys(turnsRaw)) {
		const turnRaw = recordOf(turnsRaw[key]);
		turns[key] = {
			costHit: countOf(turnRaw.costHit),
			costMiss: countOf(turnRaw.costMiss),
			costOut: countOf(turnRaw.costOut),
			tokHit: countOf(turnRaw.tokHit),
			tokMiss: countOf(turnRaw.tokMiss),
			tokOut: countOf(turnRaw.tokOut),
			peak: turnRaw.peak === 1 ? 1 : 0,
			model: textOf(turnRaw.model),
			...textOf(turnRaw.asOf) === "" ? {} : { asOf: textOf(turnRaw.asOf) },
			...turnRaw.est === 1 ? { est: 1 } : {}
		};
	}
	const lastRaw = raw.last === null || raw.last === void 0 ? null : recordOf(raw.last);
	const headerRaw = raw.header === null || raw.header === void 0 ? null : recordOf(raw.header);
	const ownTurnsRaw = recordOf(raw.ownTurns);
	const ownTurns = {};
	for (const key of Object.keys(ownTurnsRaw)) {
		const turnRaw = recordOf(ownTurnsRaw[key]);
		const startedAt = optionalCountOf(turnRaw.startedAt);
		ownTurns[key] = {
			costHit: countOf(turnRaw.costHit),
			costMiss: countOf(turnRaw.costMiss),
			costOut: countOf(turnRaw.costOut),
			tokHit: countOf(turnRaw.tokHit),
			tokMiss: countOf(turnRaw.tokMiss),
			tokOut: countOf(turnRaw.tokOut),
			...startedAt === null ? {} : { startedAt }
		};
	}
	const ownLastRaw = raw.ownLast === null || raw.ownLast === void 0 ? null : recordOf(raw.ownLast);
	const spawnsRaw = recordOf(raw.spawns);
	const spawns = {};
	for (const key of Object.keys(spawnsRaw)) {
		const spawnRaw = recordOf(spawnsRaw[key]);
		const label = textOf(spawnRaw.label);
		spawns[key] = {
			turn: countOf(spawnRaw.turn),
			at: countOf(spawnRaw.at),
			mode: spawnRaw.mode === "one-shot" ? "one-shot" : "continuable",
			...label === "" ? {} : { label }
		};
	}
	const currentTurn = optionalCountOf(raw.currentTurn);
	return {
		totals: {
			costHit: countOf(totalsRaw.costHit),
			costMiss: countOf(totalsRaw.costMiss),
			costOut: countOf(totalsRaw.costOut),
			tokHit: countOf(totalsRaw.tokHit),
			tokMiss: countOf(totalsRaw.tokMiss),
			tokOut: countOf(totalsRaw.tokOut)
		},
		turns,
		header: headerRaw === null ? null : {
			provider: textOf(headerRaw.provider),
			model: textOf(headerRaw.model)
		},
		last: lastRaw === null ? null : {
			turn: countOf(lastRaw.turn),
			step: countOf(lastRaw.step),
			costHit: countOf(lastRaw.costHit),
			costMiss: countOf(lastRaw.costMiss),
			costOut: countOf(lastRaw.costOut),
			tokHit: countOf(lastRaw.tokHit),
			tokMiss: countOf(lastRaw.tokMiss),
			tokOut: countOf(lastRaw.tokOut)
		},
		asOf: textOf(raw.asOf) === "" ? PRICE_AS_OF : textOf(raw.asOf),
		placement: placementOf(raw.placement),
		inherited: countOf(raw.inherited),
		ownComplete: raw.ownComplete === 1 ? 1 : 0,
		currentTurn,
		ownTurns,
		ownLast: ownLastRaw === null ? null : {
			turn: countOf(ownLastRaw.turn),
			step: countOf(ownLastRaw.step),
			costHit: countOf(ownLastRaw.costHit),
			costMiss: countOf(ownLastRaw.costMiss),
			costOut: countOf(ownLastRaw.costOut),
			tokHit: countOf(ownLastRaw.tokHit),
			tokMiss: countOf(ownLastRaw.tokMiss),
			tokOut: countOf(ownLastRaw.tokOut)
		},
		spawns
	};
} };
const viewSchema = { parse(value) {
	const raw = recordOf(value);
	const totalsRaw = recordOf(raw.totals);
	const totalsCost = recordOf(totalsRaw.cost);
	const totalsTok = recordOf(totalsRaw.tok);
	const turnsRaw = recordOf(raw.turns);
	const turns = {};
	let estimated = false;
	for (const key of Object.keys(turnsRaw)) {
		const entry = recordOf(turnsRaw[key]);
		const cost = recordOf(entry.cost);
		const tok = recordOf(entry.tok);
		const hit = countOf(cost.hit);
		const miss = countOf(cost.miss);
		const out = countOf(cost.out);
		const tokHit = countOf(tok.hit);
		const tokMiss = countOf(tok.miss);
		const tokOut = countOf(tok.out);
		const isEst = entry.est === true;
		if (isEst) estimated = true;
		turns[key] = {
			cost: {
				hit,
				miss,
				out,
				total: hit + miss + out
			},
			tok: {
				hit: tokHit,
				miss: tokMiss,
				out: tokOut,
				total: tokHit + tokMiss + tokOut
			},
			peak: entry.peak === true,
			model: textOf(entry.model),
			...textOf(entry.asOf) === "" ? {} : { asOf: textOf(entry.asOf) },
			...isEst ? { est: true } : {}
		};
	}
	const hit = countOf(totalsCost.hit);
	const miss = countOf(totalsCost.miss);
	const out = countOf(totalsCost.out);
	const tokHit = countOf(totalsTok.hit);
	const tokMiss = countOf(totalsTok.miss);
	const tokOut = countOf(totalsTok.out);
	const ownTurnsRaw = recordOf(raw.ownTurns);
	const ownTurns = {};
	for (const key of Object.keys(ownTurnsRaw)) {
		const entry = recordOf(ownTurnsRaw[key]);
		const cost = recordOf(entry.cost);
		const tok = recordOf(entry.tok);
		const ownHit = countOf(cost.hit);
		const ownMiss = countOf(cost.miss);
		const ownOut = countOf(cost.out);
		const ownTokHit = countOf(tok.hit);
		const ownTokMiss = countOf(tok.miss);
		const ownTokOut = countOf(tok.out);
		const startedAt = optionalCountOf(entry.startedAt);
		ownTurns[key] = {
			cost: {
				hit: ownHit,
				miss: ownMiss,
				out: ownOut,
				total: ownHit + ownMiss + ownOut
			},
			tok: {
				hit: ownTokHit,
				miss: ownTokMiss,
				out: ownTokOut,
				total: ownTokHit + ownTokMiss + ownTokOut
			},
			...startedAt === null ? {} : { startedAt }
		};
	}
	const spawnsRaw = recordOf(raw.spawns);
	const spawns = {};
	for (const key of Object.keys(spawnsRaw)) {
		const entry = recordOf(spawnsRaw[key]);
		const label = textOf(entry.label);
		spawns[key] = {
			turn: countOf(entry.turn),
			at: countOf(entry.at),
			mode: entry.mode === "one-shot" ? "one-shot" : "continuable",
			...label === "" ? {} : { label }
		};
	}
	return {
		totals: {
			cost: {
				hit,
				miss,
				out,
				total: hit + miss + out
			},
			tok: {
				hit: tokHit,
				miss: tokMiss,
				out: tokOut,
				total: tokHit + tokMiss + tokOut
			}
		},
		turns,
		priceAsOf: textOf(raw.priceAsOf) === "" ? PRICE_AS_OF : textOf(raw.priceAsOf),
		placement: placementOf(raw.placement),
		...estimated || raw.est === true ? { est: true } : {},
		ownTurns,
		spawns,
		ownComplete: raw.ownComplete === true
	};
} };
function resolveOptions(options) {
	const providers = Array.isArray(options.pricedProviders) && options.pricedProviders.length > 0 ? options.pricedProviders.filter((entry) => typeof entry === "string" && entry.length > 0) : DEFAULT_PRICED_PROVIDERS;
	return {
		pricedProviders: providers.length > 0 ? providers : DEFAULT_PRICED_PROVIDERS,
		peakPricing: options.peakPricing !== false,
		placement: placementOf(options.placement)
	};
}
/**
* 创建 `turnCost` 投影单元定义。
* @param options - 插件配置（计价 provider、峰谷开关、pill 落位）。
* @returns 可直接注册到 `ctx.sessionProjections` 的单元定义。
*/
function createTurnCostProjection(options = {}) {
	const resolved = resolveOptions(options);
	return {
		key: TURN_COST_KEY,
		stateVersion: PROJECTION_STATE_VERSION,
		stateSchema,
		init: (_header, inheritedEventCount) => ({
			totals: zeroAccumulator(),
			turns: {},
			header: null,
			last: null,
			asOf: PRICE_AS_OF,
			placement: resolved.placement,
			inherited: typeof inheritedEventCount === "number" && Number.isSafeInteger(inheritedEventCount) && inheritedEventCount > 0 ? inheritedEventCount : 0,
			currentTurn: null,
			ownTurns: {},
			ownComplete: 1,
			ownLast: null,
			spawns: {}
		}),
		apply: (state, event) => {
			try {
				return fold(state, event, resolved);
			} catch {
				return state;
			}
		},
		wire: {
			viewSchema,
			view: (state) => {
				try {
					return project(state);
				} catch {
					return EMPTY_PROJECTION;
				}
			}
		}
	};
}
//#endregion
export { TURN_COST_KEY, createTurnCostProjection };
