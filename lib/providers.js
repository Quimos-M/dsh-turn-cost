//#region src/providers.ts
/**
* dsh-turn-cost —— **计价的 provider 白名单（唯一维护点）**。
*
* 设计口径：只对「DeepSeek 官方路由」计价，显式逐个列出 provider id ——
* 不用 `deepseek-` 前缀之类的模糊匹配，避免把第三方同名路由误算进官方价。
* DSH 新增 / 改名官方 provider 时，**只改这个文件**（`projection.ts` 从这里取默认值）。
*
* 已收录（按 DSH 版本）：
*   * `deepseek-official` —— DSH 0.1.5-rc.1 及更早的内建 DeepSeek 官方 provider
*     （官方源码 `packages/llm/llm-deepseek/src/index.ts` 的 `PROVIDER` 常量）。
*   * `deepseek-account` —— DSH 0.2.0-rc.2 起账号登录（桌面端）使用的官方 provider
*     （官方包 `@deepseek-ai/dsh-llm-deepseek-account` 的 `PROVIDER` 常量）。
*     自 0.2.0-rc.2 起桌面端会话日志里的 `request/header.config.provider` 与
*     `assistant/message.message.source.provider` 都是这个值；漏掉它会让所有金额
*     静默算成 0（见 DESIGN.md「已知边界」）。
*
* 非官方路由（例如经 DSH 官方 `llm-pi-ai` 适配器接入的第三方模型）默认**不计价**，
* 该轮不显示花费；可用插件配置 `pricedProviders` 放宽（含通配符 `*`）。
*
* @module dsh-turn-cost/providers
*/
/** 通配符：允许任何 provider 参与计价（配置里显式写 `['*']` 才生效）。 */
const ALL_PROVIDERS = "*";
/**
* 官方 DeepSeek provider id（显式列举；含历史 id，保证旧会话按当时的路由照常计价）。
*
* 维护须知：这里只增不减 —— 删掉某个 id 会让仍在日志里使用该 id 的历史会话
* 变成「不计价」，请配合 {@link PRICE_REVISION} 的语义一起考虑。
*/
const OFFICIAL_PROVIDER_IDS = ["deepseek-official", "deepseek-account"];
/**
* 判断某个 provider id 是否在官方白名单内。
* @param provider - 事件里记录的路由 provider id。
* @param priced - 生效的白名单（来自配置，缺省时由 `projection.ts` 填入
*   {@link OFFICIAL_PROVIDER_IDS}）。
* @returns 参与计价 → true。
*/
function isOfficialProvider(provider, priced) {
	if (provider === "") return true;
	return priced.includes("*") || priced.includes(provider);
}
//#endregion
export { ALL_PROVIDERS, OFFICIAL_PROVIDER_IDS, isOfficialProvider };
