/**
 * dsh-turn-cost —— 文案字典（zh/en）。
 *
 * 字典键并入 `LocaleNamespaceMap`，因此注册时的 `locale: NS` 会让槽位组件拿到
 * 类型化的 `t` 座位。文案一律不含插值占位符（组合逻辑放在组件里），
 * 字典即纯静态字符串。
 *
 * @module dsh-turn-cost/client/locales
 */

/** 本插件的字典键。 */
export type TurnCostKey =
  | 'turn.title'
  | 'turn.consumed'
  | 'session.title'
  | 'session.consumed'
  | 'cost.spend'
  | 'cost.model'
  | 'cost.hitRate'
  | 'cost.cacheHitInput'
  | 'cost.cacheMissInput'
  | 'cost.output'
  | 'cost.total'
  | 'cost.ownTotal'
  | 'cost.ownTurnTotal'
  | 'cost.grandTotal'
  | 'cost.mainAgent'
  | 'cost.agentsLead'
  | 'cost.agentsTail'
  | 'cost.agentTurn'
  | 'cost.turnLead'
  | 'cost.turnTail'
  | 'cost.turnSep'
  | 'cost.turnMark'
  | 'cost.attributedExact'
  | 'cost.subagent'
  | 'cost.withSubagents'
  | 'cost.subagentNote'
  | 'cost.subagentAnchored'
  | 'cost.subagentUnattributed'
  | 'cost.priceNote'
  | 'cost.peak'
  | 'cost.valley'
  | 'cost.estimated'
  | 'cost.placeFallback'
  | 'cost.noData'
  | 'cost.prevPage'
  | 'cost.nextPage'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-turn-cost 的文案座位。 */
    'turn-cost': TurnCostKey
  }
}

/** 中文文案。 */
export const zh: Record<TurnCostKey, string> = {
  'turn.title': '本轮花费',
  'turn.consumed': '本轮花费',
  'session.title': '会话花费',
  'session.consumed': '会话花费',
  'cost.spend': '花费',
  'cost.model': '模型',
  'cost.hitRate': '缓存命中率',
  'cost.cacheHitInput': '缓存命中输入',
  'cost.cacheMissInput': '缓存未命中输入',
  'cost.output': '输出',
  'cost.total': '合计',
  'cost.ownTotal': '本会话自身',
  'cost.ownTurnTotal': '本轮自身',
  'cost.grandTotal': '合计（含子代理）',
  'cost.mainAgent': '主 Agent',
  'cost.agentsLead': '由',
  'cost.agentsTail': '个代理构成',
  'cost.agentTurn': '归属轮次',
  'cost.turnLead': '第 ',
  'cost.turnTail': ' 轮',
  'cost.turnSep': '、',
  'cost.turnMark': ' · ',
  'cost.attributedExact': '精确',
  'cost.subagent': '子代理',
  'cost.withSubagents': '含子代理',
  'cost.subagentNote': '子代理花费来自各子会话日志，按其轮次归属到本会话轮次',
  'cost.subagentAnchored': '按创建轮归属',
  'cost.subagentUnattributed': '未归属到轮次（只计入会话合计）',
  'cost.priceNote': 'DeepSeek 官方 API 价格',
  'cost.peak': '高峰时段 ×2',
  'cost.valley': '空闲时段',
  'cost.estimated': '含未收录模型，按同类价估算',
  'cost.placeFallback': '未定位',
  'cost.noData': '暂无花费数据',
  'cost.prevPage': '上一页',
  'cost.nextPage': '下一页',
}

/** English copy. */
export const en: Record<TurnCostKey, string> = {
  'turn.title': 'Turn cost',
  'turn.consumed': 'Turn cost',
  'session.title': 'Session cost',
  'session.consumed': 'Session cost',
  'cost.spend': 'Cost',
  'cost.model': 'Model',
  'cost.hitRate': 'Cache hit',
  'cost.cacheHitInput': 'Cached input',
  'cost.cacheMissInput': 'Uncached input',
  'cost.output': 'Output',
  'cost.total': 'Total',
  'cost.ownTotal': 'This session',
  'cost.ownTurnTotal': 'This turn',
  'cost.grandTotal': 'Total incl. subagents',
  'cost.mainAgent': 'Main agent',
  'cost.agentsLead': 'Composed of',
  'cost.agentsTail': 'agents',
  'cost.agentTurn': 'Attributed turn',
  'cost.turnLead': 'turn ',
  'cost.turnTail': '',
  'cost.turnSep': ', ',
  'cost.turnMark': ' · ',
  'cost.attributedExact': 'exact',
  'cost.subagent': 'Subagent',
  'cost.withSubagents': 'incl. subagents',
  'cost.subagentNote': 'Subagent cost is read from each child session log and attributed to this session\'s turns',
  'cost.subagentAnchored': 'anchored to creation turn',
  'cost.subagentUnattributed': 'not attributed to a turn (session total only)',
  'cost.priceNote': 'DeepSeek official API pricing',
  'cost.peak': 'peak hours ×2',
  'cost.valley': 'off-peak',
  'cost.estimated': 'includes an unpriced model, estimated at the closest tier',
  'cost.placeFallback': 'unplaced',
  'cost.noData': 'No cost data yet',
  'cost.prevPage': 'Previous page',
  'cost.nextPage': 'Next page',
}
