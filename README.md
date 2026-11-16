# 我的云盘 · Netdisk

一个轻量、可自托管的网页网盘：上传 / 管理 / 下载文件，支持**访问密码**保护与**在线预览**（文本代码高亮、Markdown 渲染、图片、PDF）。

无需数据库、无需构建步骤：只需 **Node.js 18+** 与 npm 安装 express / multer 两个依赖；前端第三方库已全部本地化，**部署完成后无需外网**。

---

## 0. 关于密码（先看这里）

**源码里没有任何预设密码，也不含任何人的密钥或数据。**

| 项目 | 状态 |
| --- | --- |
| 预设访问密码 | **无**。首次启动生成一次性初始化令牌，持有者才能创建密码 |
| 会话密钥（`sessionSecret`） | **无**。首次启动时由程序随机生成，只存在本机 `config.json` |
| 密码存储形式 | 仅 scrypt 派生散列 + 随机盐，**不存明文** |
| 仓库内是否含任何人的数据 | **否**。不含 `storage/` 目录、不含 `config.json`、初始化令牌、`node_modules/` 或日志 |

### 部署后第一次打开会看到什么

首次启动后，在服务器上运行 `./netdisk.sh show-setup-token` 查看一次性令牌；打开网页时输入该令牌、新密码（至少 6 位）并确认，即可进入网盘。设置密码后令牌立即失效。

### 想替对方预设密码？

两种方式，任选其一（**推荐第一种**，对方无需自己创建，直接输入你给的密码即可）：

```bash
# 方式一：启动时用环境变量预设（推荐）
NETDISK_PASSWORD='你给朋友的密码' ./deploy.sh

# 方式二：先部署、启动，然后在网页里点「修改密码」设置
```

> 明文写在命令行会进入 shell 历史与进程列表；生产环境建议交互式读入，或部署后清理历史。

### ⚠️ 安全提醒

首次创建密码需要服务器生成的一次性令牌；只有能访问服务器文件或管理命令的人才能取得它。因此：

- **不要分享初始化令牌**；创建访问密码后再分享「网址 + 密码」；
- 或者用上面的 `NETDISK_PASSWORD` 预设密码后再分享；
- 忘记密码：在服务器上执行 `./netdisk.sh reset-password`，重启后用新的初始化令牌重新创建。

---

## 1. 一键部署

### 方式 A：一键脚本（Linux / macOS，推荐）

```bash
git clone https://github.com/kht174/Simple-cloud-drive.git Simple-cloud-drive   # 或解压发布包
cd Simple-cloud-drive
./deploy.sh                              # 一键：装依赖 → 建配置 → 起服务
```

> **Windows 用户**：双击 `start.bat` 即可（首次自动装依赖并前台启动）。也可以手动执行：
> ```powershell
> npm install --omit=dev
> node server.js
> ```
> 首次设置时，在另一个 PowerShell 窗口运行 `Get-Content .\.initial-setup-token` 获取令牌。
> `.sh` 脚本需要 WSL / Git Bash；`start.bat` 是原生 Windows 入口。
> 从压缩包解压（而非 `git clone`）时，Linux / macOS 下先执行一次 `chmod +x *.sh`。

脚本会自动完成：

1. 检查 Node.js 版本（需 ≥ 18）
2. `npm install --omit=dev` 安装依赖
3. 生成 `config.json`（随机 `sessionSecret`，**不含密码**）与一次性初始化令牌文件
4. 后台启动服务并写 `server.pid`
5. 打印本地访问地址和三种对外暴露方式

可选参数：

```bash
./deploy.sh --port 8080            # 换端口
./deploy.sh --dir /srv/netdisk     # 换存储目录
./deploy.sh --no-start             # 只安装不启动

# 预设密码建议用环境变量（--password 会把明文留在 shell 历史 / 进程列表）
NETDISK_PASSWORD='abc123' ./deploy.sh
```

部署完成后：

```bash
./netdisk.sh status      # 查看运行状态
./netdisk.sh restart     # 重启
./netdisk.sh stop        # 停止
./netdisk.sh reset-password   # 清除密码，下次访问重新创建
```

### 方式 B：Docker

```bash
cd netdisk-share
docker compose up -d          # 或：docker build -t netdisk . && docker run -d -p 3000:3000 -v "$PWD/storage:/app/storage" netdisk
```

数据目录 `storage/` 已用 volume 挂载，容器重建不丢文件。

### 方式 C：手动

```bash
npm install --omit=dev
node server.js                # 前台运行；Ctrl+C 退出
```

---

## 2. 把网盘暴露到公网

服务默认仅监听 `127.0.0.1:3000`；部署到容器或需要局域网访问时，显式设置 `NETDISK_HOST=0.0.0.0` 并用防火墙 / 反向代理限制访问范围。三种常见暴露方式：

**① 已有 Nginx / Caddy** —— 反代最推荐，能顺带拿到 HTTPS：

