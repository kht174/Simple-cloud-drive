const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// PORT=0 表示随机端口，需显式判断而不是 Number() || 3000
const PORT_ENV = process.env.PORT == null || process.env.PORT === '' ? NaN : Number(process.env.PORT);
const PORT = Number.isInteger(PORT_ENV) && PORT_ENV >= 0 && PORT_ENV < 65536 ? PORT_ENV : 3000;
// 默认只监听本机；对外暴露请用反向代理，或显式设置 NETDISK_HOST=0.0.0.0
const HOST = process.env.NETDISK_HOST || process.env.HOST || '127.0.0.1';
// 存储根目录（启动时取 realpath，后续所有路径校验都以它为准）
const ROOT = (() => {
  const p = path.resolve(process.env.NETDISK_DIR || path.join(__dirname, 'storage'));
  fs.mkdirSync(p, { recursive: true });
  return fs.realpathSync(p);
})();
const USER_DATA_ROOT = path.resolve(`${ROOT}.users`);
fs.mkdirSync(USER_DATA_ROOT, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') fs.chmodSync(USER_DATA_ROOT, 0o700);
const REAL_USER_DATA_ROOT = fs.realpathSync(USER_DATA_ROOT);
if (
  REAL_USER_DATA_ROOT === ROOT ||
  REAL_USER_DATA_ROOT.startsWith(ROOT + path.sep) ||
  ROOT.startsWith(REAL_USER_DATA_ROOT + path.sep)
) {
  throw new Error('多用户存储目录必须与现有存储目录分离');
}
// 配置文件路径可用 NETDISK_CONFIG 覆盖（Docker 场景把配置放到独立目录，避免单文件挂载被创建成目录）
const CONFIG_PATH = path.resolve(process.env.NETDISK_CONFIG || path.join(__dirname, 'config.json'));
const SETUP_TOKEN_PATH = path.join(path.dirname(CONFIG_PATH), '.initial-setup-token');
const isInstaboxRuntime = Boolean(process.env.INSTABOX_TERM_SESSION || process.env.INSTABOX_TERM_DIR);
const proxySetting = process.env.TRUST_PROXY || process.env.NETDISK_TRUST_PROXY;
const TRUST_PROXY = String(proxySetting || (isInstaboxRuntime ? '1' : '')).trim();
const TRUST_PROXY_ENABLED = Boolean(TRUST_PROXY) && !/^(0|false|off|no)$/i.test(TRUST_PROXY);
const SESSION_COOKIE = 'nd_sess';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024; // 4 MiB
const LOGIN_MAX_FAILS = 20; // 单 IP 超过后硬封禁；此前用递增等待节流
const LOGIN_GLOBAL_MAX_FAILS = 100; // 全局失败上限，防分布式爆破
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/* ---------------------------------- 配置 ---------------------------------- */

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// 配置路径被当成目录挂载（Docker 单文件挂载的经典坑）时给出明确提示，而不是写文件时报 EISDIR
if (fs.existsSync(CONFIG_PATH) && fs.statSync(CONFIG_PATH).isDirectory()) {
  console.error(
    `配置路径 ${CONFIG_PATH} 是一个目录，无法作为配置文件使用。\n` +
      '请指定一个文件路径（环境变量 NETDISK_CONFIG=/path/to/config.json），' +
      '或把该目录换成指向文件的挂载。'
  );
  process.exit(1);
}
fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
const tokenDirectory = fs.realpathSync(path.dirname(SETUP_TOKEN_PATH));
const publicDirectory = fs.realpathSync(path.join(__dirname, 'public'));
if (
  tokenDirectory === publicDirectory ||
  tokenDirectory.startsWith(publicDirectory + path.sep)
) {
  throw new Error('初始化令牌目录不能位于 public 静态资源目录内');
}

function writeSetupToken(token) {
  const tempPath = `${SETUP_TOKEN_PATH}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${token}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, SETUP_TOKEN_PATH);
  } catch (err) {
    try {
      fs.unlinkSync(tempPath);
    } catch (cleanupErr) {
      if (cleanupErr.code !== 'ENOENT') {
        console.error(`[警告] 无法清理临时初始化令牌文件 ${tempPath}: ${cleanupErr.message}`);
      }
    }
    throw new Error(`无法安全写入首次初始化令牌 ${SETUP_TOKEN_PATH}: ${err.message}`, { cause: err });
  }
}

function removeSetupTokenFile() {
  try {
    fs.unlinkSync(SETUP_TOKEN_PATH);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[警告] 无法删除已失效的初始化令牌文件 ${SETUP_TOKEN_PATH}: ${err.message}`);
    }
  }
}

