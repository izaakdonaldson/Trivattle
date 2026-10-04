import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { playerFixture } from './player-fixture.js';
import { Friends } from '../src/player/friends.js';
import { Trades } from '../src/player/trades.js';
import { Rooms } from '../src/multiplayer/rooms.js';
import type { TradeView } from '../src/player/social-types.js';
async function setup() {
  const f = await playerFixture(),
    a = await f.user(),
    b = await f.user(),
    c = await f.user();
  let now = Date.now();
  const friends = new Friends(f.db, () => now),
    connected = new Set([a, b, c]),
    trades = new Trades(
      f.inventory,
      friends,
      (u) => connected.has(u),
      () => now,
    ),
    rooms = new Rooms(f.inventory, () => now);
  f.inventory.battleCommitted = (id) =>
    [...rooms.rooms.values()].some(
      (r) => r.ended === null && r.members.some((m) => m.selection.includes(id)),
    );
  for (const id of [a, b, c]) {
    friends.profile(id);
    f.inventory.bootstrap(id);
    f.inventory.open(id, randomUUID());
  }
  const req = friends.request(a, friends.profile(b).friendCode);
  friends.act(b, req.id, 'accept', req.revision);
  const session = (id: string) =>
    String(f.db.prepare('SELECT id FROM session WHERE userId=?').get(id)!.id);
  const ids = (id: string) =>
    f.inventory.collection(id, new URLSearchParams()).cards.map((c) => c.id);
  const cmd = (user: string, t: TradeView, extra: object) =>
    trades.command(user, session(user), t.id, {
      requestId: randomUUID(),
      revision: t.revision,
      ...extra,
    });
  const invite = () => {
    const t = trades.invite(a, b, randomUUID());
    return cmd(b, t, { action: 'accept' });
  };
  return {
    ...f,
    a,
    b,
    c,
    friends,
    trades,
    rooms,
    connected,
    session,
    ids,
    cmd,
    invite,
    advance: (ms: number) => (now += ms),
  };
}
test('exact offers, resets, atomic exchange, duplicate settlement and immutable history', async () => {
  const f = await setup();
  try {
    const { a, b, trades, cmd, ids } = f,
      ai = ids(a),
      bi = ids(b);
    const oldPack = f.inventory.history(a)[0]!;
    let t = f.invite();
    assert.throws(() => cmd(a, t, { action: 'offer', instances: [bi[0]] }));
    assert.throws(() => cmd(a, t, { action: 'offer', instances: [ai[0], ai[0]] }));
    assert.throws(() => trades.detail(f.c, t.id));
    t = cmd(a, t, { action: 'offer', instances: [ai[0]] });
    t = cmd(b, t, { action: 'offer', instances: [bi[0]] });
    t = cmd(a, t, { action: 'confirm', offerRevision: t.offerRevision });
    assert.equal(t.players[0]!.confirmed, true);
    const stale = t;
    t = cmd(b, t, { action: 'offer', instances: [bi[0], bi[1]] });
    assert.ok(t.players.every((p) => !p.confirmed));
    assert.throws(() => cmd(a, stale, { action: 'confirm', offerRevision: stale.offerRevision }));
    t = cmd(a, t, { action: 'confirm', offerRevision: t.offerRevision });
    const request = {
      action: 'confirm',
      requestId: randomUUID(),
      revision: t.revision,
      offerRevision: t.offerRevision,
    };
    t = trades.command(b, f.session(b), t.id, request);
    assert.equal(t.state, 'COMPLETED');
    assert.equal(trades.command(b, f.session(b), t.id, request).state, 'COMPLETED');
    assert.equal(f.inventory.owned(b, ai[0]!).source, 'trade');
    assert.equal(f.inventory.owned(a, bi[0]!).source, 'trade');
    assert.equal(ids(a).length, 6);
    assert.equal(ids(b).length, 4);
    assert.deepEqual(
      f.inventory.open(
        a,
        String(
          f.db.prepare('SELECT request_key FROM pack_openings WHERE id=?').get(oldPack.id)!
            .request_key,
        ),
      ),
      oldPack,
    );
    const history = trades.detail(a, t.id);
    let next = f.invite();
    next = cmd(a, next, { action: 'offer', instances: [bi[0]] });
    next = cmd(b, next, { action: 'offer', instances: [ai[0]] });
    next = cmd(a, next, { action: 'confirm', offerRevision: next.offerRevision });
    cmd(b, next, { action: 'confirm', offerRevision: next.offerRevision });
    assert.deepEqual(trades.detail(a, t.id).players, history.players);
    assert.equal(
      Number(f.db.prepare('SELECT count(*) n FROM trade_transfers WHERE trade_id=?').get(t.id)!.n),
      3,
    );
  } finally {
    f.clean();
  }
});
test('reservations exclude competing trades and lobbies; cancellation and expiry release them', async () => {
  const f = await setup();
  try {
    let t = f.invite();
    const ai = f.ids(f.a);
    t = f.cmd(f.a, t, { action: 'offer', instances: [ai[0]] });
    const other = f.invite();
    assert.throws(
      () => f.cmd(f.a, other, { action: 'offer', instances: [ai[0]] }),
      /another trade/,
    );
    assert.throws(() => f.inventory.resolve(f.a, ai), /reserved/);
    t = f.cmd(f.a, t, { action: 'cancel' });
    assert.equal(f.inventory.resolve(f.a, ai).length, 5);
    f.rooms.presence(f.a, 'a', true);
    f.rooms.presence(f.b, 'b', true);
    const room = f.rooms.create({ id: f.a, name: 'A' });
    f.rooms.join({ id: f.b, name: 'B' }, room.code);
    f.rooms.command(f.a, 'lobby:select', {
      roomId: room.id,
      requestId: randomUUID(),
      revision: room.revision,
      selection: ai,
    });
    assert.throws(() => f.cmd(f.a, other, { action: 'offer', instances: [ai[0]] }), /committed/);
    f.rooms.command(f.a, 'lobby:leave', {
      roomId: room.id,
      requestId: randomUUID(),
      revision: room.revision,
    });
    f.cmd(f.a, other, { action: 'offer', instances: [ai[0]] });
    f.advance(1800000);
    assert.equal(f.trades.detail(f.a, other.id).state, 'EXPIRED');
    assert.equal(f.inventory.reservedTrade(ai[0]!), undefined);
  } finally {
    f.clean();
  }
});
test('rollback, disconnect, session revocation, restart and friendship removal clear confirmations safely', async () => {
  const f = await setup();
  try {
    let t = f.invite();
    t = f.cmd(f.a, t, { action: 'offer', instances: [f.ids(f.a)[0]] });
    t = f.cmd(f.b, t, { action: 'offer', instances: [f.ids(f.b)[0]] });
    const ai = f.ids(f.a),
      bi = f.ids(f.b);
    t = f.cmd(f.a, t, { action: 'confirm', offerRevision: t.offerRevision });
    f.db.exec(
      "CREATE TRIGGER fail_transfer BEFORE UPDATE OF user_id ON owned_cards WHEN NEW.user_id='" +
        f.a +
        "' BEGIN SELECT RAISE(ABORT,'failure'); END",
    );
    assert.throws(() => f.cmd(f.b, t, { action: 'confirm', offerRevision: t.offerRevision }));
    assert.deepEqual(f.ids(f.a), ai);
    assert.deepEqual(f.ids(f.b), bi);
    t = f.trades.detail(f.a, t.id);
    assert.ok(t.players.every((p) => !p.confirmed));
    f.db.exec('DROP TRIGGER fail_transfer');
    t = f.cmd(f.a, t, { action: 'confirm', offerRevision: t.offerRevision });
    f.connected.delete(f.b);
    f.trades.presence(f.b);
    t = f.trades.detail(f.a, t.id);
    assert.ok(t.players.every((p) => !p.confirmed));
    f.connected.add(f.b);
    t = f.cmd(f.a, t, { action: 'confirm', offerRevision: t.offerRevision });
    const restored = new Trades(f.inventory, f.friends, (u) => f.connected.has(u));
    t = restored.detail(f.a, t.id);
    assert.ok(t.players.every((p) => !p.confirmed));
    t = f.cmd(f.a, t, { action: 'confirm', offerRevision: t.offerRevision });
    f.db.prepare('DELETE FROM session WHERE userId=?').run(f.a);
    t = f.trades.detail(f.b, t.id);
    assert.ok(t.players.every((p) => !p.confirmed));
    const friend = f.friends.list(f.a).items[0]!;
    f.friends.act(f.a, friend.id, 'remove', friend.revision);
    assert.equal(f.trades.detail(f.b, t.id).state, 'CANCELLED');
    assert.equal(f.inventory.reservedTrade(ai[0]!), undefined);
  } finally {
    f.clean();
  }
});

