/**
 * dsh-turn-cost —— host/client 共享的**纯类型**层（零运行时代码）。
 *
 * 这里同时声明两件事：
 *   1. `turnCost` 投影单元的状态形状（host 内部折叠状态）与 wire 形状
 *      （客户端唯一可见值，纯 JSON）；
 *   2. 把 `turnCost` 键合并进 `@deepseek-ai/dsh-session-projection/types` 的
 *      两张表 —— 客户端 `useProjection('turnCost')` 的静态类型就来自这里。
 *
 * 两端都以 `import type` 方式引用本文件，构建期整份擦除。
 *
 * @module dsh-turn-cost/types
 */

/** 金额一律用**微元 µ¥**（1 元 = 1e6 µ¥）整数存放与累加：无浮点漂移，显示时才换算。 */
export interface CostBucketsMicro {
  /** 缓存命中输入的金额（µ¥）。 */
  hit: number
  /** 缓存未命中输入的金额（µ¥）。 */
  miss: number
  /** 输出的金额（µ¥）。 */
  out: number
}

/** 三桶 token 数。 */
export interface TokenBuckets {
  hit: number
  miss: number
  out: number
}

/** 三桶金额 + 合计（µ¥）。 */
export interface CostBucketsTotal extends CostBucketsMicro {
  total: number
}

/** 三桶 token + 合计。 */
export interface TokenBucketsTotal extends TokenBuckets {
  total: number
}

/** 一轮（或整个会话）的花费与 token 汇总（wire 形状）。 */
export interface TurnCostEntry {
  /** 三桶金额 + 合计（µ¥）。 */
  cost: CostBucketsMicro & { total: number }
  /** 三桶 token + 合计。 */
  tok: TokenBuckets & { total: number }
  /** 该轮末次计价请求是否落在高峰时段。 */
  peak: boolean
  /** 该轮末次计价请求的路由模型 id。 */
  model: string
  /** 该轮套用的价格口径标签（与会话现行口径不同时才出现）。 */
  asOf?: string
  /** 该轮含未收录模型的估算（UI 标 ≈）。 */
  est?: boolean
}

/** 每轮 pill 相对原生「用量 / 耗时」pill 的落位方式。 */
export type TurnCostPlacement = 'before-usage' | 'between' | 'after-time' | 'inline'

/**
 * 「本会话自己产生的」一轮花费（不含 fork 继承前缀）。
 *
 * 与 {@link TurnCostEntry} 的区别：只统计 **本会话日志自己那一段**（`seq ≥ 继承前缀
 * 长度`）的请求，因此把本会话的每轮花费交给父会话聚合时不会把祖辈的账重复计一次；
 * 另外多一个轮次起点时刻，供父会话把子代理的某一轮落到自己的某一轮上。
 */
export interface TurnCostOwnTurn {
  /** 三桶金额 + 合计（µ¥）。 */
  cost: CostBucketsMicro & { total: number }
  /** 三桶 token + 合计。 */
  tok: TokenBuckets & { total: number }
  /** 该轮 `turn/start` 的时刻（Unix ms）；缺省表示这一轮没见到轮边界事件。 */
  startedAt?: number
}

/** 子代理会话被创建时，父会话正在进行的轮次。 */
export interface TurnCostSpawn {
  /** 父会话当时的轮号；`0` 表示当时没有可见的轮边界（无从归属）。 */
  turn: number
  /** `subagent/catalog` 事件的时刻（Unix ms）。 */
  at: number
  /** 子会话的生命周期形态（来自父会话日志的目录事实）。 */
  mode: 'one-shot' | 'continuable'
  /** 创建标签（模型给的 `description`），缺省表示未记录。 */
  label?: string
}