function loadConfig() {
  let cfg = {};
  let generatedSetupToken = false;
  if (fs.existsSync(CONFIG_PATH)) {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    try {
      cfg = JSON.parse(raw);
    } catch (err) {
      const backupPath = `${CONFIG_PATH}.bad`;
      try {
        fs.copyFileSync(CONFIG_PATH, backupPath, fs.constants.COPYFILE_EXCL);
      } catch (backupErr) {
        throw new Error(
          `配置文件解析失败，且无法备份原文件到 ${backupPath}: ${backupErr.message}`,
          { cause: backupErr }
        );
      }
      console.error(
        `[警告] ${CONFIG_PATH} 解析失败，原文件已备份到 ${backupPath}；重新生成配置会使旧密码和会话失效: ${err.message}`
      );
      cfg = {};
    }
  }
  if (!cfg.sessionSecret) cfg.sessionSecret = crypto.randomBytes(32).toString('hex');
  if (!Array.isArray(cfg.users)) cfg.users = [];
  // 兼容旧版明文密码：首次校验成功后转成哈希存储
  if (!cfg.passwordHash && typeof cfg.password === 'string' && cfg.password) {
    const { salt, hash } = hashPassword(cfg.password);
    cfg.passwordSalt = salt;
    cfg.passwordHash = hash;
    delete cfg.password;
  }
  if (process.env.NETDISK_PASSWORD && cfg.users.length === 0) {
    const pw = process.env.NETDISK_PASSWORD;
    const sameAsCurrent =
      cfg.passwordHash &&
      cfg.passwordSalt &&
      crypto.scryptSync(pw, cfg.passwordSalt, 64).toString('hex') === cfg.passwordHash;
    if (!sameAsCurrent) {
      const { salt, hash } = hashPassword(pw);
      cfg.passwordSalt = salt;
      cfg.passwordHash = hash;
      // 密码被环境变量轮换后必须递增版本号，使旧会话全部失效
      cfg.passwordVersion = (typeof cfg.passwordVersion === 'number' ? cfg.passwordVersion : 1) + 1;
    }
    delete cfg.password;
    delete cfg.setupTokenHash;
  }
  if (cfg.users.length === 0 && cfg.passwordHash && cfg.passwordSalt) {
    cfg.users.push({
      id: 'admin',
      username: 'admin',
      salt: cfg.passwordSalt,
      hash: cfg.passwordHash,
      role: 'admin',
      version: typeof cfg.passwordVersion === 'number' ? cfg.passwordVersion : 1,
      legacyRoot: true,
    });
  }
  if (process.env.NETDISK_PASSWORD && cfg.users.length > 0) {
    let admin = cfg.users.find((user) => user.role === 'admin');
    if (!admin) {
      admin = cfg.users.find((user) => user.username.toLocaleLowerCase('en-US') === 'admin');
      if (admin) admin.role = 'admin';
    }
    if (admin) {
      const current = crypto.scryptSync(process.env.NETDISK_PASSWORD, admin.salt, 64).toString('hex');
      if (current !== admin.hash) {
        const { salt, hash } = hashPassword(process.env.NETDISK_PASSWORD);
        admin.salt = salt;
        admin.hash = hash;
        admin.version = (admin.version || 1) + 1;
      }
    } else {
      const { salt, hash } = hashPassword(process.env.NETDISK_PASSWORD);
      cfg.users.push({
        id: 'admin',
        username: 'admin',
        salt,
        hash,
        role: 'admin',
        version: 1,
        legacyRoot: true,
      });
    }
    delete cfg.password;
    delete cfg.passwordSalt;
    delete cfg.passwordHash;
    delete cfg.passwordVersion;
  }
  const adminConfigured = cfg.users.some((user) => user.role === 'admin');
  if (adminConfigured) {
    delete cfg.password;
    delete cfg.passwordSalt;
    delete cfg.passwordHash;
    delete cfg.passwordVersion;
    delete cfg.setupTokenHash;
    removeSetupTokenFile();
  } else if (!cfg.setupTokenHash || !fs.existsSync(SETUP_TOKEN_PATH)) {
    const token = crypto.randomBytes(32).toString('base64url');
    cfg.setupTokenHash = crypto.createHash('sha256').update(token).digest('hex');
    writeSetupToken(token);
    generatedSetupToken = true;
  }
  saveConfig(cfg);
  if (generatedSetupToken) {
    console.warn(`[初始化] 首次设置令牌已安全写入 ${SETUP_TOKEN_PATH}，可用 ./netdisk.sh show-setup-token 查看。`);
  }
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
  return CONFIG.users.some((user) => user.role === 'admin');
}

