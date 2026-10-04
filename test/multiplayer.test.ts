import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { playerFixture } from './player-fixture.js';
import { Rooms } from '../src/multiplayer/rooms.js';
import { createApplication } from '../src/player/application.js';
import { battleServer } from '../src/battle/server.js';
import { cfg } from './helpers.js';
import { io, type Socket } from 'socket.io-client';
import { join } from 'node:path';
import type { LobbyView, Reply } from '../src/player/types.js';
test('private selection, ready locking, isolated battle, actors, duplicate commands and reconnect timeout', async () => {
  const f = await playerFixture();
  try {
    let now = 0;
    const rooms = new Rooms(f.inventory, () => now);
    const a = await f.user(),
      b = await f.user(),
      c = await f.user();
    for (const id of [a, b]) {
      f.inventory.bootstrap(id);
      f.inventory.open(id, randomUUID());
      rooms.presence(id, id, true);
    }
    const r = rooms.create({ id: a, name: 'A' });
    assert.equal(rooms.join({ id: a, name: 'A' }, r.code).members.length, 1);
    rooms.join({ id: b, name: 'B' }, r.code);
    assert.throws(() => rooms.join({ id: c, name: 'C' }, r.code), /full/);
    const command = (id: string, event: string, extra: Record<string, unknown> = {}) =>
      rooms.command(id, event, {
        roomId: r.id,
        requestId: randomUUID(),
        revision: r.revision,
        ...extra,
      });
    const ids = (u: string) =>
      f.inventory
        .collection(u, new URLSearchParams('grouped=false'))
        .cards.slice(0, 5)
        .map((c) => c.id);
    assert.throws(() => command(b, 'lobby:select', { selection: ids(a) }));
    assert.throws(() => command(a, 'lobby:select', { selection: Array(5).fill(ids(a)[0]) }));
    command(a, 'lobby:select', { selection: ids(a) });
    command(a, 'lobby:ready');
    const privateView = JSON.stringify(rooms.view(r, b));
    for (const id of ids(a)) assert.ok(!privateView.includes(id));
    assert.equal(rooms.view(r, b).battle, null);
    assert.throws(() => command(a, 'lobby:select', { selection: ids(a) }), /Unready/);
    command(a, 'lobby:unready');
    command(a, 'lobby:ready');
    command(b, 'lobby:select', { selection: ids(b) });
    command(b, 'lobby:ready');
    assert.equal(r.status, 'in-battle');
    assert.ok(r.state);
    const original = JSON.stringify(f.store.data),
      owned = f.inventory.collection(a, new URLSearchParams()).copies;
    const attack = {
      kind: 'attack',
      commandId: randomUUID(),
      revision: 0,
      attackerId: r.state!.teams[0][0]!.instanceId,
      attackId: r.state!.teams[0][0]!.card.attacks[0]!.id,
      targetId: r.state!.teams[1][0]!.instanceId,
    };
    assert.throws(() => command(b, 'battle:command', { command: attack }), /turn/);
    command(a, 'battle:command', { command: attack });
    assert.equal(rooms.view(r, a).announcementUntil, 3000);
    const pending = rooms.view(r, b).battle!.pending!;
    assert.ok(pending.question);
    assert.deepEqual(rooms.view(r, a).battle!.pending, pending);
    assert.ok(!JSON.stringify(pending).includes('correctIndex'));
    const answer = {
      kind: 'answer',
      commandId: randomUUID(),
      revision: 1,
      questionId: pending.question.id,
      answerIndex: 1,
    };
    assert.throws(() => command(a, 'battle:command', { command: answer }), /defending/);
    command(b, 'battle:command', { command: answer });
    assert.throws(() => command(b, 'battle:command', { command: answer }));
    assert.equal(JSON.stringify(f.store.data), original);
    assert.equal(f.inventory.collection(a, new URLSearchParams()).copies, owned);
    rooms.presence(b, 'second', true);
    rooms.presence(b, b, false);
    assert.equal(rooms.paused(r), false);
    rooms.presence(b, 'second', false);
    assert.equal(rooms.paused(r), true);
    now = 119999;
    rooms.sweep();
    assert.equal(r.status, 'in-battle');
    rooms.presence(b, b, true);
    assert.equal(rooms.paused(r), false);
    rooms.presence(b, b, false);
    now += 120000;
    rooms.sweep();
    assert.equal(r.status, 'abandoned');
    assert.equal(r.state!.winner, null);
  } finally {
    f.clean();
  }
});
test('real HTTP auth, sessions, two sockets, private projections, logout and foreign access', async () => {
  const f = await playerFixture();
  const application = await createApplication({
    store: f.store,
    config: cfg(),
    refresh: () => {},
    dbPath: join(f.dir, 'http.sqlite'),
    baseURL: 'http://localhost:3102',
    secret: 'testing-secret-123456789012345678901234',
    settings: f.settings,
    choose: () => 0,
  });
  const server = battleServer({ store: f.store, config: cfg(), application, localLab: false });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const root = `http://127.0.0.1:${port}`;
  const sockets: Socket[] = [];
  const request = (path: string, cookie = '', body?: unknown) =>
    fetch(root + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, origin: 'http://localhost:3102', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    assert.equal((await request('/api/me')).status, 401);
    assert.equal((await request('/api/cards')).status, 404);
    async function register(email: string) {
      const r = await request('/api/auth/sign-up/email', '', {
        email,
        password: 'password123',
        name: email.split('@')[0],
      });
      assert.equal(r.status, 200);
      return r.headers
        .getSetCookie()
        .map((s) => s.split(';')[0])
        .join('; ');
    }
    const a = await register('a@example.com'),
      b = await register('b@example.com'),
      c = await register('c@example.com');
    assert.equal(
      (
        await request('/api/auth/sign-up/email', '', {
          email: 'a@example.com',
          password: 'password123',
          name: 'A',
        })
      ).status >= 400,
      true,
    );
    assert.equal(
      (
        await request('/api/auth/sign-in/email', '', {
          email: 'a@example.com',
          password: 'wrong-password',
        })
      ).status >= 400,
      true,
    );
    for (const cookie of [a, b]) {
      assert.equal((await request('/api/me/bootstrap', cookie, {})).status, 200);
      if (cookie === b)
        await fetch(root + '/api/me/pack-openings', {
          method: 'POST',
          headers: {
            cookie,
            origin: 'http://localhost:3102',
            'content-type': 'application/json',
            'Idempotency-Key': randomUUID(),
          },
          body: '{}',
        });
      assert.equal((await request('/api/me', cookie)).status, 200);
    }
    const key = randomUUID();
    const open = () =>
      fetch(root + '/api/me/pack-openings', {
        method: 'POST',
        headers: {
          cookie: a,
          origin: 'http://localhost:3102',
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: '{}',
      }).then((r) => r.json());
    const rewards = await Promise.all([open(), open(), open()]);
    assert.equal(new Set(rewards.map((r) => r.id)).size, 1);
    assert.equal((await (await request('/api/me', a)).json()).packs, 2);
    const denied = await fetch(root + '/api/me/bootstrap', {
      method: 'POST',
      headers: { cookie: a, origin: 'http://foreign.example' },
    });
    assert.equal(denied.status, 403);
    async function connect(cookie: string) {
      const s = io(root, {
        extraHeaders: { cookie, origin: 'http://localhost:3102' },
        transports: ['websocket'],
        forceNew: true,
      });
      sockets.push(s);
      await new Promise<void>((r, j) => {
        s.once('connect', r);
        s.once('connect_error', j);
      });
      return s;
    }
    const sa = await connect(a),
      sb = await connect(b);
    let room = (await (await request('/api/lobbies', a, {})).json()) as LobbyView;
    room = await (await request('/api/lobbies/join', b, { code: room.code })).json();
    assert.equal((await request(`/api/lobbies/${room.id}`, c)).status, 404);
    const ac = await (await request('/api/me/collection?grouped=false', a)).json(),
      bc = await (await request('/api/me/collection?grouped=false', b)).json();
    assert.equal((await request(`/api/me/collection/${ac.cards[0].id}`, b)).status, 404);
    async function send(
      s: Socket,
      cookie: string,
      event: string,
      extra: Record<string, unknown> = {},
    ) {
      const v = await (await request(`/api/lobbies/${room.id}`, cookie)).json();
      return s.timeout(3000).emitWithAck(event, {
        roomId: room.id,
        revision: v.revision,
        requestId: randomUUID(),
        ...extra,
      }) as Promise<Reply>;
    }
    assert.equal(
      (
        await send(sa, a, 'lobby:select', {
          selection: ac.cards.slice(0, 5).map((x: { id: string }) => x.id),
        })
      ).ok,
      true,
    );
    assert.equal((await send(sa, a, 'lobby:ready')).ok, true);
    const bv = JSON.stringify(await (await request(`/api/lobbies/${room.id}`, b)).json());
    for (const card of ac.cards) assert.ok(!bv.includes(card.id));
    assert.equal(
      (await send(sb, b, 'lobby:select', { selection: bc.cards.map((x: { id: string }) => x.id) }))
        .ok,
      true,
    );
    const started = await send(sb, b, 'lobby:ready');
    assert.ok(started.ok && started.view?.battle);
    const before = application.rooms.rooms.get(room.id)!.state!.id;
    assert.equal((await send(sa, a, 'lobby:ready')).ok, false);
    assert.equal(application.rooms.rooms.get(room.id)!.state!.id, before);
    await request('/api/auth/sign-out', a, {});
    assert.equal((await request('/api/me', a)).status, 401);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sa.connected, false);
  } finally {
    for (const s of sockets) s.disconnect();
    application.close();
    await new Promise<void>((r) => server.close(() => r()));
    f.clean();
  }
});

