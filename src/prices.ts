/**
 * DeepSeek 官方人民币价表（元 / 百万 tokens）与峰谷分时判定。
 *
 * 纯函数、零依赖、host 专用：`projection.ts` 每次计价都调 `resolvePrice`，
 * `tests/` 直接 import `lib/prices.js` 做边界单测。
 *
 * 口径来源（2026-09 核实）：
 *   * 2026-08-17 00:00 起启用峰谷分时：高峰 = 09:00–12:00、14:00–18:00（北京时间），
 *     其余为谷；峰价 = 谷价 × 2。
 *   * 2026-08-23 起：仅**周一至周五**上述两段为高峰，周末全天按谷价。
 *   * 2026-09-10 12:00 起 flash 系列降价：谷 0.02 / 1 / 4，峰 0.04 / 2 / 8。
 *   * `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`deepseek-v4.1-flash`
 *     目前均由服务端路由到 v4.1-flash，故统一按 v4.1-flash 价计费。
 *   * `deepseek-v4-pro` 暂按自身价计费（其 2026-09-14 12:00 下线后的改路由不在
 *     本版本范围内：届时只需在 PRO 家族补一条 `from` 规则）。
 */

/** 三桶单价（人民币元 / 百万 tokens）。 */
export interface Rates {
  hit: number
  miss: number
  out: number
}

/** 一段有效期内的价格。 */
interface TimedRates {
  /** 生效起点（含），epoch ms。 */
  from: number
  /** 失效终点（不含），epoch ms；缺省 = 至今有效。 */
  to?: number
  /** 空闲时段三桶单价。 */
  valley: Rates
  /** 高峰时段倍率。 */
  peakMultiplier: number
  /** 口径标签，写进 UI 脚注（如 "2026-09-10"）。 */
  label: string
}

/** 一个模型家族的时间版本化价格序列。 */
interface ModelFamily {
  /** 命名（诊断用）。 */
  readonly name: string
  /** 路由模型 id 匹配（前缀/正则）。 */
  readonly match: RegExp
  /** 按 `from` 升序的时间版本序列。 */
  readonly rates: readonly TimedRates[]
}

/** 一次计价解析的结果。 */
export interface ResolvedPrice extends Rates {
  /** 是否落在高峰时段。 */
  peak: boolean
  /** 模型未被价表收录（或时间早于该家族首条规则），按兜底档估算。 */
  estimated: boolean
  /** 实际套用的口径标签。 */
  asOf: string
  /** 命中的家族名（'default' 表示兜底）。 */
  family: string
}

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
export const PRICE_REVISION = 2

/** 当前价表口径标签（会话语义上的"现行价"）。 */
export const PRICE_AS_OF = '2026-09-10'

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/** 把带 +08:00 的 ISO 串解析成 epoch ms（可读性优先于手算时间戳）。 */
const T = (iso: string): number => Date.parse(iso)

/** 峰谷分时制度生效时刻（此前无峰谷，一律平价）。 */
export const PEAK_PRICING_FROM = T('2026-08-17T00:00:00+08:00')

/** 周末全天谷价生效时刻。 */
export const WEEKEND_VALLEY_FROM = T('2026-08-23T00:00:00+08:00')

/**
 * 判断某一时刻是否属于高峰时段（北京时间，无夏令时）。
 * @param epochMs - 请求时刻（epoch ms）。
 * @returns 高峰 → true；峰谷制度生效前恒为 false（那时是平价）。
 */
export function isPeakAt(epochMs: number): boolean {
  if (!Number.isFinite(epochMs) || epochMs < PEAK_PRICING_FROM) return false
  const shifted = new Date(epochMs + BEIJING_OFFSET_MS)
  const day = shifted.getUTCDay()
  if (epochMs >= WEEKEND_VALLEY_FROM && (day === 0 || day === 6)) return false
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
}

/** flash 家族（含 v4.1-flash 与视觉版；服务端当前把这三者都路由到 v4.1-flash）。 */
const FLASH: ModelFamily = {
  name: 'deepseek-v4-flash',
  match: /^deepseek-v4(?:\.1)?-flash/,
  rates: [
    {
      from: PEAK_PRICING_FROM,
      to: T('2026-09-10T12:00:00+08:00'),
      valley: { hit: 0.05, miss: 1.5, out: 4.5 },
      peakMultiplier: 2,
      label: '2026-08-17',
    },
    {
      from: T('2026-09-10T12:00:00+08:00'),
      valley: { hit: 0.02, miss: 1, out: 4 },
      peakMultiplier: 2,
      label: '2026-09-10',
    },
  ],
}