function passwordMatches(user, input) {
  if (!user || !user.salt || !user.hash) return false;
  const candidate = crypto.scryptSync(String(input == null ? '' : input), user.salt, 64);
  const expected = Buffer.from(user.hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function validUsername(username) {
  if (typeof username !== 'string' || !/^[\p{L}\p{N}_.-]{1,32}$/u.test(username)) return false;
  // 拒绝 "." 和 ".." 等纯点用户名，防止路径组件语义歧义
  return !/^[.]+$/.test(username);
}

function findUser(username) {
  if (typeof username !== 'string') return null;
  const normalized = username.toLocaleLowerCase('en-US');
  return CONFIG.users.find((user) => user.username.toLocaleLowerCase('en-US') === normalized) || null;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    storageMode: user.legacyRoot || user.storageMode === 'shared' ? 'shared' : 'isolated',
  };
}

function setupTokenMatches(input) {
  if (typeof input !== 'string' || input.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(input)) {
    return false;
  }
  if (!CONFIG.setupTokenHash) return false;
  const expected = Buffer.from(CONFIG.setupTokenHash, 'hex');
  const actual = crypto.createHash('sha256').update(input).digest();
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
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

function issueToken(user) {
  const payload = b64url(
    JSON.stringify({ exp: Date.now() + SESSION_TTL_MS, uid: user.id, ver: user.version || 1 })
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
    const user = CONFIG.users.find((item) => item.id === data.uid);
    if (!user || (data.ver || 1) !== (user.version || 1)) return null;
    return user;
  } catch {
    return null;
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

function sessionUser(req) {
  return verifyToken(parseCookies(req)[SESSION_COOKIE]);
}

/* --------------------------------- 登录限流 -------------------------------- */

const loginFails = new Map();
let globalFails = { count: 0, first: Date.now() };

function sweepLoginFails() {
  const now = Date.now();
  for (const [ip, rec] of loginFails) {
    if (now - rec.first > LOGIN_WINDOW_MS) loginFails.delete(ip);
  }
  if (now - globalFails.first > LOGIN_WINDOW_MS) globalFails = { count: 0, first: now };
}
const sweepTimer = setInterval(sweepLoginFails, 60 * 1000);
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

function clientIp(req) {
  // 仅在显式配置了可信代理时，req.ip 才来自 X-Forwarded-For
  return String(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
}

function loginBlocked(ip) {
  sweepLoginFails();
  // 全局上限：即使攻击者轮换 IP，也无法无限次爆破同一个密码
  if (globalFails.count >= LOGIN_GLOBAL_MAX_FAILS) return true;
  const rec = loginFails.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > LOGIN_WINDOW_MS) {
    loginFails.delete(ip);
    return false;
  }
  return rec.count >= LOGIN_MAX_FAILS;
}

function noteLoginFail(ip) {
  const now = Date.now();
  const rec = loginFails.get(ip);
  if (!rec || now - rec.first > LOGIN_WINDOW_MS) {
    loginFails.set(ip, { count: 1, first: now });
  } else {
    rec.count += 1;
  }
  if (now - globalFails.first > LOGIN_WINDOW_MS) {
    globalFails = { count: 1, first: now };
  } else {
    globalFails.count += 1;
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
app.disable('x-powered-by');

// Instabox 提供固定的一跳反向代理；其他环境默认不信任代理头。
if (TRUST_PROXY_ENABLED) {
  const hops = Number(TRUST_PROXY);
  if (Number.isFinite(hops) && hops > 0) app.set('trust proxy', hops);
  else if (TRUST_PROXY.toLowerCase() === 'true') app.set('trust proxy', true);
  else app.set('trust proxy', TRUST_PROXY);
}

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; form-action 'self'"
  );
  next();
});

/* ------------------------------ CSRF / 同源校验 ----------------------------- */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// SameSite=Lax 挡得住「跨站」请求，但挡不住「同站跨端口」（例如同一主机名的另一个端口上的恶意页面）。
// 因此写操作再校验一次 Origin / Sec-Fetch-Site。
function sameOriginRequest(req) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site === 'cross-site') return false;

  const forwardedHost = TRUST_PROXY_ENABLED ? req.headers['x-forwarded-host'] : '';
  const host = String(forwardedHost || req.headers.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const protocol = `${req.protocol}:`;
  const origin = req.headers.origin;
  if (origin) {
    try {
      const u = new URL(origin);
      return Boolean(host) && u.host.toLowerCase() === host && u.protocol === protocol;
    } catch {
      return false;
    }
  }

  // 没有 Origin 时退回 Referer（老浏览器）
  const referer = req.headers.referer;
  if (referer) {
    try {
      const u = new URL(referer);
      return Boolean(host) && u.host.toLowerCase() === host && u.protocol === protocol;
    } catch {
      return false;
    }
  }

  // 非浏览器客户端（curl / 脚本）不带这两个头，放行
  return true;
}

app.use((req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!sameOriginRequest(req)) {
    return res.status(403).json({ ok: false, error: '跨站请求已被拒绝' });
  }
  next();
});

/* --------------------------------- 路径处理 -------------------------------- */

function storageRoot(user) {
  if (user.legacyRoot || user.storageMode === 'shared') return ROOT;
  if (!/^[a-f0-9]{32}$/.test(user.id)) throw httpError(500, '用户存储目录配置无效');
  const dir = path.join(REAL_USER_DATA_ROOT, user.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  const real = fs.realpathSync(dir);
  if (!isInsideRoot(real, REAL_USER_DATA_ROOT) || real === REAL_USER_DATA_ROOT) {
    throw httpError(500, '用户存储目录无效');
  }
  return real;
}

function isInsideRoot(abs, root = ROOT) {
  return abs === root || abs.startsWith(root + path.sep);
}

// 字符串前缀比对挡不住符号链接越界：这里解析 realpath 后再判断是否仍在 ROOT 之内
function resolvePath(rel, root = ROOT) {
  if (typeof rel !== 'string') throw httpError(400, '路径参数不合法');
  const abs = path.resolve(root, rel);
  if (!isInsideRoot(abs, root)) throw httpError(400, '非法路径');

  // 找到最深的、真实存在的祖先目录，解析其中的符号链接
  let probe = abs;
  const tail = [];
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    tail.unshift(path.basename(probe));
    probe = parent;
  }
  let real;
  try {
    real = fs.realpathSync(probe);
  } catch {
    real = probe;
  }
  if (!isInsideRoot(real, root)) throw httpError(400, '非法路径');

  const resolved = tail.length ? path.join(real, ...tail) : real;
  if (!isInsideRoot(resolved, root)) throw httpError(400, '非法路径');
  return resolved;
}

function relOf(abs, root = ROOT) {
  return path.relative(root, abs).split(path.sep).join('/');
}

// query 参数必须是单个字符串（?path[]=x 会得到数组，必须拒绝）
function queryPath(req) {
  const v = req.query.path;
  if (v === undefined) return '';
  if (typeof v !== 'string') throw httpError(400, '路径参数不合法');
  return v;
}

function validName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 255 &&
    name !== '.' &&
    name !== '..' &&
    !/[\/\\\0]/.test(name)
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
  '.java', '.kt', '.kts', '.scala', '.groovy', '.dart', '.smali', '.js', '.c', '.h', '.cc', '.cpp',
  '.hpp', '.cs', '.go', '.rs', '.py', '.rb', '.php', '.pl', '.pm', '.lua', '.swift', '.m',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd', '.sql', '.asm', '.s', '.ld',
  '.diff', '.patch', '.gitignore', '.editorconfig', '.pem', '.crt', '.cer', '.gyp',
  '.srt', '.vtt', '.ipynb', '.tex', '.dockerfile', '.makefile', '.nginx', '.apache', '.conf',
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

// RFC 5987：ASCII 回退名 + UTF-8 百分号编码，保证中文文件名在各浏览器下都不乱码
function contentDisposition(name, disposition) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function isSecureRequest(req) {
  return req.secure === true;
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
    return res.status(409).json({ ok: false, error: '尚未创建管理员账户', needSetup: true });
  }
  const ip = clientIp(req);
  if (loginBlocked(ip)) {
    return res.status(429).json({ ok: false, error: '尝试次数过多，请稍后再试' });
  }
  const { password } = req.body || {};
  const username = req.body && typeof req.body.username === 'string'
    ? req.body.username
    : (CONFIG.users.find((item) => item.role === 'admin') || {}).username;
  const user = findUser(username);
  if (!passwordMatches(user, password)) {
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
  res.setHeader('Set-Cookie', sessionCookie(req, issueToken(user), Math.floor(SESSION_TTL_MS / 1000)));
  res.json({ ok: true, expiresIn: SESSION_TTL_MS, user: publicUser(user) });
});

