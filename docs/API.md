# HTTP 接口说明

所有接口返回 JSON；错误形如 `{ "ok": false, "error": "错误说明" }`。
除 `/api/login`、`/api/session` 外，均需带会话 Cookie。首次启动需提供服务器生成的一次性令牌创建管理员；管理员创建普通账户，不开放自助注册。

会话 Cookie：`nd_sess`，`HttpOnly`，`SameSite=Lax`，HTTPS 下带 `Secure`，有效期 12 小时。

---

## 认证

### `GET /api/session`

查询当前状态，无需认证。

```json
{
  "ok": true,
  "authenticated": false,
  "passwordSet": true,
  "requiresPassword": true,
  "user": null
}
```

| 字段 | 说明 |
| --- | --- |
| `authenticated` | 当前 Cookie 是否有效 |
| `passwordSet` | 是否已创建管理员账户。`false` 表示需要管理员初始化 |
| `user` | 当前会话用户；未登录时为 `null` |

### `POST /api/login`

```json
{ "username": "alice", "password": "你的密码" }
```

成功：`200` + `Set-Cookie: nd_sess=...`，响应包含公开的用户 ID、用户名和角色。省略用户名时登录管理员账户（兼容旧客户端）。

| 状态码 | 场景 | 响应 |
| --- | --- | --- |
| 200 | 成功 | `{ "ok": true, "expiresIn": 43200000, "user": { "id": "…", "username": "alice", "role": "user" } }` |
| 401 | 密码错误 | `{ "ok": false, "error": "密码错误" }`（含 `retryAfterMs` 建议等待时长） |
| 409 | 尚未创建管理员 | `{ "ok": false, "error": "尚未创建管理员账户", "needSetup": true }` |
| 429 | 触发封禁 | `{ "ok": false, "error": "尝试次数过多，请稍后再试" }` |

### `POST /api/password`

首次启动时创建管理员账户或修改当前登录账户的密码。初始化令牌保存在配置文件同目录的 `.initial-setup-token`，创建管理员后立即失效并删除。

```json
{ "username": "owner", "setupToken": "首次设置令牌", "newPassword": "新密码" }
```

- **首次创建管理员**：需 `username`、`setupToken` 与 `newPassword`（≥ 6 位）。
- **修改当前账户密码**：需已登录并提供正确的 `currentPassword`；仅当前账户的旧会话失效。

成功：`200`，同时下发新的 `Set-Cookie`。

| 状态码 | 场景 |
| --- | --- |
| 400 | 新密码过短 / 与当前密码相同 |
| 401 | 修改时未登录 |
| 403 | 初始化令牌无效 / 当前密码不正确 |
| 409 | 初始化用户名已存在 |

### `POST /api/logout`

清除本机会话 Cookie。

## 用户管理（仅管理员）

### `GET /api/users`

列出用户的 ID、用户名和角色，不返回密码散列。
响应中的 `storageMode` 为 `isolated` 或 `shared`。

### `POST /api/users`

```json
{ "username": "alice", "password": "至少 6 位", "storageMode": "isolated" }
```

创建普通用户。用户名为 1-32 位 Unicode 字母/数字或 `._-` 字符，忽略大小写判重。`storageMode` 可选 `isolated`（默认，独立目录）或 `shared`（与管理员共用 `storage/`）。成功返回 `201`。

### `DELETE /api/users/:id`

删除普通用户；不能删除管理员账户。删除隔离模式账户时，其文件一并删除且不可恢复；共享模式只删除账户，不删除共享文件。

---

## 文件操作（均需登录）

### `GET /api/list?path=<相对路径>`

`path` 为空表示当前用户可访问的根目录。独立用户使用各自目录；共享模式用户与管理员共用文件和用量统计。

```json
{
  "path": "sub",
  "breadcrumb": [{ "name": "我的云盘", "path": "" }, { "name": "sub", "path": "sub" }],
  "entries": [
    { "name": "a.txt", "type": "file", "size": 1024, "mtime": 1730000000000, "preview": "text" },
    { "name": "dir", "type": "dir", "size": 0, "mtime": 1730000000000, "preview": null }
  ]
}
```

`preview` 字段：`text` / `image` / `pdf` / `null`（null 表示不支持在线预览），前端据此显示预览按钮。

### `GET /api/stats`

```json
{ "bytes": 123456, "files": 42 }
```

### `GET /api/download?path=<相对路径>`

返回文件内容，`Content-Disposition: attachment`。

### `GET /api/preview?path=<相对路径>`

在线预览。响应头：

| 头 | 说明 |
| --- | --- |
| `X-Preview-Kind` | `text` / `image` / `pdf` |
| `X-Preview-Ext` | 不带点的扩展名，如 `java`、`md` |
| `Content-Type` | 文本为 `text/plain; charset=utf-8`；图片为对应 `image/*`；PDF 为 `application/pdf` |

文本直接以 `text/plain` 返回（不是 HTML），由前端 `preview.html` 负责高亮与 Markdown 渲染。

不支持的类型返回 200 + 提示文本；超过 4 MiB 返回 413。

### `POST /api/upload?path=<相对目录>`

`multipart/form-data`，字段名 `files`，可重复。单文件 ≤ 20 GB，单批 ≤ 100 个。

```json
{ "ok": true, "files": [{ "name": "a.txt", "size": 1024 }] }
```

### `POST /api/mkdir`

```json
{ "path": "", "name": "新建文件夹" }
```

### `POST /api/rename`

```json
{ "path": "old.txt", "name": "new.txt" }
```

### `POST /api/delete`

```json
{ "path": "old.txt" }
```

---

## 错误码

| 状态码 | 含义 |
| --- | --- |
| 400 | 参数不合法、路径越界、文件夹不存在 |
| 401 | 未登录 / 需要访问密码（响应含 `authRequired: true`） |
| 403 | 当前密码不正确 / 非管理员访问用户管理接口 |
| 404 | 文件或文件夹不存在 |
| 409 | 同名资源已存在 / 用户名已存在 / 尚未创建管理员（仅登录接口） |
| 413 | 文件过大，无法预览 |
| 429 | 登录尝试过于频繁 |
| 500 | 服务器内部错误 |

---

## 静态页面

| 路径 | 说明 |
| --- | --- |
| `/` | 网盘主页面（`public/index.html`） |
| `/preview.html?path=<相对路径>` | 在线预览页（`public/preview.html`） |
| `/vendor/*` | 本地化的 highlight.js / marked / DOMPurify / 主题 |

---

## 安全约定

- 所有写操作（`POST` / `PUT` / `PATCH` / `DELETE`）校验请求头 `Origin` 与 `Host` 一致；浏览器同源请求自动满足，curl 等不带 `Origin` 的请求不受影响。
- 默认不信任代理：登录限流按 TCP 层来源地址统计。Instabox 自动信任一跳平台代理；其他反代部署显式设置 `TRUST_PROXY=1`，此时才采信 `X-Forwarded-For` / `X-Forwarded-Proto` / `X-Forwarded-Host`。
- 路径参数经归一化 + `realpath` 校验，符号链接指向存储根目录之外的请求返回 400。
- 配置文件损坏时会备份为 `config.json.bad` 并重新生成，旧密码与会话会失效。
- 可用 `NETDISK_CONFIG` 指定配置文件路径（Docker 部署使用），默认 `./config.json`。
- 旧版单密码配置自动迁移为用户名 `admin` 的管理员；原 `storage/` 文件保留给该账户。独立用户存放在 `storage.users/`；Docker Compose 已挂载该目录以保证数据持久化。共享用户直接访问管理员的 `storage/`。