```nginx
server {
    listen 443 ssl http2;
    server_name files.example.com;
    ssl_certificate     /etc/ssl/fullchain.pem;
    ssl_certificate_key /etc/ssl/privkey.pem;

    client_max_body_size 20g;          # 与上传上限一致

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_request_buffering off;    # 大文件上传不落盘
    }
}
```

**② 隧道工具** —— 临时对外：

```bash
cloudflared tunnel --url http://localhost:3000    # Cloudflare Quick Tunnel
ssh -R 80:localhost:3000 serveo.net                # SSH 隧道
```

**③ 家用宽带** —— 需要把 3000 端口映射到公网，并自行处理 TLS。

> 生产环境建议用 Nginx/Caddy + Let's Encrypt。Instabox 环境会自动信任一跳平台代理；其他反代部署需显式设置 `TRUST_PROXY=1`。直连公网时不要开启，以免客户端伪造转发头绕过登录限流。

---

## 3. 功能一览

| 功能 | 说明 |
| --- | --- |
| 上传 | 拖拽或点选，多选，单文件上限 20 GB，单批 100 个 |
| 下载 | 单文件下载，保留原文件名 |
| 目录 | 新建 / 重命名 / 删除文件夹，路径面包屑导航 |
| 搜索 | 当前文件夹内按文件名过滤 |
| 访问密码 | 全站保护，需服务器一次性令牌完成首次创建，网页内可随时修改 |
| 在线预览 | 文本/代码高亮、Markdown 渲染、图片、PDF |
| 会话 | 12 小时有效，「退出」按钮立即清除本机状态 |

### 在线预览支持范围