test('trade authorization, stale offer confirmation, invalidated ownership and invitation limits', async () => {
  const f = await setup();
  try {
    assert.throws(() => f.trades.invite(f.a, f.c, randomUUID()), /friends/);
    let t = f.invite();
    const ai = f.ids(f.a)[0]!,
      bi = f.ids(f.b)[0]!;
    t = f.cmd(f.a, t, { action: 'offer', instances: [ai] });
    t = f.cmd(f.b, t, { action: 'offer', instances: [bi] });
    t = f.cmd(f.a, t, { action: 'confirm', offerRevision: t.offerRevision });
    assert.throws(
      () => f.cmd(f.b, t, { action: 'confirm', offerRevision: t.offerRevision - 1 }),
      /Offers changed/,
    );
    assert.equal(f.trades.detail(f.a, t.id).players[0]!.confirmed, true);
    f.db.prepare('UPDATE owned_cards SET user_id=? WHERE id=?').run(f.c, ai);
    assert.throws(() => f.cmd(f.b, t, { action: 'confirm', offerRevision: t.offerRevision }));
    t = f.trades.detail(f.b, t.id);
    assert.ok(t.players.every((p) => !p.confirmed));
    assert.equal(f.inventory.owned(f.b, bi).id, bi);
    t = f.cmd(f.a, t, { action: 'offer', instances: [] });
    assert.equal(f.inventory.reservedTrade(ai), undefined);
    f.cmd(f.a, t, { action: 'cancel' });
    const pending = Array.from({ length: 10 }, () => f.trades.invite(f.a, f.b, randomUUID()));
    assert.throws(() => f.trades.invite(f.a, f.b, randomUUID()), /ten unfinished/);
    assert.throws(() => f.cmd(f.a, pending[0]!, { action: 'accept' }), /recipient/);
    f.cmd(f.b, pending[0]!, { action: 'reject' });
    assert.equal(f.trades.invite(f.a, f.b, randomUUID()).state, 'INVITED');
  } finally {
    f.clean();
  }
});

