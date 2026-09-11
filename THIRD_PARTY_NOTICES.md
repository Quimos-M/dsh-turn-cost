# 第三方代码与许可声明（THIRD_PARTY_NOTICES）

本插件**运行期无非官方第三方代码**：`dependencies` 为空；host 半产物只有相对 import；`lib/client.js` 的全部 `require` 均是客户端平台模块表内的 `react` / `react-dom` / `react/jsx-runtime` / `@deepseek-ai/dsh-client-ui-primitives`（由宿主注入共享实例，未内联进产物）。

## 派生自 DSH 官方源码的文件（MIT，`Copyright (c) 2026 DeepSeek`）

| 本插件文件 | 上游 | 派生程度 |
|---|---|---|
| `build/tsdown.client.ts` | DSH 官方 `packages/client/tsdown.client.ts` | 采用官方打包预设的形态（闭包工厂外壳、CSS Modules 内联、externals/纯度门）；按本插件需要删减 |
| `build/web-platform.ts` | DSH 官方 `packages/client/web/src/platform.ts` | 官方 seed 表的**子集**（本插件只用到 4 个模块） |
| `src/client/dialog.module.css` | DSH 官方 `packages/client/ui-chat/src/client/chat/stat-dialog.module.css` | 样式度量与结构照录（如 `.panel` / `.title` / `.details`），配色一律走官方主题变量 |
| `src/client/pill.module.css` | DSH 官方 `StatsPills.module.css`、`TurnUsagePanel.module.css` | 同上 |
| `src/projection.ts` | DSH 官方 `packages/llm/token-meter/src/usage-projection.ts` | **仅语义对照**（同 `(turn, step)` 替换、`llm/retry-started` 清槽），代码自写 |
| `src/projection.ts`（子代理锚点） | DSH 官方 `packages/subagent/subagent/src/catalog.ts` | **仅语义对照**（`subagent/catalog` 事件字段、以及"继承前缀里的目录事实不属于本会话"的守卫），代码自写 |
| `src/client/subagent-cost.ts` | DSH 官方 `packages/client/ui-subagent`（`subagent-lineage.ts` / `SubagentHeaderLineage.tsx`） | **仅语义对照**（沿用"按 `origin === 'subagent'` + `parentId` 回溯后代"与"读会话列表行的投影值"这两条官方读法），代码自写 |
| `src/client/anchored-dialog.ts` | DSH 官方 `stat-dialog.ts` | 以官方实现为蓝本改写：座位骨架与公开图元调用、`PANEL_MARGIN`/`PANEL_GAP`/`MEASURE_STYLE`、Escape 关闭逻辑照录（54 非空行中 29 行代码与上游逐字相同），其余自写；图元调用本身属调用公开 API |

## 命名与品牌

插件名 `dsh-turn-cost` 使用 DSH 官方 `BRAND_GUIDELINES.md` 明确推荐的 "DSH" 缩写；本项目与 DeepSeek / DeepSeek Harness 官方**无隶属、合作或背书关系**；README 中的界面截图仅用于说明插件效果，相关商标归其所有者。

## 上游许可全文

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
