const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.resolve(process.env.NETDISK_DIR || path.join(__dirname, 'storage'));
const CONFIG_PATH = path.resolve(process.env.NETDISK_CONFIG || path.join(__dirname, 'config.json'));
// 默认不信任任何代理。只有明确设置 TRUST_PROXY 时才采信 X-Forwarded-*，
// 否则客户端可以伪造 X-Forwarded-For 无限次绕过登录限流。
const TRUST_PROXY = process.env.TRUST_PROXY || '';
const SESSION_COOKIE = 'nd_sess';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024; // 4 MiB
const LOGIN_MAX_FAILS = 20; // 超过后硬封禁；此前用递增等待节流
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });

/* ---------------------------------- 配置 ---------------------------------- */

function loadConfig() {
  let cfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      // 配置文件损坏时不要静默重置：备份原件并明确告警
      console.error(`[警告] ${CONFIG_PATH} 解析失败，已备份为 .bad 并重建（原会话与密码将失效）: ${err.message}`);
      try {
        fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bad`);
      } catch {
        /* ignore */
      }
      cfg = {};
    }
  }
  if (!cfg.sessionSecret) cfg.sessionSecret = crypto.randomBytes(32).toString('hex');
  if (typeof cfg.passwordVersion !== 'number') cfg.passwordVersion = 1;
  // 兼容旧版明文密码：首次校验成功后转成哈希存储
  if (!cfg.passwordHash && typeof cfg.password === 'string' && cfg.password) {
    const { salt, hash } = hashPassword(cfg.password);
    cfg.passwordSalt = salt;
    cfg.passwordHash = hash;
    delete cfg.password;
  }
  if (process.env.NETDISK_PASSWORD) {
    const { salt, hash } = hashPassword(process.env.NETDISK_PASSWORD);
    cfg.passwordSalt = salt;
    cfg.passwordHash = hash;
    cfg.passwordVersion += 1; // 环境变量重设密码同样让旧会话失效
    delete cfg.password;
  }
  saveConfig(cfg);
  return cfg;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* ignore */
  }
}

const CONFIG = loadConfig();

/* --------------------------------- 密码散列 -------------------------------- */

function hashPassword(pw, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), s, 64).toString('hex');
  return { salt: s, hash };
}

function passwordIsSet() {
  return Boolean(CONFIG.passwordHash && CONFIG.passwordSalt);
}

function passwordMatches(input) {
  if (!passwordIsSet()) return false;
  const candidate = crypto.scryptSync(String(input == null ? '' : input), CONFIG.passwordSalt, 64);
  const expected = Buffer.from(CONFIG.passwordHash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function passwordPolicyError(pw) {
  if (typeof pw !== 'string' || pw.length === 0) return '请输入新密码';
  if (pw.length < 6) return '密码至少 6 位';
  if (pw.length > 128) return '密码过长';
  return null;
}


/* --------------------------------- 会话票据 -------------------------------- */

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function signPayload(payload) {
  return crypto.createHmac('sha256', CONFIG.sessionSecret).update(payload).digest('base64url');
}

function issueToken() {
  const payload = b64url(
    JSON.stringify({ exp: Date.now() + SESSION_TTL_MS, ver: CONFIG.passwordVersion })
  );
  return `${payload}.${signPayload(payload)}`;
}

function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const idx = token.lastIndexOf('.');
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = signPayload(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.exp !== 'number' || data.exp <= Date.now()) return false;
    // 密码变更后旧令牌一律失效
    if ((data.ver || 1) !== CONFIG.passwordVersion) return false;
    return true;
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function isAuthed(req) {
  return verifyToken(parseCookies(req)[SESSION_COOKIE]);
}

/* --------------------------------- 登录限流 -------------------------------- */

const loginFails = new Map();

function clientIp(req) {
  // 默认使用 TCP 层地址（客户端无法伪造）；仅当配置了可信代理时才用 req.ip
  const ip = TRUST_PROXY ? req.ip : req.socket.remoteAddress;
  return String(ip || 'unknown');
}

function loginBlocked(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > LOGIN_WINDOW_MS) {
    loginFails.delete(ip);
    return false;
  }
  return rec.count >= LOGIN_MAX_FAILS;
}

function noteLoginFail(ip) {
  const rec = loginFails.get(ip);
  if (!rec || Date.now() - rec.first > LOGIN_WINDOW_MS) {
    loginFails.set(ip, { count: 1, first: Date.now() });
  } else {
    rec.count += 1;
  }
}

function loginDelay(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return 0;
  // 逐次递增的等待：最多 8 秒，输错一次等 0.5 秒
  return Math.min(500 * 2 ** (rec.count - 1), 8000);
}

/* ---------------------------------- 应用 ---------------------------------- */

const app = express();
if (TRUST_PROXY) {
  app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);
}
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// 同源校验：SameSite=Lax 挡得住跨站 POST，挡不住同站不同端口页面发起的 CSRF。
// 浏览器同源 fetch/XHR 一定带 Origin 且与 Host 一致；curl 等无 Origin 的请求放行。
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
app.use((req, res, next) => {
  if (!MUTATING_METHODS.has(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  let originHost;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return res.status(403).json({ ok: false, error: '请求来源不合法' });
  }
  const forwardedHost = TRUST_PROXY ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() : '';
  const host = String(forwardedHost || req.headers.host || '').toLowerCase();
  if (!host || originHost !== host) {
    return res.status(403).json({ ok: false, error: '请求来源与主机不匹配' });
  }
  return next();
});

function illegalPath() {
  const err = new Error('非法路径');
  err.status = 400;
  return err;
}

function resolvePath(rel) {
  // query / body 可能被解析成数组或对象；NUL 字节会让 fs 抛未捕获异常
  if (rel != null && typeof rel !== 'string') throw illegalPath();
  if (typeof rel === 'string' && rel.includes('\0')) throw illegalPath();
  const abs = path.resolve(ROOT, rel || '');
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw illegalPath();

  // 字符串前缀判断挡不住符号链接：对已存在的最深层路径做 realpath 校验，
  // 防止 storage 内的软链接把读写 / 删除引到根目录之外。
  const realRoot = fs.realpathSync(ROOT);
  let cur = abs;
  for (;;) {
    let real;
    try {
      real = fs.realpathSync(cur);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
      continue;
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw illegalPath();
    break;
  }
  return abs;
}

function relOf(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function validName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 255 &&
    name !== '.' &&
    name !== '..' &&
    !/[\/\\\0]/.test(name) &&
    !/[\x00-\x1f]/.test(name) && // 控制字符
    !/[. ]$/.test(name) && // Windows 会静默去掉尾随点 / 空格
    !WINDOWS_RESERVED.test(name) // Windows 设备名
  );
}

function uniqueName(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = name;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base} (${i})${ext}`;
    i += 1;
  }
  return candidate;
}

