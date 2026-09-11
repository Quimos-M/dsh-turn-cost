# dsh-turn-cost · 设计文档（DESIGN）

> **关于本文档**：本文档**主要由 AI 编码助手生成**，**未经人类逐条完整核验**。它存在的目的，是方便 AI 在后续会话中快速恢复上下文——记录**用户需求、项目目标、当前已实现的内容与实现框架**，以便后续修改或开发。因此：
> - 本文档**不构成任何承诺**（不构成对功能、性能、兼容性、维护或交付的保证）；
> - 本文档**不包含、也不代表项目作者本人的观点**；
> - 本文档**不构成任何法律声明**；
> - 文中技术描述若与代码实际行为不一致，**以代码实际行为为准**；
> - 许可、署名、商标等事项，一律以 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 为准；
> - 面向使用者的说明以 [README.md](README.md) 为准。

---

## 0. 一句话定位

一个**小而美、零侵入**的 DSH Web 计价插件：按 DeepSeek 官方API的人民币计价（含峰谷分时）准确计算**每轮对话花费**与**会话累计花费**，并用与原生「用量 / 耗时」完全一致的外观与交互展示；点开可分别查看**缓存命中输入 / 缓存未命中输入 / 输出**三项花费，子代理计入后在弹窗里**分页**查看（第 1 页总计、第 2 页主 Agent、往后每个子代理一页）。

---

## 1. 项目目标

本项目为 DSH Web 界面补上一件它自身没有的能力：**把每一轮对话、以及整个会话在 DeepSeek 模型上的花费，按官方 API 价格算出来并显示出来**。希望实现的目标功能：

1. **单轮花费**：每轮回答结束时，显示该轮实际发生的每一次模型请求（含失败重试）按其**请求时刻的官方单价**计算出的花费。
2. **会话累计**：把各轮花费累加，显示该会话至今的总花费；中途更换模型、翻页浏览历史、上下文压缩、会话分叉都不改变这个数字。
3. **分项可核对**：花费可下钻到**缓存命中输入 / 缓存未命中输入 / 输出**三项，各自给出 token 数与金额，并标明所依据的价格口径（模型家族、生效时间、高峰 / 空闲）。
4. **子代理一并计入**：一轮内调用过的子代理、以及会话内全部子代理的花费，都计入对应轮次与会话合计，并可逐页查看各代理自身的明细。
5. **与原生观感一致**：以与 DSH 原生「用量 / 耗时」相同的 pill 与弹窗形态呈现；不改动官方源码，不覆盖原生或他人贡献的 UI。
6. **独立、轻、可卸载**：不依赖任何其他插件，不新增运行时依赖，不需要额外凭证或网络请求；卸载后不留残留。

### 1.1 边界

- 只做"按官方价目表推算花费"这一件事：**不查询账户余额，不做充值、额度等平台侧账务**。
- 数字是由官方公开价目表推算出的**估算值**，**不替代开放平台的账单**（口径边界见 §9）。
- 暂不提供设置界面与命令入口；价表与展示参数通过插件配置调整。

## 2. 需求决策记录（用户确认）

| # | 决策 | 实现 |
|---|---|---|
| 1 | 每轮 pill 放在「用量前 / 用量与耗时之间 / 耗时后」三选一，尽量让三者连成一组 | 默认 `before-usage`（用量前），配置可切 `between` / `after-time` / `inline` |
| 2 | 不得与其他页面插件冲突 | 只用 list 槽位新 id 追加；不碰 chain/keyed/single；颜色全走主题变量 |
| 3 | 只用人民币官方价，用 ¥ 标明 | 价表全部 CNY，UI 一律 `¥` |
| 4 | `deepseek-v4-flash` / `-vision-exp` / `deepseek-v4.1-flash` 统一按 **v4.1-flash** 价；`v4-pro` 暂按自身价，14 日 12:00 后的改路由不在本版范围 | 价表按模型家族 + 生效时间实现，v4-pro 切换只需补一行数据 |
| 5 | **插件出 bug 或装不上，绝不能导致 DSH 崩溃或打不开** | 见 §6 的六道防线 |
| 6 | **每轮花费要含该轮调用的子代理、会话总花费要含全部子代理** | host 侧仍只折叠自身日志（新增自身口径与子代理锚点），客户端按官方会话列表聚合后代 `turnCost`；规则与边界见 §11 |

---

## 3. 计费口径与官方价表

### 3.1 口径（源码级对齐原生）

- 三桶**互斥**：`缓存命中 = prompt_cache_hit_tokens`，`缓存未命中 = prompt_tokens − 命中`，`输出 = completion_tokens`（reasoning 已含在输出内，不重复计费）。DeepSeek 不产生 cacheWrite，故不设该行。
- 路由归因：优先取最近一次 `request/header` 的 `{provider, model}`，回退 `assistant/message.message.source`。
- **替换语义**：同一 `(turn, step)` 的新样本先减旧值再加新值（流式样本会被最终样本覆盖）。
- **重试累加**：`llm/retry-started` 清空替换槽 → 失败重试的每次请求都真实计入（与原生每轮用量面板一致）。
- **精度**：`金额(µ¥) = round(tokens × 元/百万)`，全程整数累加，无浮点漂移；显示时才 ÷1e6。
- **自身口径 vs 整段口径**：每条会话日志可能带 fork 继承前缀（`isSeeded`），那一段的请求是**祖辈**花的钱。因此投影同时给出两套：`turns` / `totals` 是整段日志口径（与原生 `tokenUsage` 逐项一致，用于本会话自己的 pill），`ownTurns` 是**本会话自己那段日志**（`seq ≥ 继承前缀长度`）的口径，供父会话聚合时避免重复计费。未 fork 的会话两者相同。
- **子代理**：子代理是**独立会话**，用量事件在它自己的日志里；父会话日志只有 `subagent/catalog` 这条目录事实（没有用量）。因此子代理花费由客户端聚合（§11），本节的折叠口径只覆盖"本会话自己的请求"。

