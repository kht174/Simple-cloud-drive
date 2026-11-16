#!/usr/bin/env bash
# 网盘服务管理：start | stop | restart | status
set -euo pipefail
cd "$(dirname "$0")"

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
      console.log(c.passwordHash ? '访问密码: 已设置（可在网页内修改）' : '访问密码: 未设置，首次访问网页时创建');
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
  "
  echo "已清除访问密码，下次访问网页将重新提示创建"
  if is_running; then
    echo "正在重启服务使改动生效…"
    stop; sleep 1; start
  fi
}

case "${1:-start}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 1; start ;;
  reset-password) reset_password ;;
  status)
    if is_running; then echo "运行中 (pid $(cat "$PID_FILE"))"; else echo "未运行"; fi
    ;;
  *) echo "用法: $0 {start|stop|restart|status|reset-password}"; exit 1 ;;
esac
