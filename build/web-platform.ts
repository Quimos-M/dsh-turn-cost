/**
 * 浏览器平台模块表：DSH Web 壳在 `window.__ModuleLoader__` 里冻结共享的模块
 * 标识。client bundle 只能从这张表里 require 运行时值；表外的任何模块都必须
 * 内联进产物（见 ./tsdown.client.ts 的纯度门）。
 *
 * 取自 DSH 官方 `packages/client/web/src/platform.ts` 的 seed 表；本插件只用到其中 4 个
 * （react / react-dom / jsx-runtime / ui-primitives）。注意：这是官方表的**子集**，官方新增 seed
 * 条目时本表不会自动跟上（只影响「能否 require 新模块」，不影响既有功能）。
 * @module dsh-turn-cost/build/web-platform
 */

/** 平台共享的模块说明符（模块表 key）。 */
export const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

/** 一个平台模块说明符。 */
export type PlatformModule = (typeof PLATFORM_MODULES)[number]
