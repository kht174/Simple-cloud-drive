#!/usr/bin/env bash
# 网盘服务管理：start | stop | restart | status
set -euo pipefail
cd "$(dirname "$0")"
umask 077

if [[ -f netdisk.env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./netdisk.env
  set +a
fi

if [[ -n "${INSTABOX_TERM_SESSION:-}${INSTABOX_TERM_DIR:-}" &&
      -z "${TRUST_PROXY:-}" && -z "${NETDISK_TRUST_PROXY:-}" ]]; then
  export NETDISK_TRUST_PROXY=1
  printf '\nNETDISK_TRUST_PROXY=1\n' >> netdisk.env
  chmod 600 netdisk.env
fi

PID_FILE=server.pid
LOG_FILE=server.log

is_running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

stop() {
  if is_running; then
    kill "$(cat "$PID_FILE")" && echo "已停止"
  else
    echo "未在运行"
  fi
  rm -f "$PID_FILE"
}

start() {
  if is_running; then
    echo "已在运行 (pid $(cat "$PID_FILE"))"
    return 0
  fi
  nohup node server.js >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 1
  if is_running; then
    echo "已启动 (pid $(cat "$PID_FILE"))"
    node -e "
      const fs = require('fs');
      const p = process.env.NETDISK_CONFIG || 'config.json';
      let c = {};
      try { c = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {}
      const passwordSet = Boolean(c.passwordHash && c.passwordSalt);
      console.log(passwordSet ? '访问密码: 已设置（可在网页内修改）' : '访问密码: 未设置，请使用服务器的一次性初始化令牌创建');
      if (!passwordSet) console.log('首次设置令牌: ./netdisk.sh show-setup-token（创建密码后失效）');
    "
  else
    echo "启动失败，日志:"; tail -20 "$LOG_FILE"; exit 1
  fi
}

reset_password() {
  node -e "
    const fs = require('fs');
    const p = process.env.NETDISK_CONFIG || 'config.json';
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    delete c.passwordHash;
    delete c.passwordSalt;
    delete c.password;
    c.passwordVersion = (c.passwordVersion || 1) + 1;
    fs.writeFileSync(p, JSON.stringify(c, null, 2) + '\n');
    fs.chmodSync(p, 0o600);
  "
  echo "已清除访问密码，下次访问网页将重新提示创建"
  if is_running; then
    echo "正在重启服务使改动生效…"
    stop; sleep 1; start
  fi
}

show_setup_token() {
  local config_path token_path
  config_path="$(node -p "require('path').resolve(process.env.NETDISK_CONFIG || 'config.json')")"
  token_path="$(dirname "$config_path")/.initial-setup-token"
  if [[ ! -f "$token_path" ]]; then
    echo "当前没有有效的首次设置令牌（可能已设置访问密码）。" >&2
    return 1
  fi
  cat "$token_path"
}

case "${1:-start}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 1; start ;;
  reset-password) reset_password ;;
  show-setup-token) show_setup_token ;;
  status)
    if is_running; then echo "运行中 (pid $(cat "$PID_FILE"))"; else echo "未运行"; fi
    ;;
  *) echo "用法: $0 {start|stop|restart|status|reset-password|show-setup-token}"; exit 1 ;;
esac
