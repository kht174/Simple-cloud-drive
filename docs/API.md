# HTTP 接口说明

所有接口返回 JSON；错误形如 `{ "ok": false, "error": "错误说明" }`。
除 `/api/login`、`/api/session`、`/api/password`（首次创建）外，均需带会话 Cookie。

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
  "requiresPassword": true
}
```

| 字段 | 说明 |
| --- | --- |
| `authenticated` | 当前 Cookie 是否有效 |
| `passwordSet` | 网盘是否已设置访问密码。`false` 表示处于"首次创建"状态 |

### `POST /api/login`

```json
{ "password": "你的密码" }
```

成功：`200` + `Set-Cookie: nd_sess=...`

| 状态码 | 场景 | 响应 |
| --- | --- | --- |
| 200 | 成功 | `{ "ok": true, "expiresIn": 43200000 }` |
| 401 | 密码错误 | `{ "ok": false, "error": "密码错误" }`（含 `retryAfterMs` 建议等待时长） |
| 409 | 尚未设置密码 | `{ "ok": false, "error": "尚未设置访问密码", "needSetup": true }` |
| 429 | 触发封禁 | `{ "ok": false, "error": "尝试次数过多，请稍后再试" }` |

### `POST /api/password`

设置或修改访问密码。

```json
{ "currentPassword": "当前密码", "newPassword": "新密码" }
```

- **首次创建**：只需 `newPassword`（≥ 6 位）。
- **修改**：需 `currentPassword` 正确，且已登录。

成功：`200`，同时下发新的 `Set-Cookie`（旧设备会话全部失效）。

| 状态码 | 场景 |
| --- | --- |
| 400 | 新密码过短 / 与当前密码相同 |
| 401 | 修改时未登录 |
| 403 | 当前密码不正确 |

### `POST /api/logout`

清除本机会话 Cookie。

---

## 文件操作（均需登录）

### `GET /api/list?path=<相对路径>`

`path` 为空表示根目录。

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
| 403 | 当前密码不正确 |
| 404 | 文件或文件夹不存在 |
| 409 | 同名已存在 / 尚未设置密码 |
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
- 默认不信任代理：登录限流按 TCP 层来源地址统计。仅在反代之后设置 `TRUST_PROXY=1`，此时才采信 `X-Forwarded-For` / `X-Forwarded-Proto` / `X-Forwarded-Host`。
- 路径参数经归一化 + `realpath` 校验，符号链接指向存储根目录之外的请求返回 400。
- 配置文件损坏时会备份为 `config.json.bad` 并重新生成，旧密码与会话会失效。
- 可用 `NETDISK_CONFIG` 指定配置文件路径（Docker 部署使用），默认 `./config.json`。