### 3.2 价表（元 / 百万 tokens）

| 生效区间（北京） | 模型家族 | 缓存命中 | 缓存未命中 | 输出 |
|---|---|---|---|---|
| 2026-09-10 12:00 起 | flash 家族（含 v4.1-flash、vision-exp） | 谷 0.02 / 峰 0.04 | 谷 1 / 峰 2 | 谷 4 / 峰 8 |
| 2026-08-17 – 09-10 12:00 | flash 家族 | 0.05 / 0.10 | 1.5 / 3.0 | 4.5 / 9.0 |
| 2026-08-17 起 | `deepseek-v4-pro`（暂按自身价） | 0.15 / 0.30 | 4.5 / 9.0 | 13.5 / 27.0 |
| 2026-08-12 – 08-17（无峰谷） | `deepseek-v4-pro` 正式版 | 0.025 | 3.0 | 6.0 |

- **峰谷规则**：高峰 = 北京时间**周一至周五** `09:00–12:00`、`14:00–18:00`，其余（含周末）全天谷价；峰价 = 谷价 × 2。规则本身也版本化（08-17 起为"每天峰谷"，08-23 起改为"仅工作日"）。
- 未收录模型 → 按现行 flash 价估算并在 UI 标 `≈`；非 `deepseek-official` 路由默认不计价（可用配置放宽）。
- 来源：[TechWeb 9/9 调价](https://www.techweb.com.cn/it/2026-09-09/2978890.shtml)、[驱动人生（新价表 + v4.1-flash 路由说明）](https://www.160.com/article/13680.html)、[CNMO（8/17 峰谷生效）](https://ai.cnmo.com/news/816100.html)、[DoNews（V4 Pro 原价）](https://www.donews.com/news/detail/4/6673100.html)。

---

## 4. 架构

```
host（Node）                                  client（浏览器）
┌────────────────────────────────┐            ┌───────────────────────────────────────┐
│ src/index.ts  注册投影单元      │            │ src/client/index.tsx                  │
│ src/projection.ts  纯 fold：    │  wire →    │  ├ SessionCostPill  (composer.dock,1) │
│   token 桶 × 峰谷单价 → µ¥      │  投影帧     │  └ TurnCostAction   (assistant-actions│
│   每轮明细 + 会话累计           │            │        + 落位到「用量」pill 之前)      │
│   + 自身口径 + 子代理锚点(§11)  │            │ src/client/subagent-cost.ts  纯聚合： │
│ src/prices.ts  价表 + 峰谷判定  │            │   本会话自身 + 全部后代自身(§11)      │
└────────────────────────────────┘            │ dialog-pages / rows  纯装配：分页(§12)│
                                              │ CostDialog / anchored-dialog / guard  │
                                              │   ↑ useProjection(自身)               │
                                              │   ↑ useSessions(byId → 各会话投影值)  │
                                              └───────────────────────────────────────┘
```

- **host 半没有任何运行时 import**（只 import type）→ 不存在"依赖缺失导致加载失败"的路径。
- **client 半只 require 平台模块表**：`react` / `react/jsx-runtime` / `react-dom` / `@deepseek-ai/dsh-client-ui-primitives`（图标与锚定/关闭钩子）。其余 DSH 包一律 type-only（构建期擦除，过外部插件纯度门）。`useSessions` 是**由框架以 props 交付**的全局标准座位（官方 ui-renderer 的 standard kit），不是新 require。
- 数据通路用 DSH 原生的 **session 投影接缝**：订阅、水位、变更推送、持久缓存全部由框架负责，因此翻页 / 滚动 / 压缩 / 分叉都不会改变数字。

### 4.1 落位策略（唯一需要"技巧"的地方）

槽位系统能给出的干净位置是"分支按钮之前"；要满足"花费 · 用量 · 耗时 三者连成一组"，插件在挂载后重新落位。两种手段，都用**只动自己节点**的方式：

**每轮 pill（`conversation.chat.assistant-actions`，与原生 pill 同一动作行）**

| 配置 `placement` | 结果 | 锚点 |
|---|---|---|
| `before-usage`（默认） | `复制 · 反馈 · 分支 · **花费** · 用量 · 耗时` | 原生「用量」pill 的**行内直接子节点**（用 `findActionRow` 向上找到真正含原生 pill 的祖先，不依赖 `parentElement`） |
| `between` | `… 分支 · 用量 · **花费** · 耗时` | 原生「耗时」pill 的直接子节点 |
| `after-time` | `… 分支 · 用量 · 耗时 · **花费**` | 原生「耗时」pill 的直接子节点之后 |
| `inline` | 留在槽位原位（分支之前），完全不碰 DOM | 无 |

> 踩过的坑（两轮实测，已按"不依赖任何结构假设"重做）：
> 1. 原生 pill 结构是 `<span><button/></span>`；拿内部 `button` 当 `insertBefore`
>    锚点会抛 `NotFoundError`，被 try/catch 吞掉后表现为"落位失效"→ 现在用
>    `rowCellOf()` 把锚点收敛成行内直接子节点。
> 2. 只靠 `root.parentElement` 找动作行太脆（槽位/框架任何一层包裹都会让它落空）
>    → 改为 `findActionRow()` 向上寻找真正含原生 pill 的祖先（上界 `[data-turn-tail]`，
>    绝不越界认领别的轮次）。
> 3. 跨父节点手工搬节点会让 React 卸载时的 `removeChild` 抛错 → 改为 **React portal**
>    送进动作行，再在**同一容器内**重排。
> 4. 原生 pill 可能晚一个提交出现、或被 React 重新插入 → 加 `MutationObserver`
>    （只观察本轮尾子树）随时补齐落位。
> 5. 落位降级不再"静默"：标签会显式追加 `· 未定位`，并把结果写进
>    `data-cost-place="row|inline|probe"`，便于一眼判断而不是猜。
> 6. pill 识别用两条独立线索（`aria-haspopup="dialog"` 或 `aria-expanded`），
>    防止某个版本漏写属性导致识别为空。

**会话 pill（`conversation.composer.dock`）**

dock 是**纵向堆叠的 list 槽位**：同槽位的兄弟条目会各占一行，直接渲染会掉到原生
「耗时 · 用量」那一行的**下面一行**。因此改用 React **portal** 把 pill 送进原生统计
行 `[data-composer-stats]`，三者在同一行里居中：`耗时 · 用量 · 花费`。

> 用 portal 而不是手工 `appendChild`：跨父节点手搬节点会让 React 卸载时的
> `removeChild` 抛 `NotFoundError`；portal 让 React 继续管理挂载/卸载。定位用
> "从自己向上最近的、含 `[data-composer-stats]` 的祖先"（最近匹配 → 只会命中本会话
> 的输入区），测不到则退回原位渲染（多占一行但功能完整），测量前一帧渲染隐形探针
> 以避免闪烁。

约束：绝不修改/包裹/隐藏任何原生节点；锚点找不到就静默留在原位；整体 try/catch。

### 4.2 货币标注与金币图标

pill 与弹窗数值统一为 **`花费 1.6809 CNY`** 形态：金币图标 + 数值 + ISO 代码 `CNY`
（不再输出 `¥` 符号：早先"¥ 图标 + ¥ 文本"重复标注）。

金币图标 = 外圈 + 圈内 ¥。尺寸**按实测原生图元对齐**：`IconClockOutline16` 是
`circle r=6.375 / strokeWidth 1.25`，因此币面取同值；圈内 ¥ 字面放大到横向 5.0、
纵向 6.8 单位（第一轮目视反馈"￥太小看不清"即字面偏小所致）。
改回 `¥` 文本只需动 `src/client/cost-format.ts` 的 `UNIT`。

---

## 5. 目录与文件职责

```
dsh-turn-cost/
  package.json            main=lib/index.js；exports ./client=lib/client.js
                          dsh.bundle.patch → cordis.patch.yml；dsh.client{platform:web}
  cordis.patch.yml        profile 挂载声明（insert id=dsh-turn-cost）
  tsconfig.json           全量类型检查配置
  tsdown.config.ts        node 半 3 入口 + 浏览器 bundle
  build/web-platform.ts   平台模块表（DSH 官方 seed 的**子集**）
  build/tsdown.client.ts  外部 UI 插件 preset：闭包工厂 + lightningcss CSS Modules 内联 + 纯度门
  scripts/build.sh        DSH_CHECKOUT 探测 → junction 链接开发期依赖 → tsc 类型检查
  scripts/replay-session.mjs  真会话日志（多帧 zstd）回放验证工具；`--tree` 还会
                              扫子会话日志、跑客户端那份聚合做整棵树核对
  src/types.ts            共享纯类型 + 投影 key 合并（SessionProjectionMap/StateMap）
  src/prices.ts           价表 + 峰谷判定 + 三桶计价（纯函数）
  src/projection.ts       turnCost 折叠：状态、wire 视图、全函数 schema、never-throw 契约
  src/index.ts            host 插件：注册投影单元
  src/client/index.tsx    client 插件：字典 + 两个 list 槽位条目 + 幂等注册
  src/client/SessionCostPill.tsx  会话累计 pill（自身 + 后代聚合）
  src/client/TurnCostAction.tsx   每轮 pill（本轮自身 + 归属到本轮的子代理）
  src/client/subagent-cost.ts     子代理聚合（纯函数，可单测）：后代发现 / 轮次归属
  src/client/CostDialog.tsx       弹窗（与原生 stat-dialog 同皮肤）
  src/client/anchored-dialog.ts   复用平台图元的锚定/点外关闭座位
  src/client/guard.tsx            渲染错误边界
  src/client/dialog-pages.ts      弹窗分页（纯函数，可单测）：页数 / 页码钳制 / 步进与
                                  循环翻页 / 页列表装配（总计页、主 Agent 页、子代理页）
  src/client/rows.ts              明细行装配：三桶行 / 单代理行 / 总计行 / 归属文案
  src/client/cost-format.ts / locales.ts / icons.tsx
  src/client/*.module.css         pill 与弹窗皮肤（全走 DSH 主题变量）
  tests/prices.test.mjs           价表/峰谷/边界 10 项
  tests/projection.test.mjs       折叠语义/替换/重试/自身口径/锚点/健壮性 18 项
  tests/cost-format.test.mjs      显示格式（CNY 单标注/下限/千分位）5 项
  tests/row-placement.test.mjs    落位回归 13 项（自建极简 DOM 夹具）
  tests/subagent-cost.test.mjs    子代理聚合 11 项（后代发现/归属/兜底/退化）
  tests/dialog-pages.test.mjs     弹窗分页 19 项（页数/钳制/翻页/单页退化/三页结构/文案）
  tests/dom-fixture.mjs           夹具：复刻"锚点必须是直接子节点"的真实约束
  src/client/row-placement.ts     落位算法（纯 DOM，可单测）
```

---

## 6. 「绝不拖垮 DSH」的六道防线

1. **host 注册 try/catch**：`apply` 里注册投影失败只记日志；`inject:['sessionProjections']` 让缺环境时保持 pending 而不是失败。
2. **fold never-throw**：投影 `apply` 被框架在**每个会话的每个事件**上同步调用，内部整体 try/catch，任何异常都返回原状态、绝不外抛。
3. **schema 全函数**：注册表只用到 `.parse()`，且 `drive` 路径对 `viewSchema.parse` **没有** try/catch —— 所以本插件不用会抛错的校验器，而是提供"强制清洗、永不抛错"的实现（顺带换来 host 半零运行时依赖）。
4. **client 注册 try/catch + 幂等**：`apply` 与两个 `slots.inject` 回调都兜异常；同 (slot,id,priority) 重复注册时让位而非抛错（同一插件被重复装配时最多一组 pill，不报错也不重复 UI）。
5. **渲染错误边界**：两个 pill 各自包在 `CostBoundary` 里，渲染异常 → 该 pill 消失，页面其余部分不受影响。
6. **构建产物齐备**：`package.json` 声明了 `dsh.client`；`scripts/build.sh` + `tsdown` 保证 `lib/client.js` 存在（缺它前端会挂）——构建链已跑通，`lib/client.js` 的 `require` 恰好是平台模块表内的 4 个模块（纯度门在打包时校验）。

---

## 7. 构建 / 测试 / 安装

```bash
# 构建（自动探测 DSH checkout，也可 DSH_CHECKOUT=/path/to/DSH）
npm run build            # = bash scripts/build.sh（类型检查）+ tsdown（产物）
npm run build:client     # 只出产物
npm test                 # node --test tests/*.test.mjs（76 项）

# 数值复核（真会话日志回放，会打印逐轮表格并核对与原生 token 口径一致）
node scripts/replay-session.mjs ~/.dsh/sessions/<cwd>/<sessionId>/
# 连子会话一起核对（跑的就是客户端那份聚合函数）
node scripts/replay-session.mjs <会话目录> --tree
# 再把弹窗逐页内容打印出来（跑的就是客户端那份分页装配：总计 / 主 Agent / 各子代理）
node scripts/replay-session.mjs <会话目录> --tree --pages

# 安装方式：DSH 官方的 profile 装配路径（dependencies 的 link: + dsh.profile.bundles）
#   profiles/web/package.json:
#     "dependencies": { "dsh-turn-cost": "link:/mnt/e/测试/dsh-turn-cost" }
#     "dsh": { "profile": { "bundles": [ ..., "dsh-turn-cost" ] } }
#   两处声明已写入；重启 dsh web 后由 bundles 列表装配。
```

---

## 8. 验收记录（2026-09-11 首次实测，2026-09-12 补弹窗分页）

| 项目 | 结果 |
|---|---|
| 类型检查（tsc，strict） | 通过，0 错误 |
| 单元测试 | **76/76 通过**（峰谷边界、跨价格版本、替换/重试语义、跨轮换模型、非计价 provider、脏输入健壮性、持久化往返、**继承前缀的自身口径**、**子代理锚点**、金额显示格式、**落位回归 13 项**、**子代理聚合 11 项**、**弹窗分页 19 项**） |
| host 装配 | loader entry `active`，投影 key `turnCost` 出现在活体注册表（与 `tokenUsage`/`sessionStats` 并列） |
| client 装配 | client-modules 模块表（58 条）含 `dsh-turn-cost → /mnt/e/测试/dsh-turn-cost/lib/client.js` |
| 重新装配 | 重启 dsh web（profile bundles）或重置 loader 条目后，host 与 client 半均正常加载；`lib/client.js` 的 require 仍恰好是平台模块表的 4 个模块 |
| 活体数值（本会话） | 会话自身 ¥5.6039 + 3 个子代理 ¥1.3682 = **¥6.9721**（随对话实时增长）；全部 valley ✓ |
| token 口径一致性 | 与原生 `tokenUsage` 投影算法复刻**逐项一致**（父会话 + 3 个子会话逐一核对）✓ |
| 子代理逐轮归属（真实数据） | 父会话 3 个 `subagent/catalog` 锚点分别落在第 12 / 13 / 21 轮；三个子会话各自 1 轮，时间窗归属结果与锚点**完全一致**（`--tree` 输出）✓ |
| 活体端到端（host wire → 客户端聚合） | 在活体 host 上取 `session.list` 同源数据（挂载会话走投影注册表、冷会话走持久投影缓存），调用**客户端那份** `rollupSubagentCost`：3 个子会话全部计入（含 2 个冷会话，走 `ownComplete:false` 兼容读法并标 `exact:false`），会话合计 ¥5.603871 + 子代理 ¥2.009142 = **¥7.613013**，未归属 0 ✓ |
| 聚合自检（真实数据） | 逐会话自身口径之和 == 子代理聚合合计 ✓；任一会话自身口径 ≤ 整段口径（无重复计数）✓；10+ 个真实会话全部通过 |
| 弹窗分页（真实数据） | 会话 pill 弹窗 **6 页**（总计 / 主 Agent / 4 个子代理各一页），4 个每轮 pill 各 **3 页**（本轮总计 / 本轮自身 / 该轮子代理）——`node scripts/replay-session.mjs <会话目录> --tree --pages` 逐页打印核对 ✓；逐页行数实测：第 1 页固定 6 行、会话口径主 Agent 页 5 行、每轮口径主 Agent 页 6 行、子代理页 6 行（该子代理有模型行时 7 行）——都在 `.detailsPaged` 的 7 行（162px）最低高度内，翻页不抖 |
| 分页不改变聚合 | 同一份冻结会话快照（父会话 + 4 个子会话）在改造前后跑 `--tree --json`：自身 ¥5.675666 / 子代理 ¥2.320270 / 合计 ¥7.995936、`checks` 与 `rows` 逐项一致 ✓；新增字段只是三桶与细目（`byTurn` 的三桶之和 == 子代理合计 ✓） |
| 热重载 | `dev_reload_package dsh-turn-cost` → host fiber 重建、`client ✓ (lib/client.js)`，重载前后均 `[active]` ✓ |
| 卸载洁净 | 从 profile 的 `bundles` / `dependencies` 移除后重启：投影注册与两个槽位条目一并消失，无残留（同槽位幂等让位，不会因重复装配报错） |
| 目视反馈修复（第一轮） | ① 会话 pill 掉到第二行 → portal 进原生统计行 ✓ ② ¥ 图标 + ¥ 文本重复标注 → 金币图标 + `花费 X CNY` ✓ |
| 目视反馈修复（第二轮） | ③ 每轮 pill 一直在分支之前 → 落位改为"不依赖结构假设"：`findActionRow` 向上找真动作行 + portal + MutationObserver + 双线索识别 + 降级可见标记（用户截图确认位置已正确 ✓） ④ 金币 ￥ 太小 → 按原生图标基准（r=6.375/1.25）重画并放大 ¥ 字面 ⑤ 脚注文案改为「DeepSeek 官方 API 价格」 |
| 目视确认（2026-09-12 作者确认） | **弹窗分页的观感与手感**：翻页控件位置 / 大小 / 配色、翻页时面板高度稳定、页码信息量、`←/→`·`Enter`·`Esc` 手感 —— 均由作者目视确认无问题 ✓。仍待补：fork 种子（`isSeeded`）子会话的真实数据核对（本机 52 个真实会话里 0 个种子会话，仅有单测覆盖） |

---

## 9. 已知边界

- **子代理花费的边界**见 §11.4（逐轮归属是时间窗规则、只聚合会话列表里可见的后代、历史缓存行未刷新时该子会话暂时缺席）。
- **非 DeepSeek 路由**（如 GLM）默认不计价、该轮不显示花费。
- **账户余额、充值、额度**等平台侧账务不在本插件职责内：本插件只做"token × 官方单价"的推算。
- **v4-pro 2026-09-14 12:00 后的改路由**不在本版：届时在 `src/prices.ts` 的 PRO 家族补一条 `from` 规则并 +1 `PRICE_REVISION`（价表修订号与投影 `stateVersion` 绑定，旧缓存行会自动作废重算）。
- 价格表变更需重载插件；`placement` 改动同样随重载生效。
- **持久缓存的向前兼容**：`stateVersion` 仍只跟价表修订号绑定（`PRICE_REVISION`）。**加字段不 bump 版本**，而是用状态里的覆盖标记 `ownComplete`（`init` 从 seq 0 折起 ⇒ 1；由 `stateSchema.parse` 从旧持久行恢复 ⇒ 保留旧值、缺省 0）。这样冷会话（未挂载、只有持久缓存行）的旧行照旧可用，子代理花费不会因为一次插件升级而从父会话总账里**静默消失**；客户端遇到 `ownComplete !== true` 退回整段日志口径并标注为近似（§11.4）。只有让**已有字段语义**变得不可解释的改动才值得作废旧行。

---

## 10. 待确认 / 后续可选项

1. **安装方式（已落成常规 profile 装配）**：`profiles/web/package.json` 的 `dependencies`（`link:/mnt/e/测试/dsh-turn-cost`）+ `dsh.profile.bundles` 都已写入，重启 dsh web 后由 bundles 装配。
2. **目视确认（已确认项）**：每轮动作行顺序 `复制 · 反馈 · 分支 · 花费 · 用量 · 耗时` 已由用户截图确认正确；子代理计入后的数据通路已在真实会话上核对（§8）；弹窗分页的观感与手感亦经作者目视确认（2026-09-12）。
   本次待确认的是**分页观感**（数字计算已由 `--pages` 逐页核对，只剩眼睛要看的部分）：
   (a) 翻页控件 `‹ 2/4 ›` 的位置（明细之下、脚注之上）、大小与颜色是否够"原生"；
   (b) 逐页翻过去时面板高度/位置是否稳定（最低高度按最长页 7 行设定，理论上不跳）；
   (c) 第 1 页的构成摘要 `由 5 个代理构成 : 主 Agent 5.6757 CNY + 子代理 2.3203 CNY` 是否一眼能懂；
   (d) 左右方向键 / 回车翻页、Esc 关闭的手感（回车在最后一页回到第 1 页）。
3. 文案微调（一句话可改）：若更想看到「￥花费 2.389CNY」这种写法，改 `src/client/cost-format.ts` 的 `UNIT` 即可。
4. 后续可选：子代理花费的**逐轮精确归属**（需要框架给出子会话轮次 ↔ 父会话轮次的显式事实）、`/cost` 命令、设置页可视化价表编辑。

---

## 11. 子代理（subagent）计价

### 11.1 官方事实（源码级证据）

| 问题 | 结论 | 证据 |
|---|---|---|
| 父会话日志里有子代理事件吗？带什么？ | 有 `subagent/catalog`：**父会话自有**的直接子会话发现事实，字段是 `childId` / `childCreatedAt` / `mode` / `label` —— **不含任何用量** | 事件与 payload：`packages/subagent/subagent/src/catalog.ts:24-42`；写入父日志：`:134-156`；投影视图字段：`src/projection-types.ts:9-18`。整份事件清单只有 3 个 `subagent/*`：`packages/core/session/src/known-event-types.ts:58-60` |
| 子代理的用量在哪里？ | 在**子会话自己的日志**里（它是一次独立会话）；父会话只看到"这个子会话存在" | 实测父会话日志 1933 条事件中 `subagent/catalog` 3 条、无任何用量字段 |
| 会话头有父子关系吗？ | 有：`parentSession` / `origin: 'subagent'` / `delegationDepth` | `packages/core/session/src/types.ts:105-122`；实测子会话 header 三个字段齐备 |
| 官方 UI 怎么读子代理数据？ | 官方会话列表状态 `useSessions(s => s.byId)`，逐行读 `summary.projectionValues?.subagentTiming` / `?.tokenUsage`；后代用 `origin === 'subagent'` + `parentId` 向上回溯 | `packages/client/ui-subagent/src/client/SubagentHeaderLineage.tsx:488-489,94-96,307`；`.../subagent-lineage.ts:24-45` |
| 客户端能读别的会话的投影值吗？ | 能，这是官方通道：会话列表每一行都带 host 算好的 `projectionValues`（= 该会话**全部 client-visible wire 值**），且新值以 `projection` 帧**面向所有会话**广播；`useSessions` 是框架交付给**每个**槽位组件的全局标准座位 | 行内投影块：`packages/api/session-controller/src/list.ts:268-294` ← `ctx.sessionProjections.cachedSnapshot(session).values`；客户端装填：`.../client/sessions/manager.ts:914-921,668` 与 `service.ts:592-598`；全局广播：`packages/api/session-controller/src/control.ts:26-33`；座位交付：`packages/client/ui-slots/src/index.ts:195-232`（`PropsRuntime` 含 `GlobalStandardProps`）+ `packages/client/ui-session/src/client/index.ts:105-108`，官方测试 `packages/client/ui-renderer/tests/scoped-slots.client.spec.tsx:685,1057` |

本机实测（活体 host）：父会话与子会话的 `cachedSnapshot(...).values` 里都带 `turnCost`（19 个键），数值与日志回放一致。

### 11.2 为什么聚合必须在客户端（纯度论证）

投影 `apply` / `view` **绝不读别的会话** —— 它们只折叠本会话自己的日志。这是纯度底线：父会话的 `turnCost` 必须能被持久缓存与重放一致地重建，一旦在折叠里跨会话取值，缓存行、水位、分叉全都失去意义。

而父会话日志本身**不携带**子会话用量（§11.1），所以"把子代理花费并入显示"唯一合规的做法就是**客户端聚合**：

```
父会话 pill 金额 = 父会话 turnCost.totals（纯折叠）
                 + Σ 每个后代会话 turnCost.ownTurns 的合计（官方列表行里的投影值）
```

它仍然是"纯"的：host 侧的每个值都是各自日志的纯折叠；客户端只是把**框架已经算好并校验过的**若干值按一条确定性规则相加。跨会话读取走的是官方 `useSessions` 座位（官方 ui-subagent 同款用法），没有内部/私有 API，没有 hack。

聚合只用"自身口径"（`ownTurns`）而不是整段口径（`turns`）来避免重复计费；每个值都带一个 `ownComplete` 覆盖标记说明"自身口径是否覆盖整段日志"（旧持久缓存行 ⇒ `false`），客户端据此选择精确读法或整段口径的兼容读法。

### 11.3 逐轮归属规则

框架**没有**"子会话第 N 轮属于父会话第 M 轮"的显式事实，因此按两条依次降级的规则归属（实现在 `src/client/subagent-cost.ts`，纯函数、可单测）：

1. **时间窗（首选）**：子会话那一轮自己记录的 `turn/start` 时刻（`ownTurns[k].startedAt`，host 从子会话日志折叠）→ 落到**本会话最后一个不晚于它的轮起点**。子会话的一轮总是被"触发它的那次工具调用"所在的那一轮包住，所以对一次性子代理（父会话 await 结果）精确，对可持续子代理的后续激活落在**触发轮**。
2. **创建锚点（兜底）**：子会话那一轮没有起点时刻时，用父会话日志里 `subagent/catalog` 记录的创建轮（`spawns[childId].turn`）；跨层后代先沿祖先链把祖先的轮次换算上来。这种行在 UI 里显式标 `按创建轮归属`（`exact: false`）。

两条都不可用时，该笔花费只计入**会话合计**、不落到任何一轮，并在弹窗里列一行"未归属到轮次"。

### 11.4 边界与降级（如实记录）

- **后台/可持续子代理可能在父会话某一轮结束后继续跑**：花费按"触发轮"归属，不按其实际消耗时刻摊到多轮。
- 只聚合**会话列表里可见**的后代：列表里没有的会话（已删除、未加载）看不到，也读不到它的投影值。
- 子会话的 `turnCost` 完全缺失（例如从未被 host 折叠过）时该子会话**不参与聚合**：宁可少显示，不猜。
- 子会话的值来自**新增自身口径之前写下的持久缓存行**时（`ownComplete !== true`），退回整段日志口径（与该会话自己的 pill 同源）并把归属标成"按创建轮归属"：宁可给一个明确标注的近似值，也不让这个子会话从父会话总账里消失。这类行会在该会话下次被重新折叠（挂载、或持久缓存重写）后自动升级为精确读法。
- `useSessions` 缺席（非官方宿主）时两个 pill 照旧只显示本会话自身：**降级为原行为，不报错**。
- **fork 继承前缀**：`ownTurns` / `spawns` 都按 `seq ≥ 继承前缀长度` 过滤，因此种子会话不会把祖辈的用量与祖辈的子会话重复计进来（沿用官方 `subagentCatalog` 单元的同一守卫思路，`catalog.ts:121`）。本机 52 个真实会话里没有种子会话，此项**仅有单测覆盖**。
- 数字口径：本插件是"官方公开价 × provider 上报 token"的推算，子代理部分同样如此，**不等于平台最终账单**。

---

## 12. 弹窗分页（子代理计入后的可读性）

### 12.1 问题与决策

子代理计入后（§11），弹窗原本把"总计 + 每个子代理一行"挤在一屏里：子代理一多，总计反而被埋掉，
每个子代理也只有一行金额、看不到它自己的三桶。用户口径是：**首页显示总计花费，分页显示主 Agent
和多个子代理的花费**。因此：

* 页序固定为 **总计 → 主 Agent → 每个子代理一页**（子代理顺序沿用聚合结果的排序：层级浅的在前、
  金额大的在前，见 `subagent-cost.ts` 的 `rows.sort`）；
* **没有子代理时退化为单页**：页数恒为 1，翻页控件**完全不渲染**，行与分页前逐条一致 ——
  没有子代理是最常见的情形，不该为它加任何噪音；
* 两个 pill 共用同一套装配（`agentPages(t, input)`）：**唯一的差别是喂进去的子代理来源**
  —— 会话累计 pill 传**全量聚合** `rollup`（`SessionCostPill.tsx`：`subagents: rollup`），
  每轮 pill 传**该轮切片** `rollup.byTurn[String(turn)]`（`TurnCostAction.tsx`：`subagents: slice`，
  该轮没有子代理时 `slice === undefined`）。切片由 `rollupSubagentCost` 逐轮装配（§11.3），
  因此**每轮 pill 的子代理页只包含归属到该轮、且在该轮有花费的子代理**；某个子代理跨两轮时，
  两轮的 pill 各看到它对应那一轮的金额与三桶（`details` 按 id 在切片内累加）。
* 两个 pill 的**主 Agent 页口径**由调用方给标签区分：会话 pill 是 `本会话自身`
  （`cost.ownTotal`，合计 = `turnCost.totals`），每轮 pill 是 `本轮自身`（`cost.ownTurnTotal`，
  合计 = `turns[turn].cost`）。第 1 页（总计）的合计相应为"自身 + 该来源的子代理合计"。

### 12.2 每页内容

| 页 | 标题右侧合计 | 明细行 |
|---|---|---|
| 1 总计 | 主 Agent + 子代理 | 缓存命中率（合计口径）→ 缓存命中输入 / 缓存未命中输入 / 输出（金额 + token）→ `合计（含子代理）` → 由 N 个代理构成 : 主 Agent x CNY + 子代理 y CNY（金额由 `formatCost` 渲染，形态见 §4.2） |
| 2 主 Agent | 本会话自身（每轮 pill 为"本轮自身"） | 模型（会话跨模型时列出全部，` · ` 分隔）→ 缓存命中率 → 三桶 → 合计 |
| 3+ 子代理 | 该子代理的花费 | `子代理 : 名称`（跨层加缩进点）→ 模型 → 三桶 → `合计` → `归属轮次 : 第 12 轮 · 精确`（兜底标 `按创建轮归属`，落不到轮的标 `未归属到轮次（只计入会话合计）`） |

子代理页**不显示缓存命中率**（`agentRows` 的 `withHitRate: false`）：用户要的是"哪个代理花了多少、
算在哪一轮"，砍掉这一行后子代理页的常规行数（无模型行 = 6 行）与第 1、2 页同量级，面板高度因此
稳定（见 12.3）；该子代理有模型行时多一行（7 行），仍不超过 `.detailsPaged` 的 7 行最低高度。
价格口径脚注**每页都保留**。

### 12.3 页数规则、交互、尺寸与键盘

**页数规则**（`src/client/dialog-pages.ts` 的 `pageCount`，纯函数）：

| 有花费的子代理个数 | 页数 | 页序 |
|---|---|---|
| `0` | `pageCount(0) = 1`（单页退化） | 只有"主 Agent"这一页，且**不渲染翻页控件** |
| `n > 0` | `pageCount(n) = n + 2` | 1 总计 → 2 主 Agent → 3 … n+2 各一个子代理 |

* **单个子代理页 = 一个子代理**：页数与"该切片里有花费的子代理个数"严格相等，页序沿用聚合结果的排序
  （层级浅的在前、金额大的在前，见 `subagent-cost.ts` 的 `rows.sort`）。
* **钳制**：存的页码是"期望值"，渲染时用 `clampPage(index, count)` 夹进 `[0, 页数-1]`（脏输入归 0，
  页数非法时按 1 页处理）。子代理数变少 → 页数缩水 → 当前页自动回到最后一页，**不会渲染出空白页**。
* **翻页控件**：极简的 `‹ 2/4 ›`（按钮 20×20、`--dsw-alias-interactive-bg-hover` 悬停底色、页码
  `tabular-nums`、两端到底时按钮 `disabled`），位置在明细之下、脚注之上，复用弹窗皮肤变量，
  不引入新依赖、不新增图片资源；**单页时整个控件不渲染**（`paged = count > 1`）。
* **键盘**：`←` / `→` 用 `stepPage` 步进（**两端夹住不环绕**）；`Enter` 用 `cyclePage` 循环到下一页
  （末页回到第 1 页），连按即可把每页过一遍；`Esc` 仍由 `anchored-dialog` 的座位关闭（原生行为）。
  处理时对来自触发器/翻页控件（`[data-turn-cost-pager]`）的事件让位，并 `preventDefault` 避免
  "回车把弹窗自己关掉"；整个过程包在 try/catch 里，翻页失败最多是没翻页。
* **宽度**沿用原生钳制（min 300 / max 440 / 视口 12px 边距，`useAnchoredPosition` 负责）；
  **高度**：分页模式下明细区给一个最低高度（`.detailsPaged` = 7 行 = 162px），**分页翻页过程中**
  面板高度因此稳定（每页行数实测 6–7 行，都不会顶破这个下限）。但要注意一个如实存在的差别：
  无子代理时的单页形态**没有**这条最低高度（会话口径 5 行、每轮口径 6 行），因此"有子代理 ↔ 没有
  子代理"这两种形态之间面板高度本来就不同 —— 这是分页态与非分页态的差别，不是翻页抖动。
  原生定位钩子带 `ResizeObserver`，高度变了也会重新钳制。
* **无障碍**：分页时面板的 `aria-label` 带上页码（`会话花费 2/4`），上一页/下一页按钮各有
  `aria-label`（来自字典 `cost.prevPage` / `cost.nextPage`，zh/en 成对）。

### 12.4 实现落点（纯函数，可单测）

| 文件 | 职责 | 是否纯函数 |
|---|---|---|
| `src/client/dialog-pages.ts` | 页数 `pageCount`、钳制 `clampPage`、步进 `stepPage`、循环 `cyclePage`、页码串 `pageIndicator`，以及页列表装配 `agentPages` | 是（无 React） |
| `src/client/rows.ts` | 行装配：三桶行、单代理行、总计行（含构成摘要）、归属文案、脚注 | 是（无 React） |
| `src/client/subagent-cost.ts` | 聚合切片新增 `costBuckets` / `tokBuckets` / `details`（逐代理三桶与模型）——分页要用的第二层信息；`rows` 的形状不变（列表行仍是"金额 + 归属"） | 是 |
| `src/client/CostDialog.tsx` | 只负责"选中哪一页"、翻页控件与键盘；页数据全部由调用方备好（它仍是纯展示，且弹窗渲染期异常照旧不外抛） | 组件 |

健壮性契约不变：`apply` 永不外抛、schema 永不抛错、client 注册幂等、pill 外层错误边界；弹窗内部对
非法页码/缺失页做兜底（夹取 + 空页），因此渲染期不会因为分页出现新的抛错路径。

---

## 附：非自创代码与许可（审计结论，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）

本插件**运行期零第三方代码**（`dependencies` 为空；host 产物只有相对 import；client bundle 的全部 require 恰好是平台模块表内的 4 个模块，产物内无任何内联第三方代码）。以下是**派生自 DSH 官方源码（MIT，`Copyright (c) 2026 DeepSeek`）**的部分，已按 MIT「保留版权与许可声明」的义务在 `THIRD_PARTY_NOTICES.md` 收录上游全文：

| 文件 | 上游 | 派生程度（审计实测） |
|---|---|---|
| `build/web-platform.ts` | DSH 官方 `packages/client/web/src/platform.ts` | 官方 seed 的**子集**（少 `dsh-client-ui-dockkit`），本插件只用 4 个 |
| `build/tsdown.client.ts` | DSH 官方 `packages/client/tsdown.client.ts` | 采用官方预设形态；本地 176 行（不计空行）中 **107 行与官方逐字相同**，新增/改写 69 行 |
| `src/client/dialog.module.css` | DSH 官方 `stat-dialog.module.css` | 本地 121 行（不计空行）中 **82 行逐字相同**（其中 17 行是 `}` 等纯括号行；`.panel` / `.title` / `.titleRule` / `.titleValue` / `.titleLabel` / `.details` 整块照录），新增/改写 39 行 |
| `src/client/pill.module.css` | DSH 官方 `StatsPills.module.css`、`TurnUsagePanel.module.css` | 本地 72 行（不计空行）中 **51 行与这两个官方文件逐字相同**（对 StatsPills 单独计为 39 行、对 TurnUsagePanel 单独计为 44 行），新增/改写 21 行 |
| `src/projection.ts` | DSH 官方 `token-meter/src/usage-projection.ts` | **仅语义对照，代码自写** |
| `src/client/anchored-dialog.ts` | DSH 官方 `stat-dialog.ts` | 以官方实现为蓝本改写（54 非空行中 29 行代码与上游逐字相同：图元调用、常量与 Escape 关闭）；图元调用属调用公开 API，无署名义务，此处作自愿披露 |
| `src/projection.ts`（子代理锚点）<br>`src/client/subagent-cost.ts` | DSH 官方 `subagent/catalog.ts`、`client/ui-subagent` | **仅语义对照，代码自写**：事件字段与"继承前缀守卫"参照官方目录单元；"按会话列表行的投影值聚合后代"参照官方 ui-subagent 的读法 |

除上表所列的 DSH 官方源码之外，本项目**不含任何第三方代码或素材**。

命名与品牌：`dsh-` 前缀是 `BRAND_GUIDELINES.md:8` 明确**推荐**的第三方命名方式（官方 `docs/user/develop/basic/publish.md:37` 亦以 `dsh-hello-plugin` 为例）；`:9` 禁的是 "DeepSeek Harness" 全称商标；`:10` 要求不得暗示官方背书——README 中的界面截图仅用于说明效果，已注明商标归其所有者。