function walkStats(abs, acc) {
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const child = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      walkStats(child, acc);
    } else {
      try {
        const st = fs.statSync(child);
        acc.bytes += st.size;
        acc.files += 1;
      } catch {
        /* ignore */
      }
    }
  }
  return acc;
}

/* ------------------------------- 预览类型判定 ------------------------------ */

const IMAGE_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
]);

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.mdx', '.rst', '.log', '.csv', '.tsv', '.ini', '.cfg',
  '.conf', '.env', '.properties', '.yml', '.yaml', '.toml', '.json', '.json5', '.jsonc',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.css', '.scss', '.less', '.vue', '.svelte',
  '.html', '.htm', '.xhtml', '.xml', '.svg', '.plist', '.gradle', '.pro', '.cmake', '.mk',
  '.java', '.kt', '.kts', '.scala', '.groovy', '.smali', '.js', '.c', '.h', '.cc', '.cpp',
  '.hpp', '.cs', '.go', '.rs', '.py', '.rb', '.php', '.pl', '.pm', '.lua', '.swift', '.m',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd', '.sql', '.asm', '.s', '.ld',
  '.diff', '.patch', '.gitignore', '.editorconfig', '.pem', '.crt', '.cer', '.gyp',
  '.srt', '.vtt', '.ipynb', '.tex', '.dockerfile', '.makefile',
]);

const NAME_EXT = new Map([
  ['makefile', '.makefile'],
  ['dockerfile', '.dockerfile'],
  ['license', '.txt'],
  ['readme', '.txt'],
]);

function previewKind(abs) {
  const base = path.basename(abs).toLowerCase();
  const ext = NAME_EXT.get(base) || path.extname(base).toLowerCase();
  if (ext === '.pdf') return { kind: 'pdf', mime: 'application/pdf', ext };
  if (IMAGE_MIME.has(ext)) return { kind: 'image', mime: IMAGE_MIME.get(ext), ext };
  if (TEXT_EXT.has(ext)) return { kind: 'text', mime: 'text/plain; charset=utf-8', ext };
  return { kind: 'unsupported', mime: null, ext };
}