app.get('/api/session', (req, res) => {
  const user = sessionUser(req);
  res.json({
    ok: true,
    authenticated: Boolean(user),
    passwordSet: passwordIsSet(),
    requiresPassword: true,
    user: user ? publicUser(user) : null,
  });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
  res.json({ ok: true });
});

// 设置（首次创建）或修改访问密码
app.post('/api/password', (req, res) => {
  const { currentPassword, newPassword, setupToken, username = 'admin' } = req.body || {};
  const isSetup = !passwordIsSet();
  let user = null;

  if (isSetup) {
    if (!setupTokenMatches(setupToken)) {
      return res.status(403).json({ ok: false, error: '首次设置令牌无效，请从服务器获取最新令牌' });
    }
    if (!validUsername(username)) {
      return res.status(400).json({ ok: false, error: '用户名限 1-32 位字母、数字、点、横线或下划线' });
    }
    if (findUser(username)) {
      return res.status(409).json({ ok: false, error: '用户名已存在' });
    }
  } else {
    // 已设置密码：修改需要先验证当前密码（登录态 + 当前密码双重确认）
    user = sessionUser(req);
    if (!user) {
      return res.status(401).json({ ok: false, error: '需要访问密码', authRequired: true });
    }
    const ip = clientIp(req);
    if (!passwordMatches(user, currentPassword)) {
      noteLoginFail(ip);
      return res.status(403).json({ ok: false, error: '当前密码不正确' });
    }
  }

  const policyError = passwordPolicyError(newPassword);
  if (policyError) {
    return res.status(400).json({ ok: false, error: policyError });
  }
  if (!isSetup && passwordMatches(user, newPassword)) {
    return res.status(400).json({ ok: false, error: '新密码不能与当前密码相同' });
  }

  const { salt, hash } = hashPassword(newPassword);
  if (isSetup) {
    user = {
      id: 'admin',
      username,
      salt,
      hash,
      role: 'admin',
      version: 1,
      legacyRoot: true,
    };
    CONFIG.users.push(user);
  } else {
    user.salt = salt;
    user.hash = hash;
    user.version = (user.version || 1) + 1;
  }
  delete CONFIG.password;
  delete CONFIG.passwordSalt;
  delete CONFIG.passwordHash;
  delete CONFIG.passwordVersion;
  delete CONFIG.setupTokenHash;
  saveConfig(CONFIG);
  removeSetupTokenFile();
  loginFails.clear();
  globalFails = { count: 0, first: Date.now() };

  // 重新签发当前会话，保证改完密码后不会被踢出
  res.setHeader('Set-Cookie', sessionCookie(req, issueToken(user), Math.floor(SESSION_TTL_MS / 1000)));
  res.json({ ok: true, created: isSetup, changed: !isSetup, user: publicUser(user) });
});

