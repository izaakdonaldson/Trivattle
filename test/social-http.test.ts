import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { playerFixture } from './player-fixture.js';
import { createApplication } from '../src/player/application.js';
import { battleServer } from '../src/battle/server.js';
import { cfg } from './helpers.js';
import type { TradeView } from '../src/player/social-types.js';
test('authenticated HTTP trades serialize simultaneous confirmations, replay safely and notify only participants', async () => {
  const f = await playerFixture(),
    origin = 'http://localhost:3102';
  const app = await createApplication({
    store: f.store,
    config: cfg(),
    refresh: () => {},
    dbPath: join(f.dir, 'http.sqlite'),
    baseURL: origin,
    secret: 'social-http-testing-secret-1234567890123456789',
    choose: () => 0,
  });
  const server = battleServer({ store: f.store, config: cfg(), application: app });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number },
    root = 'http://127.0.0.1:' + address.port;
  const sockets: Socket[] = [];
  const request = (path: string, cookie = '', body?: unknown) =>
    fetch(root + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  async function user(name: string) {
    const r = await request('/api/auth/sign-up/email', '', {
      name,
      email: name + '@example.com',
      password: 'password123',
    });
    assert.equal(r.status, 200);
    const cookie = r.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; ');
    const me = await (await request('/api/me/bootstrap', cookie, {})).json();
    await fetch(root + '/api/me/pack-openings', {
      method: 'POST',
      headers: {
        cookie,
        origin,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: '{}',
    });
    const socket = io(root, {
      transports: ['websocket'],
      extraHeaders: { cookie, origin },
      forceNew: true,
      reconnection: false,
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return { cookie, me, socket };
  }
  try {
    const a = await user('HTTPA'),
      b = await user('HTTPB'),
      c = await user('HTTPC');
    // Auth can keep this shared connection in a transaction across awaits.
    // Maintenance and player requests must queue until it commits.
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => (started = resolve));
    const held = app.auth.exclusive(async () => {
      app.db.exec('BEGIN IMMEDIATE');
      started();
      await new Promise<void>((resolve) => (release = resolve));
      app.db.exec('COMMIT');
    });
    await entered;
    const pendingStatus = request('/api/me/packs', a.cookie);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    release();
    await held;
    assert.equal((await pendingStatus).status, 200);
    let forbiddenEvents = 0,
      aEvents = 0;
    c.socket.on('trade:updated', () => forbiddenEvents++);
    a.socket.on('trade:updated', () => aEvents++);
    assert.equal((await request('/api/friends')).status, 401);
    const fr = await (
      await request('/api/friends/requests', a.cookie, { code: b.me.friendCode })
    ).json();
    assert.equal(
      (
        await request('/api/friends/' + fr.id, a.cookie, {
          action: 'accept',
          revision: fr.revision,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request('/api/friends/' + fr.id, b.cookie, {
          action: 'accept',
          revision: fr.revision,
        })
      ).status,
      200,
    );
    let t: TradeView = await (
      await request('/api/trades', a.cookie, { friendId: b.me.id, requestId: randomUUID() })
    ).json();
    const command = async (cookie: string, extra: object) => {
      const r = await request('/api/trades/' + t.id, cookie, {
        revision: t.revision,
        requestId: randomUUID(),
        ...extra,
      });
      assert.equal(r.status, 200, await r.clone().text());
      t = await r.json();
    };
    assert.equal((await request('/api/trades/' + t.id, c.cookie)).status, 404);
    await command(b.cookie, { action: 'accept' });
    const ac = await (await request('/api/me/collection', a.cookie)).json(),
      bc = await (await request('/api/me/collection', b.cookie)).json();
    await command(a.cookie, { action: 'offer', instances: [ac.cards[0].id] });
    await command(b.cookie, { action: 'offer', instances: [bc.cards[0].id] });
    const bodies = [a, b].map(() => ({
      action: 'confirm',
      offerRevision: t.offerRevision,
      revision: t.revision,
      requestId: randomUUID(),
    }));
    const attempts = await Promise.all(
      [a, b].map((u, i) => request('/api/trades/' + t.id, u.cookie, bodies[i])),
    );
    assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 409]);
    t = await (await request('/api/trades/' + t.id, a.cookie)).json();
    assert.equal(t.state, 'NEGOTIATING');
    const remaining = t.players.find((p) => !p.confirmed)!.player.id === a.me.id ? a : b;
    const final = {
      action: 'confirm',
      offerRevision: t.offerRevision,
      revision: t.revision,
      requestId: randomUUID(),
    };
    const repeated = await Promise.all(
      [1, 2, 3].map(() => request('/api/trades/' + t.id, remaining.cookie, final)),
    );
    assert.ok(repeated.every((r) => r.status === 200));
    for (const r of repeated) assert.equal((await r.json()).state, 'COMPLETED');
    assert.equal(
      Number(
        app.db.prepare('SELECT count(*) n FROM trade_transfers WHERE trade_id=?').get(t.id)!.n,
      ),
      2,
    );
    assert.equal((await request('/api/me/collection/' + ac.cards[0].id, a.cookie)).status, 404);
    assert.equal((await request('/api/me/collection/' + ac.cards[0].id, b.cookie)).status, 200);
    // Separate HTTP requests race for the same instance across different trades.
    const parallel: TradeView[] = [];
    for (let i = 0; i < 2; i++) {
      const invite: TradeView = await (
        await request('/api/trades', a.cookie, { friendId: b.me.id, requestId: randomUUID() })
      ).json();
      parallel.push(
        await (
          await request('/api/trades/' + invite.id, b.cookie, {
            action: 'accept',
            revision: invite.revision,
            requestId: randomUUID(),
          })
        ).json(),
      );
    }
    const offers = await Promise.all(
      parallel.map((v) =>
        request('/api/trades/' + v.id, a.cookie, {
          action: 'offer',
          instances: [ac.cards[1].id],
          revision: v.revision,
          requestId: randomUUID(),
        }),
      ),
    );
    assert.deepEqual(offers.map((r) => r.status).sort(), [200, 409]);
    assert.equal(
      Number(
        app.db
          .prepare('SELECT count(*) n FROM trade_reservations WHERE instance_id=?')
          .get(ac.cards[1].id)!.n,
      ),
      1,
    );
    assert.ok(!JSON.stringify(t).includes('email'));
    assert.ok(!JSON.stringify(t).includes('correctIndex'));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(forbiddenEvents, 0);
    assert.ok(aEvents > 0);
  } finally {
    for (const s of sockets) s.disconnect();
    await new Promise<void>((resolve) => {
      app.close();
      server.close(() => resolve());
    });
    f.clean();
  }
});
