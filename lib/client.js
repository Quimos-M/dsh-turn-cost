window.__ModuleLoader__.load({
	id: "dsh-turn-cost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_dom = require("react-dom");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/guard.tsx
		/**
		* 渲染期错误隔离：把本插件的每个槽位组件包在一个错误边界里。
		*
		* 这是"插件有 bug 也不能拖垮 DSH"的最后一道闸：React 子树里未捕获的渲染异常会
		* 卸载整棵树，而错误边界能把爆炸范围限制在本插件自己的 pill 上（失败即不渲染，
		* 页面其余部分照常工作）。同时 `componentDidCatch` 只在本插件出问题时被调用。
		*
		* @module dsh-turn-cost/client/guard
		*/
		/** 只包住本插件 UI 的错误边界：出错 → 渲染 null，绝不冒泡给宿主。 */
		var CostBoundary = class extends react.Component {
			state = { failed: false };
			static getDerivedStateFromError() {
				return { failed: true };
			}
			componentDidCatch(error, info) {
				try {
					console.warn("[dsh-turn-cost] 花费 pill 渲染失败，已停用该 pill：", error, info.componentStack);
				} catch {}
			}
			render() {
				return this.state.failed ? null : this.props.children;
			}
		};
		//#endregion
		//#region src/client/anchored-dialog.ts
		/**
		* 一个"触发器锚定"的弹窗座位：开关状态、视口内钳制的落位、点外部/Escape 关闭。
		*
		* 与原生 `stat-dialog`（`packages/client/ui-chat/src/client/chat/stat-dialog.ts`）
		* 行为一致 —— 关键是复用同一个平台模块
		* `@deepseek-ai/dsh-client-ui-primitives` 导出的 `useAnchoredPosition` /
		* `useDismissOnOutsidePointer`，因此落位算法与原生逐像素相同，且不依赖任何
		* DSH 内部模块。
		*
		* @module dsh-turn-cost/client/anchored-dialog
		*/
		/** 与原生一致的视口留白（Menu portal margin）。 */
		const PANEL_MARGIN = 12;
		/** 与原生一致的触发器上沿到面板下沿的距离。 */
		const PANEL_GAP = 8;
		/** 未定位的 portal 面板：隐藏但仍参与布局，供钳制算法测量真实尺寸。 */
		const MEASURE_STYLE = {
			visibility: "hidden",
			left: 0,
			top: 0
		};
		/**
		* 创建触发器锚定的弹窗座位。
		* @returns 座位；把 `pos ?? MEASURE_STYLE` 铺到 portal 面板的 style 上。
		*/
		function useAnchoredDialog() {
			const [open, setOpen] = (0, react.useState)(false);
			const rootRef = (0, react.useRef)(null);
			const panelRef = (0, react.useRef)(null);
			const pos = (0, _deepseek_ai_dsh_client_ui_primitives.useAnchoredPosition)({
				open,
				anchorRef: rootRef,
				panelRef,
				side: "top",
				gap: PANEL_GAP,
				margin: PANEL_MARGIN
			});
			(0, _deepseek_ai_dsh_client_ui_primitives.useDismissOnOutsidePointer)(rootRef, open, setOpen, panelRef);
			(0, react.useEffect)(() => {
				if (!open) return;
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);
			return {
				open,
				setOpen,
				rootRef,
				panelRef,
				pos
			};
		}
		//#endregion
		//#region src/client/cost-format.ts
		/**
		* 金额与 token 的显示格式化。
		*
		* 金额在插件内部一律以**微元 µ¥**（整数）存放与累加，只在这里换算成显示串；
		* 不足 ¥0.0001 的金额显示为 `<0.0001`，避免用一长串 0 假装精确。
		*
		* **货币标注只出现一次**：数值后跟 ISO 代码 `CNY`（人民币），配合金币图标表达
		* "这是钱"。因此这里不再输出 `¥` 符号 —— 图标 + 符号重复标注对用户是噪音。
		*
		* @module dsh-turn-cost/client/cost-format
		*/
		/** 1 元 = 1e6 微元。 */
		const MICRO_PER_YUAN = 1e6;
		/** 低于该微元值（= 0.0001 元）时改用下限写法。 */
		const DISPLAY_FLOOR_MICRO = 100;
		/** 人民币 ISO 代码（唯一的货币标注）。 */
		const UNIT = "CNY";
		/**
		* 微元 → 金额显示串（数值 + 货币单位）。
		* @param micro - 金额（微元）。
		* @returns 例如 `0.0123 CNY`；零为 `0 CNY`；不足四位小数的正值为 `<0.0001 CNY`。
		*/
		function formatCost(micro) {
			if (!Number.isFinite(micro) || micro <= 0) return `0 ${UNIT}`;
			if (micro < DISPLAY_FLOOR_MICRO) return `<0.0001 ${UNIT}`;
			return `${(micro / MICRO_PER_YUAN).toFixed(4)} ${UNIT}`;
		}
		/**
		* token 数的精确显示（千分位）。
		* @param count - token 数。
		* @returns 例如 `12,345`。
		*/
		function formatTokens(count) {
			if (!Number.isFinite(count) || count <= 0) return "0";
			return Math.round(count).toLocaleString("en-US");
		}
		/**
		* 缓存命中率（命中 / 全部提示侧输入）。
		* @param hit - 缓存命中输入的 token 数。
		* @param miss - 缓存未命中输入的 token 数。
		* @returns 例如 `93.4%`；没有输入时返回 null。
		*/
		function formatHitRate(hit, miss) {
			const total = hit + miss;
			if (!Number.isFinite(total) || total <= 0) return null;
			return `${(hit / total * 100).toFixed(1)}%`;
		}
		/**
		* 「金额（tokens）」组合串，用于弹窗明细行。
		* @param micro - 金额（微元）。
		* @param tokens - 该桶 token 数。
		* @returns 例如 `0.0012 CNY（1,234 tokens）` / `<0.0001 CNY（12 tokens）`。
		*/
		function formatCostWithTokens(micro, tokens) {
			return `${formatCost(micro)}（${formatTokens(tokens)} tokens）`;
		}
		/**
		* provider id 列表的紧凑显示（超出 `max` 个时以 `…` 省略尾部）。
		*
		* 用于"未计价 provider"的标注：pill 位置窄，最多点名前两个；弹窗脚注可以多给一个。
		* @param providers - provider id 列表。
		* @param max - 最多显示几个（缺省 2）。
		* @returns 例如 `deepseek-account` / `a / b …`；空列表返回空串。
		*/
		function formatProviders(providers, max = 2) {
			const list = providers.filter((id) => id !== "");
			if (list.length === 0) return "";
			if (list.length <= max) return list.join(" / ");
			return `${list.slice(0, max).join(" / ")} …`;
		}
		//#endregion
		//#region src/client/rows.ts
		/** 模型行的多个模型之间的分隔符（与 pill 里的 ` · ` 同款）。 */
		const MODEL_SEP = " · ";
		/** 三桶金额相加（不改动入参）。 */
		function sumCost(left, right) {
			return {
				hit: left.hit + right.hit,
				miss: left.miss + right.miss,
				out: left.out + right.out,
				total: left.total + right.total
			};
		}
		/** 三桶 token 相加（不改动入参）。 */
		function sumTok(left, right) {
			return {
				hit: left.hit + right.hit,
				miss: left.miss + right.miss,
				out: left.out + right.out,
				total: left.total + right.total
			};
		}
		/**
		* 三桶明细行 + 合计行（原生 stat-dialog 的"缓存命中输入 / 缓存未命中输入 / 输出"
		* 口径）。
		* @param t - 文案座位。
		* @param cost - 三桶金额（µ¥）。
		* @param tok - 三桶 token。
		* @param totalLabel - 合计行的标签（合计 / 本会话自身 / 合计（含子代理））。
		* @returns 明细行。
		*/
		function bucketRows(t, cost, tok, totalLabel) {
			return [
				{
					label: t("cost.cacheHitInput"),
					value: formatCostWithTokens(cost.hit, tok.hit)
				},
				{
					label: t("cost.cacheMissInput"),
					value: formatCostWithTokens(cost.miss, tok.miss)
				},
				{
					label: t("cost.output"),
					value: formatCostWithTokens(cost.out, tok.out)
				},
				{
					label: totalLabel,
					value: formatCost(cost.total)
				}
			];
		}
		/**
		* 单个代理的明细行（模型 → 缓存命中率 → 三桶 → 合计）。
		* @param t - 文案座位。
		* @param ledger - 该代理的账。
		* @param totalLabel - 合计行标签。
		* @param options - 见 {@link AgentRowOptions}。
		* @returns 明细行。
		*/
		function agentRows(t, ledger, totalLabel, options = {}) {
			const models = ledger.models.filter((model) => model !== "");
			const rate = formatHitRate(ledger.tok.hit, ledger.tok.miss);
			return [
				...options.withModel !== false && models.length > 0 ? [{
					label: t("cost.model"),
					value: models.join(MODEL_SEP),
					wrap: true
				}] : [],
				...options.withHitRate === false || rate === null ? [] : [{
					label: t("cost.hitRate"),
					value: rate
				}],
				...bucketRows(t, ledger.cost, ledger.tok, totalLabel)
			];
		}
		/**
		* 第 1 页（总计）的明细行：合计口径的三桶 + 构成摘要。
		* @param t - 文案座位。
		* @param input - 见 {@link OverviewInput}。
		* @returns 明细行。
		*/
		function overviewRows(t, input) {
			const buckets = sumCost(input.own.cost, input.sub.costBuckets);
			const tok = sumTok(input.own.tok, input.sub.tokBuckets);
			const cost = {
				...buckets,
				total: input.own.cost.total + input.sub.cost
			};
			const rate = formatHitRate(tok.hit, tok.miss);
			return [
				...rate === null ? [] : [{
					label: t("cost.hitRate"),
					value: rate
				}],
				...bucketRows(t, cost, tok, t("cost.grandTotal")),
				{
					label: `${t("cost.agentsLead")} ${String(Math.max(0, input.subagentCount) + 1)} ${t("cost.agentsTail")}`,
					value: `${t("cost.mainAgent")} ${formatCost(input.own.cost.total)} + ${t("cost.subagent")} ${formatCost(input.sub.cost)}`,
					wrap: true
				}
			];
		}
		/**
		* 归属文案：这个子代理的花费落到了本会话的哪一轮（沿用聚合的标注口径）。
		* @param t - 文案座位。
		* @param row - 子代理行。
		* @returns 例如 `第 12 轮、第 13 轮 · 精确` / `第 13 轮 · 按创建轮归属` / 未归属说明。
		*/
		function attributionText(t, row) {
			if (row.turns.length === 0) return t("cost.subagentUnattributed");
			const turns = row.turns.map((turn) => `${t("cost.turnLead")}${String(turn)}${t("cost.turnTail")}`).join(t("cost.turnSep"));
			const mark = row.exact ? t("cost.attributedExact") : t("cost.subagentAnchored");
			return `${turns}${t("cost.turnMark")}${mark}`;
		}
		/**
		* 一个子代理一页的明细行：名称（含层级缩进）→ 模型 / 三桶 / 合计 → 归属。
		*
		* 这一页不显示缓存命中率：用户要的是"哪个代理花了多少、算在哪一轮"，行数与第 1 / 2 页
		* 对齐（最长 7 行）后翻页时面板高度不抖（见 `dialog.module.css` 的 `.detailsPaged`）。
		* @param t - 文案座位。
		* @param row - 子代理行（来自会话级 rollup 或某一轮切片）。
		* @param detail - 该子代理的展开细目（三桶 / 模型）；读不到时退回行上的合计。
		* @returns 明细行。
		*/
		function subagentPageRows(t, row, detail) {
			const indent = "· ".repeat(Math.max(0, row.depth - 1));
			const ledger = {
				cost: detail?.cost ?? {
					hit: 0,
					miss: 0,
					out: 0,
					total: row.cost
				},
				tok: detail?.tok ?? {
					hit: 0,
					miss: 0,
					out: 0,
					total: row.tokens
				},
				models: detail?.models ?? []
			};
			return [
				{
					label: t("cost.subagent"),
					value: `${indent}${row.label}`,
					wrap: true
				},
				...agentRows(t, ledger, t("cost.total"), {
					withModel: true,
					withHitRate: false
				}),
				{
					label: t("cost.agentTurn"),
					value: attributionText(t, row),
					wrap: true
				}
			];
		}
		/**
		* 价格口径脚注：说明这些数字是按哪一版官方价、按峰还是按谷算出来的。
		* @param t - 文案座位。
		* @param peak - 末次计价请求是否高峰；null 表示无从判断（不写峰谷）。
		* @param priceAsOf - 口径标签（价表版本）。
		* @param estimated - 是否含未收录模型的估算。
		* @param notes - 追加说明（例如"含子代理"的口径说明）。
		* @returns 脚注文本。
		*/
		function footnote(t, peak, priceAsOf, estimated, notes = []) {
			const parts = [t("cost.priceNote")];
			if (peak !== null) parts.push(peak ? t("cost.peak") : t("cost.valley"));
			parts.push(priceAsOf);
			if (estimated) parts.push(t("cost.estimated"));
			parts.push(...notes);
			return parts.join(" · ");
		}
		/**
		* 「未计价 provider」的脚注说明（两个 pill 共用；脚注每一页都渲染）。
		*
		* 这是**可见降级**的文案落点：金额里不包含这些 provider 的请求，必须说出来，
		* 否则用户只会看到一个偏小（甚至为 0）的数字而无从判断。
		* @param t - 文案座位。
		* @param providers - 未计价的 provider id 列表（会话级用 wire 的 `providers`，
		*   每轮 pill 用 `byTurn[turn]`）；空列表不追加任何说明。
		* @param maxIds - 最多点名几个 provider（缺省 3）。
		* @returns 追加到脚注的说明（0 或 1 条）。
		*/
		function unpricedNotes(t, providers, maxIds = 3) {
			const ids = formatProviders(providers, maxIds);
			if (ids === "") return [];
			return [`${t("cost.unpricedNote")} ${ids}`];
		}
		//#endregion
		//#region src/client/dialog-pages.ts
		/** 无子代理时的页数（单页：总计即自身）。 */
		const SINGLE_PAGE = 1;
		/** 把外部输入清洗成"页数意义上的个数"（非负整数；脏输入 → 0）。 */
		function countOf$1(value) {
			return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
		}
		/** 把外部输入清洗成"合法页数"（至少 1 页）。 */
		function totalPages(count) {
			const total = countOf$1(count);
			return total > SINGLE_PAGE ? total : SINGLE_PAGE;
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
		//#region \0dsh-css:/mnt/e/DSH-plugin/dsh-turn-cost/src/client/dialog.module.css.mjs
		const css$1 = ".HeC5BW_panel{z-index:1100;box-sizing:border-box;background:var(--dsw-specific-menu);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;border-radius:12px;padding:16px;font-size:12px;line-height:18px;position:fixed}.HeC5BW_title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}.HeC5BW_titleRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}.HeC5BW_titleValue{font-variant-numeric:tabular-nums}.HeC5BW_titleLabel{align-items:center;gap:6px;min-width:0;display:inline-flex}.HeC5BW_titleLabel svg{flex:none;width:15px;height:15px}.HeC5BW_details{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}.HeC5BW_details dt,.HeC5BW_details dd{min-width:0;margin:0}.HeC5BW_details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}.HeC5BW_details .HeC5BW_route{overflow-wrap:anywhere}.HeC5BW_detailsPaged{min-height:162px}.HeC5BW_pager{color:var(--dsw-alias-label-tertiary);justify-content:center;align-items:center;gap:6px;margin-top:8px;display:flex}.HeC5BW_pageButton{box-sizing:border-box;width:20px;height:20px;color:inherit;font:inherit;cursor:pointer;background:0 0;border:0;border-radius:6px;justify-content:center;align-items:center;padding:0;font-size:14px;line-height:1;display:inline-flex}.HeC5BW_pageButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.HeC5BW_pageButton:disabled{opacity:.35;cursor:default}.HeC5BW_pageIndicator{text-align:center;font-variant-numeric:tabular-nums;min-width:30px}.HeC5BW_footnote{border-top:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);margin-top:10px;padding-top:8px;font-size:11px;line-height:16px}";
		const tagId$1 = "dsh-turn-cost/dialog.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-turn-cost";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var dialog_module_css_default = {
			"details": "HeC5BW_details",
			"detailsPaged": "HeC5BW_detailsPaged",
			"footnote": "HeC5BW_footnote",
			"pageButton": "HeC5BW_pageButton",
			"pageIndicator": "HeC5BW_pageIndicator",
			"pager": "HeC5BW_pager",
			"panel": "HeC5BW_panel",
			"route": "HeC5BW_route",
			"title": "HeC5BW_title",
			"titleLabel": "HeC5BW_titleLabel",
			"titleRule": "HeC5BW_titleRule",
			"titleValue": "HeC5BW_titleValue"
		};
		//#endregion
		//#region src/client/CostDialog.tsx
		/**
		* 花费明细弹窗：与原生 stat-dialog 同一套皮肤与排布（标题行 + 分隔线 +
		* dt/dd 两列明细 + 脚注），子代理存在时**分页**显示（总计 / 主 Agent / 每个子代理一页）。
		*
		* 本组件是**纯展示**：所有数字都已由调用方算好格式化成字符串（页由
		* `./dialog-pages.ts` 装配），因此它内部没有任何可能抛错的逻辑（渲染期异常是唯一
		* 会波及宿主 UI 的路径）；翻页只是"选中哪一页"，任何非法页码都被 `clampPage` 夹住。
		*
		* 翻页交互：`‹ 2/4 ›` 极简控件 + 左右方向键（两端夹住）+ 回车（循环）+ Esc 关闭
		* （Esc 由 `./anchored-dialog.ts` 的座位负责）。**单页时不渲染任何翻页控件**，弹窗
		* 与分页改造前完全一致 —— 没有子代理的常见情形不该多出噪音。
		*
		* @module dsh-turn-cost/client/CostDialog
		*/
		/** 页数据缺失时的兜底（宁可为空，也不让渲染期抛错）。 */
		const EMPTY_PAGE = {
			total: "",
			rows: []
		};
		/** 翻页控件容器标记：键盘处理据此让位给按钮自身的激活行为。 */
		const PAGER_ATTR = "data-turn-cost-pager";
		/** 事件目标是否在翻页控件内（不在 DOM 环境 / 无法判断时一律当作"不在"）。 */
		function isPagerTarget(target) {
			try {
				return typeof Element !== "undefined" && target instanceof Element && target.closest(`[${PAGER_ATTR}]`) !== null;
			} catch {
				return false;
			}
		}
		/**
		* 渲染花费明细弹窗（portal 到 body，层级与原生 stat-dialog 同级）。
		* @param props - 见 {@link CostDialogProps}。
		* @returns 面板元素。
		*/
		function CostDialog({ panelRef, pos, icon, title, pages, footnote, pager }) {
			const count = pages.length > 0 ? pages.length : 1;
			const paged = count > 1;
			const [wanted, setWanted] = (0, react.useState)(0);
			const current = clampPage(wanted, count);
			const page = pages[current] ?? pages[0] ?? EMPTY_PAGE;
			(0, react.useEffect)(() => {
				if (!paged) return;
				const onKeyDown = (event) => {
					try {
						if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
						if (isPagerTarget(event.target)) return;
						if (event.key === "ArrowLeft") setWanted(stepPage(current, -1, count));
						else if (event.key === "ArrowRight") setWanted(stepPage(current, 1, count));
						else if (event.key === "Enter") setWanted(cyclePage(current, 1, count));
						else return;
						event.preventDefault();
					} catch {}
				};
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [
				paged,
				current,
				count
			]);
			return (0, react_dom.createPortal)(/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: panelRef,
				className: dialog_module_css_default.panel,
				role: "dialog",
				"aria-label": paged ? `${title} ${pageIndicator(current, count)}` : title,
				style: pos ?? MEASURE_STYLE,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: dialog_module_css_default.title,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: dialog_module_css_default.titleLabel,
							children: [icon, title]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: dialog_module_css_default.titleValue,
							children: page.total
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: dialog_module_css_default.titleRule,
						"aria-hidden": true
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dl", {
						className: `${dialog_module_css_default.details}${paged ? ` ${dialog_module_css_default.detailsPaged}` : ""}`,
						"data-turn-cost-details": true,
						children: page.rows.map((row, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: row.label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", {
							className: row.wrap === true ? dialog_module_css_default.route : void 0,
							children: row.value
						})] }, `${String(current)}:${String(index)}:${row.label}`))
					}),
					paged && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: dialog_module_css_default.pager,
						[PAGER_ATTR]: "",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: dialog_module_css_default.pageButton,
								"aria-label": pager.prev,
								disabled: current === 0,
								onClick: () => {
									setWanted(stepPage(current, -1, count));
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									"aria-hidden": true,
									children: "‹"
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: dialog_module_css_default.pageIndicator,
								children: pageIndicator(current, count)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: dialog_module_css_default.pageButton,
								"aria-label": pager.next,
								disabled: current === count - 1,
								onClick: () => {
									setWanted(stepPage(current, 1, count));
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									"aria-hidden": true,
									children: "›"
								})
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: dialog_module_css_default.footnote,
						children: footnote
					})
				]
			}), document.body);
		}
		//#endregion
		//#region src/client/icons.tsx
		/** ¥ 金币轮廓图标。 */
		function IconCoinOutline16() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: "16",
				height: "16",
				viewBox: "0 0 16 16",
				fill: "none",
				xmlns: "http://www.w3.org/2000/svg",
				"aria-hidden": "true",
				focusable: "false",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "8",
					cy: "8",
					r: "6.4",
					stroke: "currentColor",
					strokeWidth: "1.2"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M5.5 4.4 8 7.6l2.5-3.2M8 7.6v4.5M5.4 9.2h5.2M5.4 11.3h5.2",
					stroke: "currentColor",
					strokeWidth: "1.15",
					strokeLinecap: "round",
					strokeLinejoin: "round"
				})]
			});
		}
		//#endregion
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
		//#region \0dsh-css:/mnt/e/DSH-plugin/dsh-turn-cost/src/client/pill.module.css.mjs
		const css = ".JdnO_a_anchor{min-width:0;display:inline-flex}.JdnO_a_trigger{box-sizing:border-box;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer;background:0 0;border:none;align-items:center;display:inline-flex}.JdnO_a_trigger:hover,.JdnO_a_trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.JdnO_a_label{text-overflow:ellipsis;min-width:0;overflow:hidden}.JdnO_a_row{height:calc(28px + var(--dsh-content-font-delta,0px));font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));border-radius:28px;gap:4px;padding:6px 8px}.JdnO_a_row svg{width:calc(17px + var(--dsh-content-font-delta,0px));height:calc(17px + var(--dsh-content-font-delta,0px));flex:none}.JdnO_a_dock{font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));border-radius:24px;gap:6px;padding:1px 8px}.JdnO_a_dock svg{flex:none;width:16px;height:16px}@media (width<=480px){.JdnO_a_row{width:calc(28px + var(--dsh-content-font-delta,0px));justify-content:center;padding:6px}.JdnO_a_row .JdnO_a_label{display:none}}";
		const tagId = "dsh-turn-cost/pill.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-turn-cost";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var pill_module_css_default = {
			"anchor": "JdnO_a_anchor",
			"dock": "JdnO_a_dock",
			"label": "JdnO_a_label",
			"row": "JdnO_a_row",
			"trigger": "JdnO_a_trigger"
		};
		//#endregion
		//#region src/client/SessionCostPill.tsx
		/**
		* 会话累计花费 pill：挂在 `conversation.composer.dock`（list 槽位、全新 id、
		* order 1），因此它**追加**在原生统计 pill 之后，不覆盖任何东西。
		*
		* 关键点：dock 是一个**纵向堆叠的 list 槽位**，直接渲染会让本 pill 掉到原生
		* 「耗时 · 用量」那一行的**下面一行**。所以这里用 React **portal** 把 pill 送进
		* 原生统计行（`[data-composer-stats]`），于是三者在同一行里居中排布：
		*
		*     耗时 · 用量 · 花费
		*
		* 用 portal 而不是手工 `appendChild`：portal 让 React 继续管理这个节点的挂载与
		* 卸载（跨父节点搬迁时手搬节点会让 React 的 removeChild 抛 NotFoundError）。
		* 探测不到原生统计行时退回原位渲染（多占一行，但功能完整）。
		*
		* @module dsh-turn-cost/client/SessionCostPill
		*/
		/**
		* `useSessions` 缺席时的替身（老宿主 / 纯本体环境）。
		*
		* 为什么用"换一个函数"而不是条件调用 hook：hook 的调用与否必须在每次渲染里一致，
		* 条件调用本身就是违规；而这里替身与原 hook 的调用位置完全相同，只是永远返回
		* `undefined` —— 于是"读不到别的会话"只表现为子代理不显示，绝不是报错。
		*/
		const NO_LIST$1 = (() => void 0);
		/** 未测量完成时的隐形探针：只为拿到 DOM 位置，不显示、不占位。 */
		const PROBE_STYLE$1 = { display: "none" };
		/** 向上寻找的层数上限（原生统计行就在本条目容器附近，越界即视为结构不可用）。 */
		const MAX_ANCESTOR_DEPTH = 8;
		/**
		* 定位本会话的原生统计行（`[data-composer-stats]`）。
		*
		* 从本节点向上逐层找**最近的**、包含该行的祖先：最近匹配保证只会命中本会话自己
		* 的输入区（别的会话的输入区是兄弟节点，不是祖先）。
		* @param node - 本插件的节点。
		* @returns 原生统计行元素；找不到返回 null。
		*/
		function findStatsRow(node) {
			let ancestor = node.parentElement;
			for (let depth = 0; ancestor !== null && depth < MAX_ANCESTOR_DEPTH; depth += 1) {
				const row = ancestor.querySelector("[data-composer-stats]");
				if (row !== null) return row;
				ancestor = ancestor.parentElement;
			}
			return null;
		}
		/** 取最近一轮的峰谷上下文（用于脚注）。 */
		function latestTurn(value) {
			let best = null;
			for (const key of Object.keys(value.turns)) {
				const turn = Number(key);
				if (!Number.isFinite(turn)) continue;
				if (best === null || turn > best) best = turn;
			}
			if (best === null) return null;
			const entry = value.turns[String(best)];
			if (entry === void 0) return null;
			return {
				peak: entry.peak,
				asOf: entry.asOf ?? value.priceAsOf,
				est: entry.est === true
			};
		}
		/**
		* 会话累计花费 pill 与明细弹窗。
		*
		* 金额 = **本会话自身**（纯折叠的自有日志）+ **全部后代子会话的自有花费**。后者
		* 只能由客户端聚合：父会话日志里没有子会话的用量（详见 `./subagent-cost.ts` 的
		* 模块注释与 DESIGN.md §11）。读不到会话列表时子代理部分自动缺席，弹窗回到原样。
		*
		* @param props - 见 {@link SessionCostPillProps}。
		* @returns pill 元素；没有花费数据时不渲染任何东西。
		*/
		function SessionCostPill({ useProjection, useSessions, sessionId, t }) {
			const value = useProjection("turnCost");
			const seat = useAnchoredDialog();
			const [host, setHost] = (0, react.useState)(void 0);
			const sessions = (typeof useSessions === "function" ? useSessions : NO_LIST$1)((state) => state.byId);
			const rows = (0, react.useMemo)(() => sessions === void 0 ? void 0 : Object.values(sessions), [sessions]);
			const rollup = (0, react.useMemo)(() => rows === void 0 || sessionId === void 0 ? NO_SUBAGENTS : rollupSubagentCost(sessionId, rows, value), [
				rows,
				sessionId,
				value
			]);
			(0, react.useLayoutEffect)(() => {
				if (host !== void 0) {
					if (host !== null && !host.isConnected) setHost(void 0);
					return;
				}
				const node = seat.rootRef.current;
				if (node === null) return;
				setHost(findStatsRow(node));
			});
			const grand = (value === void 0 ? 0 : value.totals.cost.total) + rollup.cost;
			const unpriced = value?.unpriced;
			const unpricedIds = unpriced === void 0 ? "" : formatProviders(unpriced.providers);
			const hasAmount = grand > 0;
			if (value === void 0 || !hasAmount && unpricedIds === "") return null;
			const latest = latestTurn(value);
			const marker = rollup.count === 0 ? "" : ` · ${t("cost.withSubagents")} ${String(rollup.count)}`;
			const amount = hasAmount ? `${formatCost(grand)}${marker}${unpricedIds === "" ? "" : ` · ${t("cost.unpricedMarker")} ${unpricedIds}`}` : `${t("cost.unpricedAmount")}（${unpricedIds}）`;
			const pages = agentPages(t, {
				own: {
					cost: value.totals.cost,
					tok: value.totals.tok,
					models: modelsOfView(value)
				},
				ownTotalLabel: "cost.ownTotal",
				ownModelOnSinglePage: false,
				subagents: rollup
			});
			const pill = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				ref: seat.rootRef,
				className: pill_module_css_default.anchor,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: `${pill_module_css_default.trigger} ${pill_module_css_default.dock}`,
					"aria-haspopup": "dialog",
					"aria-expanded": seat.open,
					"aria-label": `${t("session.consumed")} ${amount}`,
					onClick: () => {
						seat.setOpen(!seat.open);
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconCoinOutline16, {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: pill_module_css_default.label,
						children: `${t("cost.spend")} ${amount}`
					})]
				}), seat.open && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CostDialog, {
					panelRef: seat.panelRef,
					pos: seat.pos,
					icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconCoinOutline16, {}),
					title: t("session.title"),
					pages,
					footnote: footnote(t, latest?.peak ?? null, latest?.asOf ?? value.priceAsOf, value.est === true, [...rollup.rows.length === 0 ? [] : [t("cost.subagentNote")], ...unpricedNotes(t, unpriced?.providers ?? [])]),
					pager: {
						prev: t("cost.prevPage"),
						next: t("cost.nextPage")
					}
				})]
			});
			if (host === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				ref: seat.rootRef,
				className: pill_module_css_default.anchor,
				style: PROBE_STYLE$1
			});
			if (host === null) return pill;
			return (0, react_dom.createPortal)(pill, host);
		}
		//#endregion
		//#region src/client/row-placement.ts
		/** 本插件根节点的标记属性：用于把自己从"原生 pill"里排除掉。 */
		const OWN_ATTRIBUTE = "data-dsh-turn-cost";
		/**
		* 原生 provider 弹窗 pill 的识别方式（两条独立线索，任一命中即算）：
		*   * `aria-haspopup="dialog"` —— 用量 / 耗时 pill 的显式声明；
		*   * `aria-expanded` —— 同一批 pill 折叠/展开状态，作为 tolerant 兜底
		*     （万一某个版本的 pill 少写了 haspopup，落位仍然成立）。
		* 插件自己的按钮两条都可能命中，由 `[data-dsh-turn-cost]` 过滤掉。
		*/
		const DIALOG_BUTTON_SELECTORS = ["button[aria-haspopup=\"dialog\"]", "button[aria-expanded]"];
		/**
		* 动作行内的原生 provider 弹窗 pill（用量、耗时），按 DOM 顺序。
		* @param row - 动作行元素。
		* @returns 原生 pill 的 button 元素数组（可能为空）。
		*/
		function nativePills(row) {
			return Array.from(row.querySelectorAll(DIALOG_BUTTON_SELECTORS.join(","))).filter((button) => button.closest(`[${OWN_ATTRIBUTE}]`) === null);
		}
		/**
		* 把一个后代元素收敛成动作行的**直接子节点**。
		* @param element - 行内某个后代元素。
		* @param row - 动作行元素。
		* @returns 行内的直接子节点；element 不在行内时返回 null。
		*/
		function rowCellOf(element, row) {
			let node = element;
			while (node !== null && node.parentElement !== row) node = node.parentElement;
			return node;
		}
		/**
		* 定位本插件所在的**轮次动作行**。
		*
		* 为什么不能直接用 `root.parentElement`：槽位渲染会给条目套包裹元素，
		* 于是父节点只是一个只含自己的包裹层，在其中查不到原生 pill —— 落位就会静默失效
		* （第一、二轮实测的症状：pill 一直留在槽位原位＝分支之前）。这里改为**向上寻找
		* 最近的、内部含原生弹窗 pill 的祖先**，即真正的动作行。
		*
		* 上界是 `[data-turn-tail]`（原生轮次尾容器）：到边界还没找到就返回 null，绝不
		* 越界去认领别的轮次的动作行。
		* @param node - 本插件节点（探针或已落位的 pill）。
		* @param maxDepth - 向上寻找的最大层数。
		* @returns 动作行元素；找不到返回 null。
		*/
		function findActionRow(node, maxDepth = 6) {
			let container = node.parentElement;
			for (let depth = 0; container !== null && depth < maxDepth; depth += 1) {
				if (nativePills(container).length > 0) return container;
				if (container.hasAttribute("data-turn-tail")) return null;
				container = container.parentElement;
			}
			return null;
		}
		/**
		* 把本插件根节点移动到目标位置（已就位则不动，避免无谓的 DOM 变更）。
		*
		* 只在**同一父节点内**重新排序，因此 React 的增删仍然安全。
		* @param root - 本插件根节点。
		* @param placement - 目标落位方式。
		* @param row - 目标动作行；缺省用 root 的父节点。
		*/
		function reposition(root, placement, row) {
			if (placement === "inline") return;
			const container = row ?? root.parentElement;
			if (container === null || container === void 0) return;
			const pills = nativePills(container);
			if (pills.length === 0) return;
			const timeButton = pills[pills.length - 1];
			const usageButton = pills[pills.length - 2] ?? timeButton;
			if (timeButton === void 0 || usageButton === void 0) return;
			const timeCell = rowCellOf(timeButton, container);
			const usageCell = rowCellOf(usageButton, container);
			if (timeCell === null || usageCell === null) return;
			if (placement === "after-time") {
				if (root.previousElementSibling === timeCell) return;
				timeCell.after(root);
				return;
			}
			const anchor = placement === "between" && pills.length >= 2 ? timeCell : usageCell;
			if (root.nextElementSibling === anchor) return;
			container.insertBefore(root, anchor);
		}
		//#endregion
		//#region src/client/TurnCostAction.tsx
		/**
		* 每轮花费 pill：注册在 `conversation.chat.assistant-actions`（list 槽位、全新
		* id、order 50），React 会把它挂进该轮的动作行。
		*
		* 落位为什么这么绕（两轮实测教训）：
		*   1. 槽位渲染会给条目套**包裹元素**，所以 `root.parentElement` 不是动作行 ——
		*      在包裹层里查原生 pill 永远是空，落位静默失效（表现为 pill 一直留在槽位
		*      原位＝分支之前）。修法：向上寻找"内部含原生弹窗 pill 的最近祖先"。
		*   2. 跨父节点手工搬节点会让 React 卸载时的 `removeChild` 抛 NotFoundError。
		*      修法：用 **React portal** 把 pill 送进动作行（React 自己管理挂载/卸载），
		*      再用 `insertBefore` 在**同一个容器内**重排到目标位置。
		*   3. 原生「用量 / 耗时」pill 可能比本条目晚一个提交出现。修法：加一个只观察本
		*      轮 `[data-turn-tail]` 子树的 MutationObserver，pill 一到就补一次落位。
		*
		* 任何一步失败都只是"位置退化"：pill 仍在槽位原位可见、功能完整。
		*
		* @module dsh-turn-cost/client/TurnCostAction
		*/
		/** 未测量完成时的隐形探针：只为拿到 DOM 位置，不显示、不占位。 */
		const PROBE_STYLE = { display: "none" };
		/** `useSessions` 缺席时的替身（见 SessionCostPill 的同名说明）。 */
		const NO_LIST = (() => void 0);
		/** 本轮自己没有请求、只有子代理花费时的占位条目（全零、无模型）。 */
		const EMPTY_ENTRY = {
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
			},
			peak: false,
			model: ""
		};
		/**
		* 每轮花费 pill 与明细弹窗。
		*
		* 金额 = 本会话这一轮自己的花费（纯折叠）+ **归属到这一轮的后代子会话花费**
		* （客户端聚合：父会话日志里没有子会话的用量）。归属规则见
		* `./subagent-cost.ts` 的模块注释。
		*
		* @param props - 见 {@link TurnCostActionProps}。
		* @returns pill 元素；这一轮（含其子代理）没有花费数据时不渲染任何东西。
		*/
		function TurnCostAction({ messageId, useChat, useProjection, useSessions, sessionId, t }) {
			const value = useProjection("turnCost");
			const seat = useAnchoredDialog();
			const [host, setHost] = (0, react.useState)(void 0);
			const sessions = (typeof useSessions === "function" ? useSessions : NO_LIST)((state) => state.byId);
			const rows = (0, react.useMemo)(() => sessions === void 0 ? void 0 : Object.values(sessions), [sessions]);
			const rollup = (0, react.useMemo)(() => rows === void 0 || sessionId === void 0 ? NO_SUBAGENTS : rollupSubagentCost(sessionId, rows, value), [
				rows,
				sessionId,
				value
			]);
			const turn = useChat((snapshot) => {
				if (messageId === void 0) return null;
				for (const node of snapshot.legacy.nodes) if (node.kind === "assistant" && node.messageId === messageId) return node.turn;
				return null;
			});
			const placement = value?.placement ?? "before-usage";
			(0, react.useLayoutEffect)(() => {
				const root = seat.rootRef.current;
				if (root === null) return;
				if (host === void 0) {
					setHost(findActionRow(root));
					return;
				}
				if (host !== null && !host.isConnected) {
					setHost(void 0);
					return;
				}
				try {
					reposition(root, placement, host);
				} catch {}
			});
			(0, react.useEffect)(() => {
				const anchorNode = host ?? seat.rootRef.current?.closest("[data-turn-tail]") ?? null;
				if (anchorNode === null) return;
				const observer = new MutationObserver(() => {
					const root = seat.rootRef.current;
					if (root === null) return;
					try {
						if (host === null || host === void 0) {
							const row = findActionRow(root);
							if (row !== null) setHost(row);
							return;
						}
						reposition(root, placement, host);
					} catch {}
				});
				observer.observe(anchorNode, {
					childList: true,
					subtree: true
				});
				return () => {
					observer.disconnect();
				};
			}, [
				host,
				placement,
				seat.rootRef
			]);
			const entry = value === void 0 || turn === null ? void 0 : value.turns[String(turn)];
			const slice = turn === null ? void 0 : rollup.byTurn[String(turn)];
			const grand = (entry?.cost.total ?? 0) + (slice?.cost ?? 0);
			const unpricedTurn = turn === null || value?.unpriced === void 0 ? [] : value.unpriced.byTurn[String(turn)] ?? [];
			const unpricedIds = formatProviders(unpricedTurn);
			const hasAmount = grand > 0;
			if (value === void 0 || turn === null || !hasAmount && unpricedIds === "") return null;
			const placed = host !== void 0 && host !== null;
			const marker = slice === void 0 ? "" : ` · ${t("cost.withSubagents")} ${String(slice.rows.length)}`;
			const amount = hasAmount ? `${formatCost(grand)}${marker}${unpricedIds === "" ? "" : ` · ${t("cost.unpricedMarker")} ${unpricedIds}`}` : `${t("cost.unpricedAmount")}（${unpricedIds}）`;
			const label = placed ? `${t("cost.spend")} ${amount}` : `${t("cost.spend")} ${amount} · ${t("cost.placeFallback")}`;
			const own = entry ?? EMPTY_ENTRY;
			const pages = agentPages(t, {
				own: {
					cost: own.cost,
					tok: own.tok,
					models: entry === void 0 || entry.model === "" ? [] : [entry.model]
				},
				ownTotalLabel: "cost.ownTurnTotal",
				ownModelOnSinglePage: true,
				subagents: slice
			});
			const pill = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				ref: seat.rootRef,
				className: pill_module_css_default.anchor,
				"data-cost-place": host === void 0 ? "probe" : host === null ? "inline" : "row",
				[OWN_ATTRIBUTE]: "",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: `${pill_module_css_default.trigger} ${pill_module_css_default.row}`,
					"aria-haspopup": "dialog",
					"aria-expanded": seat.open,
					"aria-label": placed ? `${t("turn.consumed")} ${amount}` : `${t("turn.consumed")} ${amount}（${t("cost.placeFallback")}）`,
					onClick: () => {
						seat.setOpen(!seat.open);
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconCoinOutline16, {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: pill_module_css_default.label,
						children: label
					})]
				}), seat.open && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CostDialog, {
					panelRef: seat.panelRef,
					pos: seat.pos,
					icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconCoinOutline16, {}),
					title: t("turn.title"),
					pages,
					footnote: footnote(t, entry === void 0 ? null : entry.peak, entry?.asOf ?? value.priceAsOf, entry?.est === true, [...slice === void 0 || slice.rows.length === 0 ? [] : [t("cost.subagentNote")], ...unpricedNotes(t, unpricedTurn)]),
					pager: {
						prev: t("cost.prevPage"),
						next: t("cost.nextPage")
					}
				})]
			});
			if (host === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				ref: seat.rootRef,
				className: pill_module_css_default.anchor,
				style: PROBE_STYLE,
				[OWN_ATTRIBUTE]: ""
			});
			if (host === null) return pill;
			return (0, react_dom.createPortal)(pill, host);
		}
		//#endregion
		//#region src/client/locales.ts
		/** 中文文案。 */
		const zh = {
			"turn.title": "本轮花费",
			"turn.consumed": "本轮花费",
			"session.title": "会话花费",
			"session.consumed": "会话花费",
			"cost.spend": "花费",
			"cost.model": "模型",
			"cost.hitRate": "缓存命中率",
			"cost.cacheHitInput": "缓存命中输入",
			"cost.cacheMissInput": "缓存未命中输入",
			"cost.output": "输出",
			"cost.total": "合计",
			"cost.ownTotal": "本会话自身",
			"cost.ownTurnTotal": "本轮自身",
			"cost.grandTotal": "合计（含子代理）",
			"cost.mainAgent": "主 Agent",
			"cost.agentsLead": "由",
			"cost.agentsTail": "个代理构成",
			"cost.agentTurn": "归属轮次",
			"cost.turnLead": "第 ",
			"cost.turnTail": " 轮",
			"cost.turnSep": "、",
			"cost.turnMark": " · ",
			"cost.attributedExact": "精确",
			"cost.subagent": "子代理",
			"cost.withSubagents": "含子代理",
			"cost.subagentNote": "子代理花费来自各子会话日志，按其轮次归属到本会话轮次",
			"cost.subagentAnchored": "按创建轮归属",
			"cost.subagentUnattributed": "未归属到轮次（只计入会话合计）",
			"cost.priceNote": "DeepSeek 官方 API 价格",
			"cost.peak": "高峰时段 ×2",
			"cost.valley": "空闲时段",
			"cost.estimated": "含未收录模型，按同类价估算",
			"cost.placeFallback": "未定位",
			"cost.noData": "暂无花费数据",
			"cost.unpricedMarker": "未计价 provider",
			"cost.unpricedAmount": "未计价",
			"cost.unpricedNote": "未计入金额（这些 provider 不在计价白名单内）：",
			"cost.prevPage": "上一页",
			"cost.nextPage": "下一页"
		};
		/** English copy. */
		const en = {
			"turn.title": "Turn cost",
			"turn.consumed": "Turn cost",
			"session.title": "Session cost",
			"session.consumed": "Session cost",
			"cost.spend": "Cost",
			"cost.model": "Model",
			"cost.hitRate": "Cache hit",
			"cost.cacheHitInput": "Cached input",
			"cost.cacheMissInput": "Uncached input",
			"cost.output": "Output",
			"cost.total": "Total",
			"cost.ownTotal": "This session",
			"cost.ownTurnTotal": "This turn",
			"cost.grandTotal": "Total incl. subagents",
			"cost.mainAgent": "Main agent",
			"cost.agentsLead": "Composed of",
			"cost.agentsTail": "agents",
			"cost.agentTurn": "Attributed turn",
			"cost.turnLead": "turn ",
			"cost.turnTail": "",
			"cost.turnSep": ", ",
			"cost.turnMark": " · ",
			"cost.attributedExact": "exact",
			"cost.subagent": "Subagent",
			"cost.withSubagents": "incl. subagents",
			"cost.subagentNote": "Subagent cost is read from each child session log and attributed to this session's turns",
			"cost.subagentAnchored": "anchored to creation turn",
			"cost.subagentUnattributed": "not attributed to a turn (session total only)",
			"cost.priceNote": "DeepSeek official API pricing",
			"cost.peak": "peak hours ×2",
			"cost.valley": "off-peak",
			"cost.estimated": "includes an unpriced model, estimated at the closest tier",
			"cost.placeFallback": "unplaced",
			"cost.noData": "No cost data yet",
			"cost.unpricedMarker": "unpriced provider",
			"cost.unpricedAmount": "unpriced",
			"cost.unpricedNote": "excluded from the amount (providers outside the pricing allow-list):",
			"cost.prevPage": "Previous page",
			"cost.nextPage": "Next page"
		};
		//#endregion
		//#region src/client/index.tsx
		/** 插件名（client 半独立命名，避免与 host 半的诊断名混淆）。 */
		const name = "turn-cost-client";
		/** 需要的服务：槽位注册表与文案运行时（缺任一则保持 pending，而不是硬失败）。 */
		const inject = ["slots", "locale"];
		/** 本插件拥有的字典命名空间。 */
		const NS = "turn-cost";
		/**
		* 给槽位组件套上错误边界（渲染异常 → 该 pill 消失，宿主 UI 不受影响）。
		* @param Inner - 本插件的槽位组件。
		* @returns 带错误边界的同名组件。
		*/
		function guarded(Inner) {
			return function Guarded(props) {
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CostBoundary, { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Inner, { ...props }) });
			};
		}
		/** 会话 pill（带错误边界）。 */
		const SafeSessionCostPill = guarded(SessionCostPill);
		/** 每轮 pill（带错误边界）。 */
		const SafeTurnCostAction = guarded(TurnCostAction);
		/**
		* client 插件体：字典 + 两个追加式槽位条目。
		* @param ctx - client 根上下文。
		*/
		function apply(ctx) {
			try {
				ctx.effect(() => ctx.locale.register(NS, {
					zh,
					en
				}), "dsh-turn-cost: dictionaries");
				ctx.slots.inject("conversation.composer.dock", () => {
					try {
						return ctx.slots.register({
							name: "conversation.composer.dock",
							id: "turn-cost",
							order: 1,
							locale: NS
						}, SafeSessionCostPill);
					} catch (error) {
						warn(error);
						return () => {};
					}
				});
				ctx.slots.inject("conversation.chat.assistant-actions", () => {
					try {
						return ctx.slots.register({
							name: "conversation.chat.assistant-actions",
							id: "turn-cost",
							order: 50,
							locale: NS
						}, SafeTurnCostAction);
					} catch (error) {
						warn(error);
						return () => {};
					}
				});
			} catch (error) {
				warn(error);
			}
		}
		/** 注册失败只记录，绝不外抛（client 插件抛错会打断整条客户端装配链）。 */
		function warn(error) {
			try {
				console.warn("[dsh-turn-cost] client 装配失败（已忽略，界面照常）：", error);
			} catch {}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map