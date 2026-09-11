#!/bin/bash
# dsh-turn-cost —— 构建前置：把开发期依赖从 DSH checkout 链接进本包的 node_modules，
# 然后做一次全量类型检查（tsc --noEmit，产物由 tsdown 生成）。
#
# 设计要点：
#   * 本插件**没有任何运行时依赖**（host 半只 import type；client 半只用 DSH 客户端
#     平台模块表里的 react / ui-primitives）。这里链接的包全部只服务于"构建与类型检查"。
#   * DSH_CHECKOUT 由环境变量给出；未给出时依次探测常见路径，全部失败则明确报错退出。
#   * 幂等：每次重建链接（先删后建），不会因为上一次的残留而失败。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ---------------------------------------------------------------- checkout 探测
detect_checkout() {
  local candidates=(
    "${DSH_CHECKOUT:-}"
    "/mnt/e/DeepSeekHarness/DSH"
    "$HOME/DeepSeekHarness/DSH"
    "$HOME/.dsh/checkout"
    "/opt/dsh"
    "$ROOT/../DSH"
  )
  local c
  for c in "${candidates[@]}"; do
    [ -n "$c" ] && [ -d "$c/packages" ] && [ -f "$c/package.json" ] && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}

CHECKOUT="$(detect_checkout || true)"
if [ -z "${CHECKOUT}" ]; then
  echo "build: 找不到 DSH checkout（请设置 DSH_CHECKOUT=/path/to/DSH）" >&2
  exit 1
fi
echo "=== dsh-turn-cost build (checkout: $CHECKOUT) ==="

# ------------------------------------------------------------------- 链接工具
link() { # link <包内相对路径> <checkout 内相对路径>
  local linkPath="node_modules/$1"
  local target="$CHECKOUT/$2"
  if [ ! -e "$target" ]; then
    echo "build: 依赖目标缺失: $target" >&2
    return 1
  fi
  node -e "
    const fs = require('node:fs');
    const path = require('node:path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "$linkPath" "$target"
}

# pnpm 虚拟店里的包：按名字前缀找第一个（对版本漂移免疫）。
link_pnpm() { # link_pnpm <包内相对路径> <store 目录名 glob 前缀>
  local linkPath="node_modules/$1"
  local found
  found="$(find "$CHECKOUT/node_modules/.pnpm" -maxdepth 1 -type d -name "$2" 2>/dev/null | sort | tail -1)"
  if [ -z "$found" ]; then
    echo "build: pnpm store 中找不到 $2" >&2
    return 1
  fi
  local target="$found/node_modules/$1"
  if [ ! -e "$target" ]; then
    echo "build: 依赖目标缺失: $target" >&2
    return 1
  fi
  node -e "
    const fs = require('node:fs');
    const path = require('node:path');
    const link = path.resolve(process.argv[1]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.resolve(process.argv[2]), link, process.platform === 'win32' ? 'junction' : 'dir');
  " "$linkPath" "$target"
}

echo "--- linking build-time dependencies ---"
link typescript node_modules/typescript
link tsdown node_modules/tsdown
link lightningcss node_modules/lightningcss
link_pnpm react 'react@18*'
link_pnpm react-dom 'react-dom@18*'
link_pnpm @types/react '@types+react@18*'
link_pnpm @types/react-dom '@types+react-dom@18*'
link_pnpm @types/node '@types+node@*'
link_pnpm zod 'zod@4*'

# 类型来源（全部 type-only：构建期擦除，不进产物、不是运行时依赖）
link @deepseek-ai/cordis vendor/cordis
link @deepseek-ai/dsh-session packages/core/session
link @deepseek-ai/dsh-session-projection packages/session/session-projection
link @deepseek-ai/dsh-client-store packages/client/store
link @deepseek-ai/dsh-client-locale packages/client/locale
link @deepseek-ai/dsh-client-ui-slots packages/client/ui-slots
link @deepseek-ai/dsh-client-ui-session packages/client/ui-session
link @deepseek-ai/dsh-client-ui-primitives packages/client/ui-primitives
link @deepseek-ai/dsh-client-ui-renderer packages/client/ui-renderer
link @deepseek-ai/dsh-client-ui-chat packages/client/ui-chat
link @deepseek-ai/dsh-client-ui-conversation packages/client/ui-conversation

echo "--- typecheck (tsc --noEmit) ---"
"$CHECKOUT/node_modules/.bin/tsc" -p tsconfig.json --noEmit

echo "=== build.sh done (next: tsdown) ==="