test('offers, reservations, history and exact instance ownership survive a reopened SQLite connection', async () => {
  const f = await setup();
  try {
    const { openDatabase } = await import('../src/player/database.js');
    const { Inventory } = await import('../src/player/inventory.js');
    const { cfg } = await import('./helpers.js');
    let t = f.invite();
    t = f.cmd(f.a, t, { action: 'offer', instances: [f.ids(f.a)[0]] });
    t = f.cmd(f.b, t, { action: 'offer', instances: [f.ids(f.b)[0]] });
    t = f.cmd(f.a, t, { action: 'confirm', offerRevision: t.offerRevision });
    const db = openDatabase(f.path);
    try {
      const inventory = new Inventory(db, f.store, cfg(), f.settings),
        friends = new Friends(db),
        trades = new Trades(inventory, friends, (u) => f.connected.has(u));
      t = trades.detail(f.a, t.id);
      assert.ok(t.players.every((p) => !p.confirmed));
      assert.equal(t.players[0]!.cards.length, 1);
      assert.equal(inventory.reservedTrade(t.players[0]!.cards[0]!.id), t.id);
      t = trades.command(f.a, f.session(f.a), t.id, {
        action: 'confirm',
        requestId: randomUUID(),
        revision: t.revision,
        offerRevision: t.offerRevision,
      });
      t = trades.command(f.b, f.session(f.b), t.id, {
        action: 'confirm',
        requestId: randomUUID(),
        revision: t.revision,
        offerRevision: t.offerRevision,
      });
      assert.equal(t.state, 'COMPLETED');
      assert.equal(f.inventory.owned(f.b, t.players[0]!.cards[0]!.id).source, 'trade');
      assert.equal(f.trades.list(f.a, true).items[0]!.state, 'COMPLETED');
    } finally {
      db.close();
    }
  } finally {
    f.clean();
  }
});