test('ready revalidates ownership, preserves positions, and guest leaving clears both drafts', async () => {
  const f = await playerFixture();
  try {
    const rooms = new Rooms(f.inventory),
      a = await f.user(),
      b = await f.user();
    for (const id of [a, b]) {
      f.inventory.bootstrap(id);
      f.inventory.open(id, randomUUID());
      rooms.presence(id, id, true);
    }
    const room = rooms.create({ id: a, name: 'A' });
    rooms.join({ id: b, name: 'B' }, room.code);
    const ids = (id: string) =>
      f.inventory
        .collection(id, new URLSearchParams('grouped=false'))
        .cards.map((c) => c.id)
        .reverse();
    const aIds = ids(a),
      bIds = ids(b);
    const send = (id: string, event: string, extra: Record<string, unknown> = {}) =>
      rooms.command(id, event, {
        roomId: room.id,
        requestId: randomUUID(),
        revision: room.revision,
        ...extra,
      });
    send(a, 'lobby:select', { selection: aIds });
    send(b, 'lobby:select', { selection: bIds });
    send(a, 'lobby:ready');
    f.db.prepare('UPDATE owned_cards SET user_id=? WHERE id=?').run(b, aIds[0]!);
    assert.throws(() => send(b, 'lobby:ready'), /no longer valid/);
    assert.equal(room.state, undefined);
    assert.ok(room.members.every((m) => !m.ready));
    f.db.prepare('UPDATE owned_cards SET user_id=? WHERE id=?').run(a, aIds[0]!);
    send(b, 'lobby:leave');
    assert.equal(room.status, 'waiting');
    assert.ok(room.members[0]!.selection.every((x) => x === null));
    rooms.join({ id: b, name: 'B' }, room.code);
    send(a, 'lobby:select', { selection: aIds });
    send(b, 'lobby:select', { selection: bIds });
    send(a, 'lobby:ready');
    send(b, 'lobby:ready');
    assert.deepEqual(
      room.state!.teams[0].map((u) => u.card.versionId),
      aIds.map((id) => f.inventory.owned(a, id).versionId),
    );
    assert.deepEqual(
      room.state!.teams[0].map((u) => u.position),
      [0, 1, 2, 3, 4],
    );
  } finally {
    f.clean();
  }
});
