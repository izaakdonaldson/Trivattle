import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage } from 'node:http';
import { deploymentConfig, clientIP } from '../src/deployment.js';
import { verifyCatalogue, backupDatabase } from '../src/deployment-storage.js';
import { fixture } from './battle-fixture.js';
import { cfg } from './helpers.js';
import { battleServer } from '../src/battle/server.js';

const secret = 'test-deployment-secret-with-32-characters';
test('production requires HTTPS origin and secret, binds publicly and accepts Render URL', () => {
  const env = {
    NODE_ENV: 'production',
    BETTER_AUTH_SECRET: secret,
    RENDER_EXTERNAL_URL: 'https://example.onrender.com',
    PORT: '10000',
  };
  assert.equal(deploymentConfig(env).host, '0.0.0.0');
  assert.equal(deploymentConfig(env).port, 10000);
  assert.equal(deploymentConfig(env).baseURL, env.RENDER_EXTERNAL_URL);
  assert.equal(
    deploymentConfig({ ...env, BETTER_AUTH_URL: 'https://trivattle.tech/' }).baseURL,
    'https://trivattle.tech',
  );
  for (const url of [
    '',
    'http://example.com',
    'https://user:password@example.com',
    'https://example.com/path',
    'https://example.com/?token=secret',
  ])
    assert.throws(() =>
      deploymentConfig({ ...env, RENDER_EXTERNAL_URL: '', BETTER_AUTH_URL: url }),
    );
  for (const port of ['0', '-1', '65536', 'abc'])
    assert.throws(() => deploymentConfig({ ...env, PORT: port }));
  assert.throws(() => deploymentConfig({ ...env, BETTER_AUTH_SECRET: 'short' }));
  assert.throws(() => deploymentConfig({ ...env, TRUST_RENDER_PROXY: 'true' }));
  assert.equal(
    deploymentConfig({ ...env, RENDER: 'true', TRUST_RENDER_PROXY: 'true' }).trustRenderProxy,
    true,
  );
  assert.equal(deploymentConfig({ BETTER_AUTH_SECRET: secret }).host, '127.0.0.1');
});

test('client IP ignores forwarding headers unless explicitly trusted and validates a single IP', () => {
  const req = (value: string | string[] | undefined) =>
    ({
      headers: {
        'cf-connecting-ip': value,
        'x-forwarded-for': '192.0.2.99',
        'x-trivattle-client-ip': '192.0.2.88',
      },
      socket: { remoteAddress: '127.0.0.1' },
    }) as unknown as IncomingMessage;
  assert.equal(clientIP(req('192.0.2.1'), false), '127.0.0.1');
  assert.equal(clientIP(req('192.0.2.1'), true), '192.0.2.1');
  assert.equal(clientIP(req('2001:db8::1'), true), '2001:db8::1');
  for (const value of [undefined, '', 'bad', '192.0.2.1, 192.0.2.2', ['192.0.2.1'], '192.0.2.1:80'])
    assert.equal(clientIP(req(value), true), '127.0.0.1');
});

test('health is minimal and static server never exposes private deployment files', async () => {
  const f = fixture();
  const server = battleServer({ store: f.store, config: cfg(), localLab: false });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(base + '/health');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    for (const path of [
      '/data/catalogue/catalogue.json',
      '/data/cards-server.json',
      '/.env',
      '/data/player/player.sqlite',
      '/__test/clock',
      '/api/battles',
    ])
      assert.equal((await fetch(base + path)).status, 404);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    f.clean();
  }
});

test('catalogue verification reads arbitrary upload filename without modifying it and rejects missing pools', () => {
  const f = fixture();
  const upload = join(f.store.directory, 'catalogue.upload.json');
  try {
    copyFileSync(f.store.path, upload);
    const before = readFileSync(upload);
    const report = verifyCatalogue(upload, cfg(), [55, 28, 12, 4, 1]);
    assert.equal(report.playable, 10);
    assert.match(report.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(before, readFileSync(upload));
    const data = JSON.parse(before.toString());
    for (const [id, version] of Object.entries(data.published))
      if (data.cards[version as string].rarity === 'legendary') delete data.published[id];
    writeFileSync(upload, JSON.stringify(data));
    assert.throws(() => verifyCatalogue(upload, cfg(), [55, 28, 12, 4, 1]), /rarity/);
    writeFileSync(upload, '{"schemaVersion":1}');
    assert.throws(() => verifyCatalogue(upload, cfg(), [55, 28, 12, 4, 1]));
    assert.throws(() =>
      verifyCatalogue(join(f.store.directory, 'missing'), cfg(), [55, 28, 12, 4, 1]),
    );
  } finally {
    f.clean();
  }
});

test('SQLite backup includes committed WAL data and refuses overwrite or source replacement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trivattle-backup-'));
  const source = join(dir, 'player.sqlite'),
    target = join(dir, 'backup.sqlite');
  const db = new DatabaseSync(source);
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE example(value TEXT); INSERT INTO example VALUES ('kept')",
    );
    await backupDatabase(source, target);
    const restored = new DatabaseSync(target, { readOnly: true });
    assert.equal(restored.prepare('SELECT value FROM example').get()!.value, 'kept');
    assert.equal(restored.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    restored.close();
    const before = readFileSync(target);
    await assert.rejects(backupDatabase(source, target));
    assert.deepEqual(readFileSync(target), before);
    await assert.rejects(backupDatabase(source, source));
    assert.equal(db.prepare('SELECT value FROM example').get()!.value, 'kept');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unexpected HTTP failures return generic errors and never log exception contents', async () => {
  const f = fixture();
  const previous = console.error;
  const logs: unknown[] = [];
  console.error = (...values) => logs.push(...values);
  const server = battleServer({
    store: f.store,
    config: cfg(),
    application: {
      attach() {},
      async handle() {
        throw Error('sensitive-password-and-trivia-answer');
      },
    } as unknown as import('../src/player/application.js').Application,
  });
  try {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/me`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Unable to complete request' });
    assert.ok(JSON.stringify(logs).includes('http_request_failed'));
    assert.ok(!JSON.stringify(logs).includes('sensitive-password'));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    console.error = previous;
    f.clean();
  }
});

test('production process serves health without catalogue, exits on SIGTERM, and retains database', async () => {
  const { spawn } = await import('node:child_process');
  const { createServer } = await import('node:net');
  const listener = createServer();
  await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((r) => listener.close(() => r()));
  const dir = mkdtempSync(join(tmpdir(), 'trivattle-production-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/battle/server.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: 'https://trivattle.tech',
      PORT: String(port),
      HOST: '127.0.0.1',
      TRUST_RENDER_PROXY: 'false',
      PLAYER_DB: join(dir, 'player.sqlite'),
      CARD_DATA_DIR: join(dir, 'missing'),
      IMAGE_CACHE_DIR: join(dir, 'art'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (s) => {
    output += s;
  });
  child.stderr.on('data', (s) => {
    output += s;
  });
  const exited = new Promise<number | null>((r) => child.on('exit', r));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(poll);
        reject(Error('Startup timeout'));
      }, 15000);
      const poll = setInterval(() => {
        if (output.includes('server_started')) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve();
        } else if (child.exitCode !== null) {
          clearTimeout(timer);
          clearInterval(poll);
          reject(Error('Startup failed'));
        }
      }, 25);
    });
    assert.match(output, /Catalogue missing or empty/);
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/health`)).json(), {
      status: 'ok',
    });
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
    assert.ok(!output.includes(secret));
    const db = new DatabaseSync(join(dir, 'player.sqlite'), { readOnly: true });
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM app_migrations').get()!.n, 4);
    db.close();
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
