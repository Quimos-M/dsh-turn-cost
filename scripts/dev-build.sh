#!/usr/bin/env bash
# 本插件的开发构建入口（必须在 WSL 内运行）。
# 用法：bash scripts/dev-build.sh        （或从 Windows 侧跑 scripts/build-windows.ps1）
#
# 为什么在 WSL：构建工具链（typescript / tsdown / lightningcss）装在 DSH checkout 里，
# 且 lightningcss 只带 Linux 原生二进制；client bundle 的 CSS Modules 内联依赖它。
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
export DSH_CHECKOUT="${DSH_CHECKOUT:-/mnt/e/DeepSeekHarness/DSH}"
echo "=== 1/3 建链接 + 类型检查（tsc strict）==="
bash scripts/build.sh
echo "=== 2/3 打包 host 半与 client 半（tsdown）==="
node "$DSH_CHECKOUT/node_modules/tsdown/dist/run.mjs"
echo "=== 3/3 单测 ==="
node --test tests/*.test.mjs