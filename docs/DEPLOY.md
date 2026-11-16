# 部署详解

本文补充 `README.md` 中未展开的部分。所有命令假设当前目录是解压后的 `netdisk-share/`。

---

## 1. 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | **≥ 18**（`node -v` 查看）。推荐 20 LTS |
| npm | 随 Node.js 安装 |
| 磁盘 | 按需；单个文件上限 20 GB |
| 内存 | 建议 ≥ 512 MB |
| 端口 | 默认 3000，可改 |

不需要数据库，不需要构建步骤，前端第三方库已本地化在 `public/vendor/`。

---

## 2. 安装

### 2.1 一键脚本

```bash
./deploy.sh
```

执行内容：检查 Node → `npm ci` → 建 `storage/` → 生成 `config.json`（随机 `sessionSecret`）→ 后台启动并生成权限为 600 的一次性初始化令牌 → 打印地址。

参数：

| 参数 | 作用 |
| --- | --- |
| `--port 8080` | 监听端口 |
| `--password 'xxx'` | 预设访问密码（scrypt 散列写入 `config.json`） |
| `--dir /srv/netdisk` | 存储目录 |
| `--no-start` | 只安装不启动 |

### 2.2 Docker Compose

```bash
docker compose up -d
docker compose logs -f
```

数据在 `./storage/`，配置与初始化令牌持久化在具名卷 `netdisk-config`（容器内 `/app/config/`）。首次启动后运行 `docker compose exec netdisk cat /app/config/.initial-setup-token` 获取令牌。**不要把宿主机尚不存在的 `config.json` 直接做成单文件 bind mount**：Docker 会自动创建一个目录挂进去，服务端写配置时会报 `EISDIR` 而启动失败。

### 2.3 Docker 单条命令

```bash
docker build -t netdisk .
docker run -d --name netdisk --restart unless-stopped \
  -p 3000:3000 \
  -v "$PWD/storage:/app/storage" \
  -v netdisk-config:/app/config \
  -e NETDISK_CONFIG=/app/config/config.json \
  -e NETDISK_PASSWORD='your-password' \
  netdisk
```

> `netdisk-config` 是具名卷，首次运行自动创建。`NETDISK_PASSWORD` 每次启动都会重设密码并作废旧会话，首次设置后建议移除并重启容器。

未设置 `NETDISK_PASSWORD` 时，可用 `docker exec netdisk cat /app/config/.initial-setup-token` 读取首次令牌；设置密码后该令牌失效并删除。

### 2.4 手动 / PM2 / systemd

手动：

```bash
npm install --omit=dev
node server.js
```

PM2：

```bash
npm i -g pm2
pm2 start server.js --name netdisk
pm2 save && pm2 startup
```

systemd（`/etc/systemd/system/netdisk.service`）：

```ini
[Unit]
Description=Netdisk
After=network.target

[Service]
Type=simple
User=netdisk
WorkingDirectory=/opt/netdisk-share
Environment=PORT=3000
Environment=NETDISK_DIR=/opt/netdisk-share/storage
ExecStart=/usr/bin/node /opt/netdisk-share/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/netdisk-share/storage

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now netdisk
sudo systemctl status netdisk
```

> `ProtectSystem=strict` 时确保 `ReadWritePaths` 覆盖了存储目录，否则上传会失败。

---

## 3. 对外暴露

### 3.1 Nginx 反代 + HTTPS（推荐）

```nginx
server {
    listen 80;
    server_name files.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name files.example.com;

    ssl_certificate     /etc/letsencrypt/live/files.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/files.example.com/privkey.pem;

    client_max_body_size 20g;
    client_body_timeout  3600s;
    proxy_read_timeout   3600s;
    proxy_send_timeout   3600s;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering off;
    }
}
```

```bash
sudo certbot --nginx -d files.example.com
```

> `client_max_body_size` 必须 ≥ 应用的上传上限（20G），否则大文件会返回 413。
> 反代部署时设置 `TRUST_PROXY=1`，`X-Forwarded-Proto: $scheme` 才会让服务端给会话 Cookie 加上 `Secure`；Instabox 环境会自动信任一跳平台代理。直连公网时不要开启该变量。