| 类型 | 扩展名 | 渲染方式 |
| --- | --- | --- |
| 文本 / 代码 | `md` `markdown` `json` `xml` `html` `yaml` `toml` `ini` `css` `js` `jsx` `ts` `tsx` `java` `kt` `smali` `py` `rb` `go` `rs` `c` `cpp` `h` `cs` `php` `sh` `bash` `ps1` `sql` `gradle` `dockerfile` `makefile` `diff` `patch` `properties` `csv` `log` `txt` 等约 90 种（高亮覆盖内置 36 种语言，其余按纯文本展示） | [highlight.js](https://highlightjs.org) 语法高亮；Markdown 额外用 [marked](https://marked.js.org) 渲染（表格 / 代码块 / 引用 / 列表） |
| 图片 | `png` `jpg` `jpeg` `gif` `webp` `bmp` `ico` | 居中展示 |
| PDF | `pdf` | 浏览器内置阅读器，可翻页 / 缩放 / 打印 |

不支持的类型（如 `apk`、`docx`、`zip`）会提示"不支持在线预览"，但仍可下载。

预览页提供 **「复制」** 和 **「自动换行」** 两个辅助按钮。

---

## 4. 目录结构

```
netdisk-share/
├── deploy.sh              一键部署脚本（Linux / macOS）
├── start.bat              Windows 一键启动
├── uninstall.sh           卸载脚本
├── netdisk.sh             服务管理（start/stop/restart/status/reset-password）
├── server.js              服务端（Express）
├── package.json
├── package-lock.json
├── config.example.json    配置示例（含全部字段说明，无真实值）
├── Dockerfile
├── docker-compose.yml
├── .gitignore
├── .dockerignore
├── LICENSE                MIT 许可证
├── licenses/              第三方组件许可证全文与 NOTICE.txt
├── public/
│   ├── index.html         网盘主页面
│   ├── preview.html       在线预览页
│   └── vendor/            本地化的第三方库
│       ├── highlight.min.js   highlight.js 11.9.0 (BSD-3)
│       ├── marked.min.js      marked 4.3.0 (MIT)
│       ├── purify.min.js      DOMPurify 3.2.6 (Apache-2.0 / MPL-2.0)
│       └── github.min.css     highlight.js github 主题 (BSD-3)
├── docs/
│   ├── DEPLOY.md          部署详解（反向代理、HTTPS、开机自启、备份）
│   └── API.md             HTTP 接口说明
└── storage/               ← 你的文件（首次启动自动创建，勿提交到版本库）
```

---

## 5. 配置

`config.json` 首次启动时自动生成，权限 600。示例见 `config.example.json`：

| 字段 | 说明 |
| --- | --- |
| `sessionSecret` | 会话令牌签名密钥，随机生成，**不要泄露** |
| `passwordVersion` | 密码版本号，改密码后自增，用于作废旧会话 |
| `passwordSalt` | 密码散列盐值 |
| `passwordHash` | scrypt 派生的密码散列（**不是明文**） |
| `setupTokenHash` | 首次设置令牌的 SHA-256 散列；完成密码设置后删除 |

环境变量覆盖：

| 变量 | 说明 |
| --- | --- |
| `PORT` | 监听端口，默认 `3000` |
| `NETDISK_PASSWORD` | 每次启动都重设访问密码并作废旧会话（建议只在首次部署设置，之后移除） |
| `NETDISK_DIR` | 文件存储根目录，默认 `./storage` |
| `NETDISK_HOST` | 监听地址，默认 `127.0.0.1`；容器/局域网部署通常设为 `0.0.0.0` |
| `NETDISK_CONFIG` | 配置文件路径，默认 `./config.json`（Docker 用具名卷时需要） |
| `TRUST_PROXY` / `NETDISK_TRUST_PROXY` | 可信代理跳数或地址，如 `1`。Instabox 自动设置一跳；其他环境默认关闭，不采信 `X-Forwarded-*` |
| `INSTABOX_TERM_SESSION` / `INSTABOX_TERM_DIR` | Instabox 环境标记；识别到任一非空值时自动信任一跳平台代理 |

首次设置令牌保存在配置文件同目录的 `.initial-setup-token`（Unix-like 系统权限 600；Windows 继承目录权限）。Docker Compose 默认使用具名卷，可运行 `docker compose exec netdisk cat /app/config/.initial-setup-token` 查看；密码设置成功后令牌文件会删除。不要将令牌或 `netdisk.env` 提交或分享。

---

## 6. 安全设计

- **路径穿越防护**：所有路径经 `resolvePath()` 归一化 + `realpath` 校验（含符号链接），越界请求返回 400；非字符串参数与 NUL 字节一并拒绝。
- **文件名校验**：拒绝 `/`、`\`、`.`、`..`、控制字符、尾随点/空格、Windows 设备名、空名、超长名；上传时只取 basename。
- **密码处理**：scrypt（N=16384）派生散列；`crypto.timingSafeEqual` 常量时间比较；不落明文。
- **登录节流**：输错递增等待 0.5 → 1 → 2 → 4 → 8 秒（封顶），同 IP 累计 20 次失败硬封禁 15 分钟；限流键默认取 TCP 层地址，客户端无法伪造 `X-Forwarded-For` 绕过。
- **会话**：HMAC-SHA256 签名的无状态令牌，12 小时有效，`HttpOnly` + `SameSite=Lax`，HTTPS 下自动 `Secure`。
- **改密即失效**：密码版本号自增（含环境变量重设密码），所有旧设备会话立刻作废。
- **CSRF**：写操作校验 `Origin` 与 `Host` 一致，补上 `SameSite=Lax` 挡不住的同站跨端口场景。
- **XSS 防护**：`html` / `svg` 等可执行内容一律以 `text/plain` 返回；Markdown 渲染前经 DOMPurify 净化（marked 默认会透传原始 HTML 与 `javascript:` 链接）；响应带 `X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`。
- **上传限制**：单文件 20 GB、单批 100 个文件。

---

## 7. 常见问题

**Q：朋友打开网址提示「创建访问密码」，还需要什么？**
首次设置需要服务器上的一次性初始化令牌。运行 `./netdisk.sh show-setup-token` 获取；不要将令牌分享给他人。也可以通过 `NETDISK_PASSWORD` 预设密码。

**Q：忘记密码怎么办？**
服务器上执行 `./netdisk.sh reset-password && ./netdisk.sh restart`，然后重新访问网页创建新密码。

**Q：怎么备份？**
停服后直接备份 `storage/` 目录即可（配置在 `config.json`，可单独保留）。

**Q：能改成中文以外的语言吗？**
可以，界面文案直接改 `public/index.html` 与 `public/preview.html` 里的中文字符串。

**Q：端口被占用？**
`./deploy.sh --port 8080` 换端口，或 `./netdisk.sh stop` 后重启。

---

## 8. 许可与第三方组件

本项目采用 **MIT** 许可，全文见 [LICENSE](LICENSE)。内置第三方组件均已本地化于 `public/vendor/`，许可证全文见 [`licenses/NOTICE.txt`](licenses/NOTICE.txt)：

| 组件 | 版本 | 许可 | 许可证全文 |
| --- | --- | --- | --- |
| [highlight.js](https://highlightjs.org) | 11.9.0 | BSD-3-Clause | `licenses/LICENSE-highlightjs.txt` |
| [marked](https://marked.js.org) | 4.3.0 | MIT | `licenses/LICENSE-marked.txt` |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.2.6 | Apache-2.0 / MPL-2.0 | `licenses/LICENSE-dompurify.txt` |
| [highlight.js github 主题](https://github.com/highlightjs/highlight.js/tree/main/src/styles) | 11.9.0 | BSD-3-Clause | `licenses/LICENSE-highlightjs.txt` |
| [Express](https://expressjs.com) | 4.x | MIT | npm 包内自带 |
| [multer](https://github.com/expressjs/multer) | 2.x | MIT | npm 包内自带 |

---

## 9. 已知限制

- 单密码、单用户模型：没有账号体系、权限分级、分享链接与审计日志，适合个人或小范围临时共享。
- 首次创建密码必须持有服务器一次性令牌；令牌文件位于配置文件同目录，权限为 600，设置成功后删除。
- 默认 HTTP 明文：Cookie 与文件内容在公网传输前请务必配 HTTPS。
- 大文件上传不校验磁盘剩余空间，也不做断点续传。
- 网盘内可存放任意文件；预览时不会主动执行文件内容，但下载后的文件由使用者自行负责。