function contentDisposition(name, disposition) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  // encodeURIComponent 不编码 ' ! ( ) *，这些字符会破坏 RFC 5987 的 filename* 参数
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function isSecureRequest(req) {
  if (req.secure === true) return true;
  if (!TRUST_PROXY) return false; // 不信任代理时不采信客户端自报的 X-Forwarded-Proto
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto.toLowerCase() === 'https';
}

function sessionCookie(req, token, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

/* --------------------------------- 鉴权接口 -------------------------------- */

app.post('/api/login', (req, res) => {
  if (!passwordIsSet()) {
    return res.status(409).json({ ok: false, error: '尚未设置访问密码', needSetup: true });
  }
  const ip = clientIp(req);
  if (loginBlocked(ip)) {
    return res.status(429).json({ ok: false, error: '尝试次数过多，请稍后再试' });
  }
  const { password } = req.body || {};
  if (!passwordMatches(password)) {
    noteLoginFail(ip);
    const wait = loginDelay(ip);
    setTimeout(() => {
      res.status(401).json({
        ok: false,
        error: wait > 1000 ? `密码错误，请 ${Math.round(wait / 1000)} 秒后重试` : '密码错误',
        retryAfterMs: wait,
      });
    }, wait);
    return;
  }
  loginFails.delete(ip);
  res.setHeader('Set-Cookie', sessionCookie(req, issueToken(), Math.floor(SESSION_TTL_MS / 1000)));
  res.json({ ok: true, expiresIn: SESSION_TTL_MS });
});

app.get('/api/session', (req, res) => {
  res.json({
    ok: true,
    authenticated: isAuthed(req),
    passwordSet: passwordIsSet(),
    requiresPassword: true,
  });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
  res.json({ ok: true });
});

// 设置（首次创建）或修改访问密码
app.post('/api/password', (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const isSetup = !passwordIsSet();

  if (!isSetup) {
    // 已设置密码：修改需要先验证当前密码（登录态 + 当前密码双重确认）
    if (!isAuthed(req)) {
      return res.status(401).json({ ok: false, error: '需要访问密码', authRequired: true });
    }
    const ip = clientIp(req);
    if (!passwordMatches(currentPassword)) {
      noteLoginFail(ip);
      return res.status(403).json({ ok: false, error: '当前密码不正确' });
    }
  }

  const policyError = passwordPolicyError(newPassword);
  if (policyError) {
    return res.status(400).json({ ok: false, error: policyError });
  }
  if (!isSetup && passwordMatches(newPassword)) {
    return res.status(400).json({ ok: false, error: '新密码不能与当前密码相同' });
  }

  const { salt, hash } = hashPassword(newPassword);
  CONFIG.passwordSalt = salt;
  CONFIG.passwordHash = hash;
  CONFIG.passwordVersion += 1; // 使所有旧会话失效
  delete CONFIG.password;
  saveConfig(CONFIG);
  loginFails.clear();

  // 重新签发当前会话，保证改完密码后不会被踢出
  res.setHeader('Set-Cookie', sessionCookie(req, issueToken(), Math.floor(SESSION_TTL_MS / 1000)));
  res.json({ ok: true, created: isSetup, changed: !isSetup });
});

// 以下所有 /api/* 接口都需要访问密码
app.use('/api', (req, res, next) => {
  if (isAuthed(req)) return next();
  res.status(401).json({ ok: false, error: '需要访问密码', authRequired: true });
});

/* --------------------------------- 存储接口 -------------------------------- */

const storage = multer.diskStorage({
  destination(req, file, cb) {
    try {
      const dir = resolvePath(req.query.path);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return cb(Object.assign(new Error('目标文件夹不存在'), { status: 400 }));
      }
      cb(null, dir);
    } catch (err) {
      cb(err);
    }
  },
  filename(req, file, cb) {
    const original = path.basename(file.originalname.replace(/\\/g, '/'));
    if (!validName(original)) {
      return cb(Object.assign(new Error('文件名不合法'), { status: 400 }));
    }
    const dir = resolvePath(req.query.path);
    cb(null, uniqueName(dir, original));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 * 1024, files: 100 },
});