/** pro 家族（本版本仍按自身价；09-14 12:00 后的改路由留待下个版本）。 */
const PRO: ModelFamily = {
  name: 'deepseek-v4-pro',
  match: /^deepseek-v4(?:\.1)?-pro/,
  rates: [
    {
      from: 0,
      to: PEAK_PRICING_FROM,
      valley: { hit: 0.025, miss: 3, out: 6 },
      peakMultiplier: 1,
      label: '2026-08-12',
    },
    {
      from: PEAK_PRICING_FROM,
      valley: { hit: 0.15, miss: 4.5, out: 13.5 },
      peakMultiplier: 2,
      label: '2026-08-17',
    },
  ],
}

/** 历史模型名（deepseek-chat / deepseek-reasoner）：按 flash 家族归档。 */
const LEGACY: ModelFamily = {
  name: 'deepseek-legacy',
  match: /^deepseek-(?:chat|reasoner)$/,
  rates: FLASH.rates,
}

const FAMILIES: readonly ModelFamily[] = [FLASH, PRO, LEGACY]

/** 兜底档：未收录模型按现行 flash 价估算，并在 UI 标 ≈。 */
const DEFAULT_FAMILY: ModelFamily = {
  name: 'default',
  match: /$^/,
  rates: [FLASH.rates[FLASH.rates.length - 1] as TimedRates],
}

/** 选出生效中的那段价格；早于首条规则时用首条并标记估算。 */
function pickRates(family: ModelFamily, epochMs: number): { entry: TimedRates; estimated: boolean } {
  const rates = family.rates
  let chosen: TimedRates | undefined
  for (const entry of rates) {
    if (entry.from <= epochMs) chosen = entry
  }
  if (chosen === undefined) {
    return { entry: rates[0] as TimedRates, estimated: true }
  }
  return { entry: chosen, estimated: false }
}

/** 计价选项。 */
export interface PriceOptions {
  /** 关闭峰谷分时（一律按谷价）；缺省 = 开启。 */
  peakPricing?: boolean
}

/**
 * 解析某模型在某时刻的三桶单价（已按峰谷选定）。
 * @param model - 路由模型 id（如 `deepseek-v4-flash-vision-exp`）。
 * @param epochMs - 请求时刻（epoch ms）。
 * @param options - 计价选项（可关闭峰谷）。
 * @returns 单价与口径信息；任何输入都能得到结果（不抛错）。
 */
export function resolvePrice(model: string, epochMs: number, options: PriceOptions = {}): ResolvedPrice {
  const family = FAMILIES.find(candidate => candidate.match.test(model))
  const target = family ?? DEFAULT_FAMILY
  const at = Number.isFinite(epochMs) ? epochMs : Date.now()
  const { entry, estimated } = pickRates(target, at)
  const peak = options.peakPricing === false ? false : isPeakAt(at)
  const multiplier = peak ? entry.peakMultiplier : 1
  return {
    hit: entry.valley.hit * multiplier,
    miss: entry.valley.miss * multiplier,
    out: entry.valley.out * multiplier,
    peak,
    estimated: estimated || family === undefined,
    asOf: entry.label,
    family: target.name,
  }
}

/** 三桶 token 数。 */
export interface TokenBuckets {
  hit: number
  miss: number
  out: number
}

/** 三桶金额（微元 µ¥；1 元 = 1e6 µ¥）。 */
export interface CostBuckets {
  hit: number
  miss: number
  out: number
}

/**
 * 三桶计价：`tokens × 元/百万 = 微元`，因此整数四舍五入后全程无浮点漂移。
 * @param tokens - 三桶 token 数。
 * @param rates - 已按峰谷选定的三桶单价。
 * @returns 三桶微元金额。
 */
export function costOf(tokens: TokenBuckets, rates: Rates): CostBuckets {
  const round = (value: number): number => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0)
  return {
    hit: round(tokens.hit * rates.hit),
    miss: round(tokens.miss * rates.miss),
    out: round(tokens.out * rates.out),
  }
}