// 以下所有 /api/* 接口都需要访问密码
app.use('/api', (req, res, next) => {
  const user = sessionUser(req);
  if (user) {
    req.user = user;
    return next();
  }
  res.status(401).json({ ok: false, error: '需要访问密码', authRequired: true });
});

app.get('/api/users', (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ ok: false, error: '仅管理员可管理用户' });
  }
  res.json({ users: CONFIG.users.map(publicUser) });
});

app.post('/api/users', (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ ok: false, error: '仅管理员可管理用户' });
  }
  const { username, password, storageMode = 'isolated' } = req.body || {};
  if (!validUsername(username)) {
    return res.status(400).json({ ok: false, error: '用户名限 1-32 位字母、数字、点、横线或下划线' });
  }
  if (storageMode !== 'isolated' && storageMode !== 'shared') {
    return res.status(400).json({ ok: false, error: '目录模式必须为 isolated 或 shared' });
  }
  const policyError = passwordPolicyError(password);
  if (policyError) return res.status(400).json({ ok: false, error: policyError });
  if (findUser(username)) return res.status(409).json({ ok: false, error: '用户名已存在' });
  const { salt, hash } = hashPassword(password);
  const user = {
    id: crypto.randomBytes(16).toString('hex'),
    username,
    salt,
    hash,
    role: 'user',
    version: 1,
    storageMode,
  };
  if (storageMode === 'isolated') storageRoot(user);
  CONFIG.users.push(user);
  saveConfig(CONFIG);
  res.status(201).json({ ok: true, user: publicUser(user) });
});