/** `turnCost` 投影的客户端可见值。 */
export interface TurnCostProjection {
  /** 会话累计。 */
  totals: {
    cost: CostBucketsMicro & { total: number }
    tok: TokenBuckets & { total: number }
  }
  /** 每轮明细，键为 turn 号的十进制字符串。 */
  turns: Record<string, TurnCostEntry>
  /** 本次折叠所用的价表口径标签（弹窗脚注）。 */
  priceAsOf: string
  /** 每轮 pill 的落位方式（host 配置 → 随投影下发，客户端零配置）。 */
  placement: TurnCostPlacement
  /** 会话内是否出现过估算。 */
  est?: boolean
  /**
   * **本会话自己**的每轮明细（不含 fork 继承前缀），键为 turn 号字符串。
   * 客户端做子代理聚合时用它，避免把继承来的祖辈开销重复计入。
   */
  ownTurns?: Record<string, TurnCostOwnTurn>
  /**
   * `ownTurns` / `spawns` 是否**覆盖了整段日志**。
   *
   * `false` 表示这个值是从"插件新增这两个字段之前写下的持久缓存行"恢复出来的：
   * 那两个字段只覆盖恢复点之后的事件。客户端遇到 `false` 时退回整段日志口径
   * （`turns`）并把归属标注为近似 —— 宁可显示一个明确标注的近似值，也不让这个
   * 子会话从父会话的总账里静默消失。
   */
  ownComplete?: boolean
  /**
   * 本会话**自己创建**的直接子会话锚点（来自本会话日志的 `subagent/catalog`），
   * 键为子会话 id。父会话据此把子会话的花费落到自己的轮次上。
   */
  spawns?: Record<string, TurnCostSpawn>
}

/** 折叠累加器（host 内部；投影缓存要求纯 JSON）。 */
export interface TurnCostAccumulator {
  costHit: number
  costMiss: number
  costOut: number
  tokHit: number
  tokMiss: number
  tokOut: number
}

/** 折叠状态里的一轮累加器。 */
export interface TurnCostStateTurn extends TurnCostAccumulator {
  /** 末次计价请求是否高峰（0/1，纯 JSON）。 */
  peak: 0 | 1
  /** 末次计价请求的模型 id。 */
  model: string
  /** 价格口径标签（与状态级口径不同时才写）。 */
  asOf?: string
  /** 出现过估算（0/1 省略式标记）。 */
  est?: 1
}

/** 折叠状态里「本会话自己」的一轮（不含继承前缀）。 */
export interface TurnCostStateOwnTurn extends TurnCostAccumulator {
  /** 该轮 `turn/start` 的时刻；缺省表示没见到轮边界事件。 */
  startedAt?: number
}

/** 折叠状态里的一条子会话锚点（来自本会话日志的 `subagent/catalog`）。 */
export interface TurnCostStateSpawn {
  /** 创建时正在进行的轮号；`0` = 未知。 */
  turn: number
  /** 事件时刻（Unix ms）。 */
  at: number
  /** 形态。 */
  mode: 'one-shot' | 'continuable'
  /** 创建标签。 */
  label?: string
}

/** `turnCost` 投影单元的折叠状态。 */
export interface TurnCostState {
  /** 会话累计（含继承前缀，与原生 `tokenUsage` 口径一致）。 */
  totals: TurnCostAccumulator
  /** 每轮累加器（含继承前缀）。 */
  turns: Record<string, TurnCostStateTurn>
  /** 最近一次 `request/header` 的路由（模型归因首选来源）。 */
  header: { provider: string; model: string } | null
  /** 同 (turn, step) 采样替换槽（与原生 tokenUsage 单元同构）。 */
  last: (TurnCostAccumulator & { turn: number; step: number }) | null
  /** 折叠时所用的价表口径标签。 */
  asOf: string
  /** 每轮 pill 落位方式（init 时由插件配置写入）。 */
  placement: TurnCostPlacement
  /** fork 继承前缀的事件数：`seq < inherited` 的事实属于祖辈，不算本会话自己的。 */
  inherited: number
  /** 当前轮号（由 `turn/start` 维护）；null = 尚未见到任何轮边界。 */
  currentTurn: number | null
  /** 本会话**自己**（`seq ≥ inherited`）的每轮花费与轮次起点。 */
  ownTurns: Record<string, TurnCostStateOwnTurn>
  /**
   * 自身口径是否覆盖整段日志（1 = 由 `init` 从 seq 0 折起；0 = 从旧持久缓存行
   * 恢复而来，新增字段只覆盖恢复点之后的事件）。
   *
   * 纯 JSON 的 0/1：持久行必须能无损往返。
   */
  ownComplete: 0 | 1
  /** 自身视角的同 (turn, step) 替换槽（与 `last` 各自独立，互不污染）。 */
  ownLast: (TurnCostAccumulator & { turn: number; step: number }) | null
  /** 本会话自己创建的直接子会话锚点，键为子会话 id。 */
  spawns: Record<string, TurnCostStateSpawn>
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** dsh-turn-cost：每轮 / 会话级 DeepSeek 官方定价花费。 */
    turnCost: TurnCostState
  }
  interface SessionProjectionMap {
    /** dsh-turn-cost：客户端可见的花费视图。 */
    turnCost: TurnCostProjection
  }
}
