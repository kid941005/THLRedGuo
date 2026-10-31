#!/usr/bin/env bash
#
# 启用仓库内置的 git 钩子（core.hooksPath 指向 .githooks）。
# 幂等：可重复执行。克隆仓库后跑一次即可。

set -e

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

git config core.hooksPath .githooks
chmod +x .githooks/* 2>/dev/null || true

echo "已启用 .githooks（core.hooksPath = $(git config core.hooksPath)）"
echo "钩子文件：$(ls .githooks | tr '\n' ' ')"
echo "临时跳过：git commit --no-verify"