### 3.2 Caddy

```
files.example.com {
    reverse_proxy 127.0.0.1:3000
    request_body {
        max_size 20GB
    }
}
```

Caddy 自动签发并续期证书。

### 3.3 隧道

```bash
cloudflared tunnel --url http://localhost:3000
```

适合临时分享。注意 Cloudflare Quick Tunnel 的地址是公开的，所有人都能访问。

---

## 4. 密码

| 场景 | 操作 |
| --- | --- |
| 首次部署，想自己定 | 运行 `./netdisk.sh show-setup-token` 获取令牌，再在网页首次设置表单中输入令牌和新密码 |
| 部署时就想定好 | `NETDISK_PASSWORD='xxx' ./deploy.sh`（用后清理 shell 历史；`--password` 的明文还会进入进程列表） |
| 事后要改 | 登录后点工具栏「修改密码」（需填当前密码） |
| 忘了密码 | `./netdisk.sh reset-password && ./netdisk.sh restart`，然后用 `./netdisk.sh show-setup-token` 查看新令牌 |

规则：

- 长度 ≥ 6 位；
- 以 scrypt（N=16384，16 字节随机盐，64 字节输出）派生后存储，配置文件里**没有明文**；
- 修改密码会作废所有其它设备上的会话；
- 输错会递增等待（0.5→1→2→4→8 秒封顶），同 IP 累计 20 次失败封禁 15 分钟。

**分享给别人的正确姿势**：用服务器生成的一次性令牌完成密码设置（或用 `NETDISK_PASSWORD` 预设），再把「网址 + 密码」一起发出。不要分享初始化令牌。

---

## 5. 备份与迁移

```bash
# 备份（停服更稳妥）
tar -czf netdisk-backup-$(date +%F).tar.gz storage/ config.json
```

迁移到新机器：拷贝整个目录 → `./deploy.sh --password 'xxx'` → 恢复 `storage/` 与 `config.json`。若不预设密码，则保留受保护的 `.initial-setup-token` 或使用新机器首次启动生成的新令牌。

只备份数据的话，`storage/` 目录本身就是全部内容；`config.json` 只存会话密钥和密码散列，不含文件。

---

## 6. 常见故障

| 现象 | 原因 / 处理 |
| --- | --- |
| `上传失败 413` | 反代的 `client_max_body_size` 小于 20G，调大即可 |
| 上传大文件很慢 / 卡住 | 关掉 `proxy_request_buffering`，并加大各超时 |
| 登录后刷新又要求输密码 | 反代没传 `X-Forwarded-Proto`，Cookie 被当成非 HTTPS 而未带 `Secure`；或负载均衡没保持 Cookie |
| 预览 PDF 空白 | 反代禁用了 `Range` 请求，或 `proxy_buffering on` 干扰 |
| 端口被占用 | `./deploy.sh --port 8080` 或 `netdisk.sh stop` |
| `EADDRINUSE` | 同上；`ss -lntp | grep 3000` 排查占用进程 |
| 上传中断 | 检查反向代理与系统层的超时设置（见 3.1） |

---

## 7. 加固建议（面向公开服务）

1. **上 HTTPS**：明文 HTTP 下 Cookie 与文件内容都是明文。
2. **改端口**：默认 3000 容易被扫；用 `--port` 换掉。
3. **限制来源**：Nginx 加 `allow` / `deny`，或用 Cloudflare Access 之类做身份前置。
4. **定期备份 `storage/`**。
5. **限制单文件大小**：`server.js` 里 `multer` 的 `fileSize` 改成实际需要的值。
6. **不要用 root 运行**：`User=netdisk` 或普通用户。
7. **关闭目录列举以外的写权限**：`chmod 700 storage/`。
8. **反代后设置 `TRUST_PROXY=1`**：否则服务端不采信 `X-Forwarded-Proto`，HTTPS 下 Cookie 不会带 `Secure`；Instabox 自动设置一跳。直连公网时**不要**开启，否则客户端可伪造 `X-Forwarded-For` 绕过登录限流。
