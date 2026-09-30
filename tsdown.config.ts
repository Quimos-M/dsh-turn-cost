/**
 * dsh-turn-cost 的 tsdown 配置。
 *
 * node 半输出四个入口：`lib/index.js`（插件本体，loader 装配用）以及
 * `lib/prices.js` / `lib/projection.js` / `lib/providers.js`（纯逻辑/纯数据，供
 * `tests/` 以 node:test 直接 import —— 它们不在 package.json 的 exports 里，外部无法引用）。
 * 浏览器半输出 `lib/client.js`（ModuleLoader 闭包工厂）；
 * `src/client/cost-format.ts` / `row-placement.ts` / `subagent-cost.ts` /
 * `rows.ts` / `dialog-pages.ts` / `locales.ts` 是纯函数/纯数据，同时产出独立 js 供
 * 测试直接 import（同样不在 exports 里）—— 分页单测因此可以直接断言"用到的文案键
 * 在 zh/en 里都存在"。
 */
import { clientBundle } from './build/tsdown.client.ts'

export default clientBundle('dsh-turn-cost', [
  'src/index.ts',
  'src/prices.ts',
  'src/providers.ts',
  'src/projection.ts',
  'src/client/cost-format.ts',
  'src/client/row-placement.ts',
  'src/client/subagent-cost.ts',
  'src/client/rows.ts',
  'src/client/dialog-pages.ts',
  'src/client/locales.ts',
])
