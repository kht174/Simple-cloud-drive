#!/usr/bin/env bash
#
# 我的云盘 · 一键部署
#
#   ./deploy.sh                          # 默认：装依赖 → 建配置 → 后台启动
#   ./deploy.sh --port 8080              # 换端口
#   ./deploy.sh --password 'xxx'        # 预设密码（明文留痕，建议用 NETDISK_PASSWORD）
#   ./deploy.sh --dir /srv/netdisk       # 换存储目录
#   ./deploy.sh --no-start               # 只安装不启动
#   ./deploy.sh --help
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PORT="${PORT:-3000}"
STORAGE_DIR="$SCRIPT_DIR/storage"
CONFIG_FILE="${NETDISK_CONFIG:-config.json}"
PRESET_PASSWORD="${NETDISK_PASSWORD:-}"
DO_START=1
NODE_MIN_MAJOR=18

C_RED=$'\033[0;31m'; C_GRN=$'\033[0;32m'; C_YEL=$'\033[0;33m'; C_BLU=$'\033[0;34m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
info() { printf "${C_BLU}==>${C_OFF} %s\n" "$*"; }
ok()   { printf "${C_GRN}  ✓${C_OFF} %s\n" "$*"; }
warn() { printf "${C_YEL}  !${C_OFF} %s\n" "$*"; }
die()  { printf "${C_RED}  ✗${C_OFF} %s\n" "$*" >&2; exit 1; }

usage() {
  sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)      PORT="$2"; shift 2 ;;
    --password)  PRESET_PASSWORD="$2"; shift 2 ;;
    --dir)       STORAGE_DIR="$2"; shift 2 ;;
    --no-start)  DO_START=0; shift ;;
    --help|-h)   usage ;;
    *) die "未知参数: $1（用 --help 查看用法）" ;;
  esac
done

printf "${C_BLU}███ 我的云盘 · 一键部署 ███${C_OFF}\n\n"

# ---------------------------------------------------------------- 1. 环境检查
info "检查运行环境"

command -v node >/dev/null 2>&1 || die "未找到 node，请先安装 Node.js ${NODE_MIN_MAJOR}+（https://nodejs.org/）"
NODE_VERSION="$(node -v)"
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | sed 's/^v//; s/\..*//')"
if [[ "$NODE_MAJOR" -lt "$NODE_MIN_MAJOR" ]]; then
  die "Node.js 版本过低（当前 $NODE_VERSION，需要 >= $NODE_MIN_MAJOR）"
fi
ok "Node.js $NODE_VERSION"

command -v npm >/dev/null 2>&1 || die "未找到 npm（通常随 Node.js 一起安装）"
ok "npm $(npm -v)"

if [[ -f "$CONFIG_FILE" ]] && grep -q '"passwordHash"' "$CONFIG_FILE" 2>/dev/null; then
  warn "检测到已存在的 config.json，将保留现有密码与会话密钥"
fi

# ---------------------------------------------------------------- 2. 安装依赖
info "安装依赖（express / multer）"
if [[ -d node_modules ]] && [[ -f node_modules/.package-lock.json ]]; then
  ok "依赖已存在，跳过安装（如需重装：rm -rf node_modules && ./deploy.sh）"
else
  if [[ -f package-lock.json ]]; then
    npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
  else
    npm install --omit=dev --no-audit --no-fund
  fi
  ok "依赖安装完成"
fi

# ---------------------------------------------------------------- 3. 存储目录
info "准备存储目录"
mkdir -p "$STORAGE_DIR"
STORAGE_ABS="$(cd "$STORAGE_DIR" && pwd)"
chmod 700 "$STORAGE_ABS" 2>/dev/null || true
ok "存储目录: $STORAGE_ABS"

# ---------------------------------------------------------------- 4. 配置文件
info "生成配置"
if [[ ! -f "$CONFIG_FILE" ]]; then
  node -e "
    const fs = require('fs'), crypto = require('crypto'), path = require('path');
    const p = process.env.NETDISK_CONFIG || 'config.json';
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const cfg = {
      sessionSecret: crypto.randomBytes(32).toString('hex'),
      passwordVersion: 1,
    };
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
    fs.chmodSync(p, 0o600);
  "
  ok "已生成 config.json（随机会话密钥，权限 600）"
else
  ok "config.json 已存在，保留"
fi

if [[ -n "$PRESET_PASSWORD" ]]; then
  warn "命令行传密码会留在 shell 历史与进程列表，建议改用 NETDISK_PASSWORD 环境变量"
  node -e "
    const fs = require('fs'), crypto = require('crypto');
    const p = process.env.NETDISK_CONFIG || 'config.json';
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    const salt = crypto.randomBytes(16).toString('hex');
    cfg.passwordSalt = salt;
    cfg.passwordHash = crypto.scryptSync(process.argv[1], salt, 64).toString('hex');
    cfg.passwordVersion = (cfg.passwordVersion || 1) + 1;
    delete cfg.password;
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  " "$PRESET_PASSWORD"
  ok "已预设访问密码（以 scrypt 散列存储，不含明文）"
else
  ok "未预设密码 —— 首次打开网页时会提示创建"
fi

# ---------------------------------------------------------------- 5. 启动
if [[ "$DO_START" -eq 0 ]]; then
  info "按要求跳过启动。手动启动：./netdisk.sh start"
  exit 0
fi

info "启动服务"
if [[ -f server.pid ]] && kill -0 "$(cat server.pid)" 2>/dev/null; then
  kill "$(cat server.pid)" 2>/dev/null || true
  sleep 1
fi

PORT="$PORT" NETDISK_DIR="$STORAGE_ABS" nohup node server.js >> server.log 2>&1 &
echo $! > server.pid
sleep 2

if ! kill -0 "$(cat server.pid)" 2>/dev/null; then
  warn "启动失败，日志尾部："
  tail -20 server.log >&2
  exit 1
fi

ok "服务已启动 (pid $(cat server.pid))"

# ---------------------------------------------------------------- 6. 结果
printf "\n${C_GRN}部署完成${C_OFF}\n\n"
printf "  ${C_BLU}本地访问${C_OFF}   http://127.0.0.1:%s\n" "$PORT"
printf "  ${C_BLU}局域网访问${C_OFF} http://<本机内网IP>:%s\n" "$PORT"
printf "  ${C_BLU}存储目录${C_OFF}   %s\n" "$STORAGE_ABS"
printf "  ${C_BLU}配置文件${C_OFF}   %s\n\n" "$CONFIG_FILE"

cat <<EOF
${C_DIM}对外暴露（选一种）：${C_OFF}
  1) Nginx / Caddy 反代到 127.0.0.1:${PORT}，并配 HTTPS   → 见 docs/DEPLOY.md
  2) 隧道：cloudflared tunnel --url http://localhost:${PORT}
  3) 端口映射：把 ${PORT} 映射到公网（请自行配 TLS）

${C_DIM}常用命令：${C_OFF}
  ./netdisk.sh status | restart | stop | reset-password
EOF
printf "${C_YEL}  重要：第一个访问该网址的人会成为密码持有者。${C_OFF}\n"
printf "${C_DIM}  分享给别人之前请先自己打开网页创建密码，或用 ./deploy.sh --password 'xxx' 预设。${C_OFF}\n"