app.delete('/api/users/:id', (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ ok: false, error: '仅管理员可管理用户' });
  }
  const user = CONFIG.users.find((item) => item.id === req.params.id);
  if (!user) return res.status(404).json({ ok: false, error: '用户不存在' });
  if (user.role === 'admin' || user.id === req.user.id) {
    return res.status(400).json({ ok: false, error: '不能删除管理员账户' });
  }
  const userRoot = user.storageMode === 'shared' ? null : storageRoot(user);
  const users = CONFIG.users.filter((item) => item.id !== user.id);
  saveConfig({ ...CONFIG, users });
  CONFIG.users = users;
  if (userRoot) fs.rmSync(userRoot, { recursive: true, force: true });
  res.json({ ok: true });
});

/* --------------------------------- 存储接口 -------------------------------- */

// multipart 文件名按 latin1 传输，需要还原成 UTF-8
function decodeUploadName(raw) {
  const s = String(raw == null ? '' : raw);
  try {
    const utf8 = Buffer.from(s, 'latin1').toString('utf8');
    if (utf8 && !utf8.includes('\ufffd')) return utf8;
  } catch {
    /* ignore */
  }
  return s;
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    try {
      const dir = resolvePath(queryPath(req), storageRoot(req.user));
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return cb(httpError(400, '目标文件夹不存在'));
      }
      cb(null, dir);
    } catch (err) {
      cb(err);
    }
  },
  filename(req, file, cb) {
    try {
      const original = path.basename(decodeUploadName(file.originalname).replace(/\\/g, '/'));
      if (!validName(original)) {
        return cb(httpError(400, '文件名不合法'));
      }
      const dir = resolvePath(queryPath(req), storageRoot(req.user));
      cb(null, uniqueName(dir, original));
    } catch (err) {
      cb(err);
    }
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 * 1024, files: 100 },
});

app.get('/api/list', (req, res, next) => {
  try {
    const root = storageRoot(req.user);
    const rel = queryPath(req);
    const abs = resolvePath(rel, root);
    if (!fs.existsSync(abs)) {
      throw httpError(404, '文件夹不存在');
    }
    if (!fs.statSync(abs).isDirectory()) {
      throw httpError(400, '不是文件夹');
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
    const current = relOf(abs, root);
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
    const stats = walkStats(storageRoot(req.user), { bytes: 0, files: 0 });
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
    const abs = resolvePath(queryPath(req), storageRoot(req.user));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw httpError(404, '文件不存在');
    }
    res.setHeader('Content-Disposition', contentDisposition(path.basename(abs), 'attachment'));
    res.sendFile(abs);
  } catch (err) {
    next(err);
  }
});

app.get('/api/preview', (req, res, next) => {
  try {
    const abs = resolvePath(queryPath(req), storageRoot(req.user));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw httpError(404, '文件不存在');
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
      throw httpError(400, '文件夹名不合法');
    }
    const root = storageRoot(req.user);
    const dir = resolvePath(rel, root);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw httpError(400, '目标文件夹不存在');
    }
    const target = path.join(dir, name);
    if (fs.existsSync(target)) {
      throw httpError(409, '同名文件夹已存在');
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
      throw httpError(400, '不能删除根目录');
    }
    const root = storageRoot(req.user);
    const abs = resolvePath(rel, root);
    if (abs === root || !fs.existsSync(abs)) {
      throw httpError(404, '目标不存在');
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
      throw httpError(400, '参数不合法');
    }
    const abs = resolvePath(rel, storageRoot(req.user));
    if (!fs.existsSync(abs)) {
      throw httpError(404, '目标不存在');
    }
    const target = path.join(path.dirname(abs), name);
    if (target !== abs && fs.existsSync(target)) {
      throw httpError(409, '同名文件已存在');
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

app.listen(PORT, HOST, function () {
  const addr = this.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : PORT;
  console.log(`Netdisk listening on http://${HOST}:${boundPort}`);
  console.log(
    passwordIsSet()
      ? 'Netdisk password: 已设置（可在网页内修改）'
      : 'Netdisk password: 未设置，需服务器生成的一次性初始化令牌'
  );
  if (HOST !== '0.0.0.0' && HOST !== '::') {
    console.log('提示: 当前只监听本机。对外访问请用反向代理，或设置 NETDISK_HOST=0.0.0.0。');
  }
});
