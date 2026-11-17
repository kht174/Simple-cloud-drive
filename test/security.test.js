const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { afterEach, test } = require('node:test');

const root = path.resolve(__dirname, '..');
const servers = [];

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

async function startServer(options = {}) {
  const dir = options.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'netdisk-security-'));
  const port = await unusedPort();
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      NETDISK_HOST: '127.0.0.1',
      NETDISK_DIR: path.join(dir, 'storage'),
      NETDISK_CONFIG: path.join(dir, 'config.json'),
      NETDISK_PASSWORD: '',
      TRUST_PROXY: '',
      NETDISK_TRUST_PROXY: '',
      INSTABOX_TERM_SESSION: '',
      INSTABOX_TERM_DIR: '',
      ...options.env,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const instance = { child, dir, port, url: `http://127.0.0.1:${port}` };
  servers.push(instance);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}: ${stderr}`);
    try {
      const response = await fetch(`${instance.url}/api/session`);
      if (response.ok) return instance;
    } catch {
      await delay(50);
    }
  }
  throw new Error('server did not become ready');
}

async function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async ({ child, dir }) => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }));
});

test('first password requires the one-time setup token and consumes it', async () => {
  const server = await startServer();
  const configPath = path.join(server.dir, 'config.json');
  const tokenPath = path.join(server.dir, '.initial-setup-token');
  const token = fs.readFileSync(tokenPath, 'utf8').trim();

  assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
  const denied = await postJson(`${server.url}/api/password`, { newPassword: 'strong-pass' }, {
    Origin: server.url,
  });
  assert.equal(denied.status, 403);

  const response = await postJson(`${server.url}/api/password`, {
    setupToken: token,
    newPassword: 'strong-pass',
  }, {
    Origin: server.url,
    'X-Forwarded-Proto': 'https',
  });
  assert.equal(response.status, 200);
  assert.doesNotMatch(response.headers.get('set-cookie'), /;\s*Secure/i);
  assert.equal(fs.existsSync(tokenPath), false);
  assert.equal('setupTokenHash' in JSON.parse(fs.readFileSync(configPath, 'utf8')), false);

  const reused = await postJson(`${server.url}/api/password`, {
    setupToken: token,
    newPassword: 'another-pass',
  }, {
    Origin: server.url,
  });
  assert.equal(reused.status, 401);
});

test('Instabox trusts its one-hop proxy while still rejecting cross-site requests', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netdisk-security-config-'));
  const configPath = path.join(dir, 'config.json');
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(configPath, JSON.stringify({
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    passwordVersion: 1,
    passwordSalt: salt,
    passwordHash: crypto.scryptSync('strong-pass', salt, 64).toString('hex'),
  }));
  fs.mkdirSync(path.join(dir, 'storage'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'storage', 'legacy-file.txt'), 'legacy data');

  const server = await startServer({
    dir,
    env: {
      NETDISK_CONFIG: configPath,
      NETDISK_DIR: path.join(dir, 'storage'),
      INSTABOX_TERM_SESSION: 'instabox-test',
    },
  });

  const trustedHeaders = {
    Origin: 'https://drive.example.test',
    Host: `127.0.0.1:${server.port}`,
    'X-Forwarded-Host': 'drive.example.test',
    'X-Forwarded-Proto': 'https',
    'Sec-Fetch-Site': 'same-origin',
  };
  const response = await postJson(`${server.url}/api/login`, { password: 'strong-pass' }, trustedHeaders);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /;\s*Secure/i);
  const legacyFiles = await fetch(`${server.url}/api/list`, {
    headers: { Cookie: response.headers.get('set-cookie').split(';')[0] },
  });
  assert.equal((await legacyFiles.json()).entries[0].name, 'legacy-file.txt');

  const crossSite = await postJson(`${server.url}/api/logout`, {}, {
    ...trustedHeaders,
    Origin: 'https://attacker.example',
    'Sec-Fetch-Site': 'cross-site',
  });
  assert.equal(crossSite.status, 403);
});

test('admin-managed accounts enforce isolated and shared storage modes', async () => {
  const server = await startServer();
  const token = fs.readFileSync(path.join(server.dir, '.initial-setup-token'), 'utf8').trim();
  const setup = await postJson(`${server.url}/api/password`, {
    username: 'owner',
    setupToken: token,
    newPassword: 'owner-pass',
  });
  assert.equal(setup.status, 200);
  const adminCookie = setup.headers.get('set-cookie').split(';')[0];

  fs.writeFileSync(path.join(server.dir, 'storage', 'private.txt'), 'owner data');
  const created = await postJson(`${server.url}/api/users`, {
    username: 'alice',
    password: 'alice-pass',
  }, { Cookie: adminCookie });
  assert.equal(created.status, 201);
  const alice = (await created.json()).user;

  const ownerList = await fetch(`${server.url}/api/list`, {
    headers: { Cookie: adminCookie },
  });
  assert.equal(ownerList.status, 200);
  assert.equal((await ownerList.json()).entries[0].name, 'private.txt');
  const adminOnly = await fetch(`${server.url}/api/users`, {
    headers: { Cookie: adminCookie },
  });
  assert.equal(adminOnly.status, 200);

  const login = await postJson(`${server.url}/api/login`, {
    username: 'alice',
    password: 'alice-pass',
  });
  assert.equal(login.status, 200);
  const aliceCookie = login.headers.get('set-cookie').split(';')[0];
  const forbiddenUsers = await fetch(`${server.url}/api/users`, {
    headers: { Cookie: aliceCookie },
  });
  assert.equal(forbiddenUsers.status, 403);
  const isolated = await fetch(`${server.url}/api/list`, {
    headers: { Cookie: aliceCookie },
  });
  assert.equal(isolated.status, 200);
  assert.deepEqual((await isolated.json()).entries, []);
  const mkdir = await postJson(`${server.url}/api/mkdir`, {
    path: '',
    name: 'alice-files',
  }, { Cookie: aliceCookie });
  assert.equal(mkdir.status, 200);
  const ownFiles = await fetch(`${server.url}/api/list`, {
    headers: { Cookie: aliceCookie },
  });
  assert.equal((await ownFiles.json()).entries[0].name, 'alice-files');

  const traversal = await fetch(`${server.url}/api/list?path=..%2F..%2Fstorage`, {
    headers: { Cookie: aliceCookie },
  });
  assert.equal(traversal.status, 400);
  assert.equal(alice.role, 'user');

  const changedPassword = await postJson(`${server.url}/api/password`, {
    currentPassword: 'alice-pass',
    newPassword: 'alice-new-pass',
  }, { Cookie: aliceCookie });
  assert.equal(changedPassword.status, 200);
  const staleSession = await fetch(`${server.url}/api/list`, {
    headers: { Cookie: aliceCookie },
  });
  assert.equal(staleSession.status, 401);
  const ownerStillWorks = await fetch(`${server.url}/api/users`, {
    headers: { Cookie: adminCookie },
  });
  assert.equal(ownerStillWorks.status, 200);

  const deleted = await fetch(`${server.url}/api/users/${alice.id}`, {
    method: 'DELETE',
    headers: { Cookie: adminCookie },
  });
  assert.equal(deleted.status, 200);

  const invalidMode = await postJson(`${server.url}/api/users`, {
    username: 'bad-mode',
    password: 'valid-pass',
    storageMode: 'somewhere-else',
  }, { Cookie: adminCookie });
  assert.equal(invalidMode.status, 400);
  const sharedCreated = await postJson(`${server.url}/api/users`, {
    username: 'shared',
    password: 'shared-pass',
    storageMode: 'shared',
  }, { Cookie: adminCookie });
  assert.equal(sharedCreated.status, 201);
  const sharedUser = (await sharedCreated.json()).user;
  assert.equal(sharedUser.storageMode, 'shared');
  const sharedLogin = await postJson(`${server.url}/api/login`, {
    username: 'shared',
    password: 'shared-pass',
  });
  assert.equal(sharedLogin.status, 200);
  const sharedCookie = sharedLogin.headers.get('set-cookie').split(';')[0];
  const sharedList = await fetch(`${server.url}/api/list`, {
    headers: { Cookie: sharedCookie },
  });
  assert.equal((await sharedList.json()).entries[0].name, 'private.txt');
  const sharedMkdir = await postJson(`${server.url}/api/mkdir`, {
    path: '',
    name: 'shared-folder',
  }, { Cookie: sharedCookie });
  assert.equal(sharedMkdir.status, 200);

  const deletedShared = await fetch(`${server.url}/api/users/${sharedUser.id}`, {
    method: 'DELETE',
    headers: { Cookie: adminCookie },
  });
  assert.equal(deletedShared.status, 200);
  const ownerAfterSharedDelete = await fetch(`${server.url}/api/list`, {
    headers: { Cookie: adminCookie },
  });
  const ownerEntries = (await ownerAfterSharedDelete.json()).entries.map((entry) => entry.name);
  assert.deepEqual(ownerEntries, ['shared-folder', 'private.txt']);
});