app.get('/api/list', (req, res, next) => {
  try {
    const rel = req.query.path || '';
    const abs = resolvePath(rel);
    if (!fs.existsSync(abs)) {
      const err = new Error('文件夹不存在');
      err.status = 404;
      throw err;
    }
    if (!fs.statSync(abs).isDirectory()) {
      const err = new Error('不是文件夹');
      err.status = 400;
      throw err;
    }
    const entries = fs
      .readdirSync(abs, { withFileTypes: true })
      .map((entry) => {
        const child = path.join(abs, entry.name);
        let size = 0;
        let mtime = 0;
        let preview = null;
        try {
          const st = fs.statSync(child);
          size = entry.isDirectory() ? 0 : st.size;
          mtime = st.mtimeMs;
          if (!entry.isDirectory()) {
            const k = previewKind(child).kind;
            if (k !== 'unsupported') preview = k;
          }
        } catch {
          /* ignore */
        }
        return {
          name: entry.name,
          type: entry.isDirectory() ? 'dir' : 'file',
          size,
          mtime,
          preview,
        };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-CN');
      });
    const current = relOf(abs);
    const parts = current ? current.split('/') : [];
    const breadcrumb = [{ name: '我的云盘', path: '' }];
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      breadcrumb.push({ name: part, path: acc });
    }
    res.json({ path: current, breadcrumb, entries });
  } catch (err) {
    next(err);
  }
});

app.get('/api/stats', (req, res, next) => {
  try {
    const stats = walkStats(ROOT, { bytes: 0, files: 0 });
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

app.post('/api/upload', upload.array('files', 100), (req, res) => {
  const files = (req.files || []).map((f) => ({
    name: path.basename(f.filename),
    size: f.size,
  }));
  res.json({ ok: true, files });
});

app.get('/api/download', (req, res, next) => {
  try {
    const abs = resolvePath(req.query.path);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      const err = new Error('文件不存在');
      err.status = 404;
      throw err;
    }
    res.download(abs, path.basename(abs));
  } catch (err) {
    next(err);
  }
});

app.get('/api/preview', (req, res, next) => {
  try {
    const abs = resolvePath(req.query.path);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      const err = new Error('文件不存在');
      err.status = 404;
      throw err;
    }
    const st = fs.statSync(abs);
    const name = path.basename(abs);
    const { kind, mime, ext } = previewKind(abs);

    res.setHeader('X-Preview-Kind', kind);
    res.setHeader('X-Preview-Ext', (ext || '').replace(/^\./, ''));
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Disposition', contentDisposition(name, 'inline'));

    if (kind === 'unsupported') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send('该文件类型不支持在线预览，请下载后查看。');
    }
    if (st.size > MAX_PREVIEW_BYTES) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(413).send('文件过大，无法在线预览，请下载后查看。');
    }
    if (kind === 'text') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.status(200).send(fs.readFileSync(abs, 'utf8'));
    }
    res.setHeader('Content-Type', mime);
    return res.sendFile(abs, { headers: { 'Content-Type': mime } });
  } catch (err) {
    next(err);
  }
});

app.post('/api/mkdir', (req, res, next) => {
  try {
    const { path: rel = '', name } = req.body || {};
    if (!validName(name)) {
      const err = new Error('文件夹名不合法');
      err.status = 400;
      throw err;
    }
    const dir = resolvePath(rel);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      const err = new Error('目标文件夹不存在');
      err.status = 400;
      throw err;
    }
    const target = path.join(dir, name);
    if (fs.existsSync(target)) {
      const err = new Error('同名文件夹已存在');
      err.status = 409;
      throw err;
    }
    fs.mkdirSync(target);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/delete', (req, res, next) => {
  try {
    const { path: rel } = req.body || {};
    if (!rel) {
      const err = new Error('不能删除根目录');
      err.status = 400;
      throw err;
    }
    const abs = resolvePath(rel);
    if (abs === ROOT || !fs.existsSync(abs)) {
      const err = new Error('目标不存在');
      err.status = 404;
      throw err;
    }
    fs.rmSync(abs, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/rename', (req, res, next) => {
  try {
    const { path: rel, name } = req.body || {};
    if (!rel || !validName(name)) {
      const err = new Error('参数不合法');
      err.status = 400;
      throw err;
    }
    const abs = resolvePath(rel);
    if (!fs.existsSync(abs)) {
      const err = new Error('目标不存在');
      err.status = 404;
      throw err;
    }
    const target = path.join(path.dirname(abs), name);
    if (target !== abs && fs.existsSync(target)) {
      const err = new Error('同名文件已存在');
      err.status = 409;
      throw err;
    }
    fs.renameSync(abs, target);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || (err instanceof multer.MulterError ? 400 : 500);
  res.status(status).json({ ok: false, error: err.message || '服务器错误' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Netdisk listening on http://0.0.0.0:${PORT}`);
  console.log(
    passwordIsSet()
      ? 'Netdisk password: 已设置（可在网页内修改）'
      : 'Netdisk password: 未设置，首次访问网页时创建'
  );
});
