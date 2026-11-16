#!/usr/bin/env bash
#
# 我的云盘 · 卸载
#
#   ./uninstall.sh              停服务并删除程序文件，保留 storage/ 数据
#   ./uninstall.sh --purge      连同 storage/ 数据与 config.json 一起删除（不可恢复）
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1

C_YEL=$'\033[0;33m'; C_RED=$'\033[0;31m'; C_OFF=$'\033[0m'

if [[ -f server.pid ]] && kill -0 "$(cat server.pid)" 2>/dev/null; then
  kill "$(cat server.pid)" 2>/dev/null || true
  sleep 1
  echo "已停止服务"
fi
rm -f server.pid

if [[ "$PURGE" -eq 1 ]]; then
  CONFIG_FILE="${NETDISK_CONFIG:-config.json}"
  echo "${C_RED}将删除: storage/ (你的全部文件) 与 $CONFIG_FILE${C_OFF}"
  read -r -p "确认删除？(yes/no) " ans
  if [[ "$ans" == "yes" ]]; then
    rm -rf storage node_modules server.log
    if [[ "$CONFIG_FILE" = /* ]]; then
      echo "配置文件为绝对路径，未自动删除，请自行处理: $CONFIG_FILE"
    else
      rm -f "$CONFIG_FILE"
    fi
    echo "已彻底卸载（含数据）"
  else
    echo "已取消"
  fi
else
  rm -rf node_modules server.log
  echo "已卸载程序，保留了 storage/ 与 config.json"
  echo "如需彻底清除：./uninstall.sh --purge"
fi
