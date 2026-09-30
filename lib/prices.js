//#region src/prices.ts
/**
* 价表 / 口径修订号：改了价格数据**或计价口径**就 +1
* （投影单元的 `stateVersion` 与它绑定，旧持久缓存行作废并重算）。
*
* 修订历史：
*   1 —— 首版（2026-08-17 峰谷制、08-23 周末谷价、09-10 flash 降价）。
*   2 —— 计价 provider 白名单改为显式列举并补入 `deepseek-account`
*        （DSH 0.2.0-rc.2 桌面端账号路由）。漏掉它会让金额静默算成 0，
*        而旧缓存行里已经写下了那些 0，因此必须借这次修订作废重算。
*/
const PRICE_REVISION = 2;
/** 当前价表口径标签（会话语义上的"现行价"）。 */
const PRICE_AS_OF = "2026-09-10";
const BEIJING_OFFSET_MS = 480 * 60 * 1e3;
/** 把带 +08:00 的 ISO 串解析成 epoch ms（可读性优先于手算时间戳）。 */
const T = (iso) => Date.parse(iso);
/** 峰谷分时制度生效时刻（此前无峰谷，一律平价）。 */
const PEAK_PRICING_FROM = T("2026-08-17T00:00:00+08:00");
/** 周末全天谷价生效时刻。 */
const WEEKEND_VALLEY_FROM = T("2026-08-23T00:00:00+08:00");
/**
* 判断某一时刻是否属于高峰时段（北京时间，无夏令时）。
* @param epochMs - 请求时刻（epoch ms）。
* @returns 高峰 → true；峰谷制度生效前恒为 false（那时是平价）。
*/
function isPeakAt(epochMs) {
	if (!Number.isFinite(epochMs) || epochMs < PEAK_PRICING_FROM) return false;
	const shifted = new Date(epochMs + BEIJING_OFFSET_MS);
	const day = shifted.getUTCDay();
	if (epochMs >= WEEKEND_VALLEY_FROM && (day === 0 || day === 6)) return false;
	const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
	return minutes >= 540 && minutes < 720 || minutes >= 840 && minutes < 1080;
}
/** flash 家族（含 v4.1-flash 与视觉版；服务端当前把这三者都路由到 v4.1-flash）。 */
const FLASH = {
	name: "deepseek-v4-flash",
	match: /^deepseek-v4(?:\.1)?-flash/,
	rates: [{
		from: PEAK_PRICING_FROM,
		to: T("2026-09-10T12:00:00+08:00"),
		valley: {
			hit: .05,
			miss: 1.5,
			out: 4.5
		},
		peakMultiplier: 2,
		label: "2026-08-17"
	}, {
		from: T("2026-09-10T12:00:00+08:00"),
		valley: {
			hit: .02,
			miss: 1,
			out: 4
		},
		peakMultiplier: 2,
		label: "2026-09-10"
	}]
};
const FAMILIES = [
	FLASH,
	{
		name: "deepseek-v4-pro",
		match: /^deepseek-v4(?:\.1)?-pro/,
		rates: [{
			from: 0,
			to: PEAK_PRICING_FROM,
			valley: {
				hit: .025,
				miss: 3,
				out: 6
			},
			peakMultiplier: 1,
			label: "2026-08-12"
		}, {
			from: PEAK_PRICING_FROM,
			valley: {
				hit: .15,
				miss: 4.5,
				out: 13.5
			},
			peakMultiplier: 2,
			label: "2026-08-17"
		}]
	},
	{
		name: "deepseek-legacy",
		match: /^deepseek-(?:chat|reasoner)$/,
		rates: FLASH.rates
	}
];
/** 兜底档：未收录模型按现行 flash 价估算，并在 UI 标 ≈。 */
const DEFAULT_FAMILY = {
	name: "default",
	match: /$^/,
	rates: [FLASH.rates[FLASH.rates.length - 1]]
};
/** 选出生效中的那段价格；早于首条规则时用首条并标记估算。 */
function pickRates(family, epochMs) {
	const rates = family.rates;
	let chosen;
	for (const entry of rates) if (entry.from <= epochMs) chosen = entry;
	if (chosen === void 0) return {
		entry: rates[0],
		estimated: true
	};
	return {
		entry: chosen,
		estimated: false
	};
}
/**
* 解析某模型在某时刻的三桶单价（已按峰谷选定）。
* @param model - 路由模型 id（如 `deepseek-v4-flash-vision-exp`）。
* @param epochMs - 请求时刻（epoch ms）。
* @param options - 计价选项（可关闭峰谷）。
* @returns 单价与口径信息；任何输入都能得到结果（不抛错）。
*/
function resolvePrice(model, epochMs, options = {}) {
	const family = FAMILIES.find((candidate) => candidate.match.test(model));
	const target = family ?? DEFAULT_FAMILY;
	const at = Number.isFinite(epochMs) ? epochMs : Date.now();
	const { entry, estimated } = pickRates(target, at);
	const peak = options.peakPricing === false ? false : isPeakAt(at);
	const multiplier = peak ? entry.peakMultiplier : 1;
	return {
		hit: entry.valley.hit * multiplier,
		miss: entry.valley.miss * multiplier,
		out: entry.valley.out * multiplier,
		peak,
		estimated: estimated || family === void 0,
		asOf: entry.label,
		family: target.name
	};
}
/**
* 三桶计价：`tokens × 元/百万 = 微元`，因此整数四舍五入后全程无浮点漂移。
* @param tokens - 三桶 token 数。
* @param rates - 已按峰谷选定的三桶单价。
* @returns 三桶微元金额。
*/
function costOf(tokens, rates) {
	const round = (value) => Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
	return {
		hit: round(tokens.hit * rates.hit),
		miss: round(tokens.miss * rates.miss),
		out: round(tokens.out * rates.out)
	};
}
//#endregion
export { PEAK_PRICING_FROM, PRICE_AS_OF, PRICE_REVISION, WEEKEND_VALLEY_FROM, costOf, isPeakAt, resolvePrice };
