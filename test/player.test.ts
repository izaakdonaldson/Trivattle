import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { playerFixture } from './player-fixture.js';
import { Inventory, weightedIndex } from '../src/player/inventory.js';
import { openDatabase } from '../src/player/database.js';
import { cfg } from './helpers.js';
test('accounts, exactly-once starters, ownership, rollback and restart persistence', async () => {
  const f = await playerFixture();
  try {
    const a = await f.user(),
      b = await f.user();
    f.inventory.bootstrap(a);
    f.inventory.bootstrap(a);
    assert.equal(f.inventory.collection(a, new URLSearchParams()).copies, 0);
    assert.equal(f.inventory.balance(a), 3);
    f.inventory.open(a, randomUUID());
    const copy = f.inventory.collection(a, new URLSearchParams()).cards[0]!;
    assert.throws(() => f.inventory.owned(b, copy.id));
    assert.equal(f.inventory.collection(b, new URLSearchParams()).copies, 0);
    const second = openDatabase(f.path);
    const restored = new Inventory(second, f.store, cfg(), f.settings);
    assert.equal(restored.collection(a, new URLSearchParams()).copies, 5);
    second.close();
    f.db.exec(
      "CREATE TRIGGER reject_starter BEFORE INSERT ON starter_grants BEGIN SELECT RAISE(ABORT,'failure'); END",
    );
    assert.throws(() => f.inventory.bootstrap(b));
    assert.equal(f.inventory.onboarded(b), false);
    assert.equal(f.inventory.balance(b), 0);
  } finally {
    f.clean();
  }
});
test('packs have five distinct instances, duplicates, persistent idempotency, eligibility and atomic failure', async () => {
  const f = await playerFixture();
  try {
    const a = await f.user();
    f.inventory.bootstrap(a);
    const key = randomUUID();
    const first = f.inventory.open(a, key);
    assert.equal(first.cards.length, 5);
    assert.equal(new Set(first.cards.map((c) => c.id)).size, 5);
    assert.equal(new Set(first.cards.map((c) => c.versionId)).size, 1);
    assert.deepEqual(f.inventory.open(a, key), first);
    assert.equal(f.inventory.balance(a), 2);
    assert.equal(f.inventory.collection(a, new URLSearchParams()).copies, 5);
    f.db.exec(
      "CREATE TRIGGER reject_reward BEFORE INSERT ON pack_rewards WHEN NEW.draw_slot=2 BEGIN SELECT RAISE(ABORT,'failure'); END",
    );
    assert.throws(() => f.inventory.open(a, randomUUID()));
    assert.equal(f.inventory.balance(a), 2);
    assert.equal(f.inventory.collection(a, new URLSearchParams()).copies, 5);
    f.db.exec('DROP TRIGGER reject_reward');
    f.inventory.open(a, randomUUID());
    f.inventory.open(a, randomUUID());
    assert.throws(() => f.inventory.open(a, randomUUID()), /No packs/);
    assert.deepEqual(f.inventory.open(a, key), first);
    assert.ok(!JSON.stringify(first).includes('correctIndex'));
    assert.ok(!JSON.stringify(first).includes('questionIds'));
  } finally {
    f.clean();
  }
});
test('rarity sampling and explicit missing pools exclude invalid definitions', async () => {
  const counts = [0, 0, 0, 0, 0];
  for (let n = 0; n < 10000; n++) counts[weightedIndex([55, 28, 12, 4, 1], () => n % 100)]!++;
  assert.deepEqual(counts, [5500, 2800, 1200, 400, 100]);
  const f = await playerFixture();
  try {
    const a = await f.user();
    f.inventory.bootstrap(a);
    for (const c of Object.values(f.store.data.cards))
      if (c.rarity === 'legendary') f.store.data.quarantined[c.versionId] = 'invalid';
    assert.throws(() => f.inventory.open(a, randomUUID()), /missing eligible/);
    assert.equal(f.inventory.balance(a), 3);
    f.settings.emptyPool = 'renormalize';
    assert.equal(f.inventory.packInfo(a).odds.legendary, 0);
    assert.equal(f.inventory.open(a, randomUUID()).cards.length, 5);
    const rows = f.inventory.collection(
      a,
      new URLSearchParams('grouped=false&sort=name&direction=asc'),
    ).cards;
    assert.equal(rows.length, 5);
    assert.throws(() => f.inventory.resolve(a, Array(5).fill(rows[0]!.id)));
    assert.equal(
      f.inventory.resolve(
        a,
        rows.slice(0, 5).map((c) => c.id),
      ).length,
      5,
    );
  } finally {
    f.clean();
  }
});

test('filtering, version retention, missing starters and pack replay after reopening', async () => {
  const f = await playerFixture();
  try {
    const a = await f.user(),
      b = await f.user();
    f.inventory.bootstrap(a);
    f.inventory.open(a, randomUUID());
    const first = f.inventory.collection(
      a,
      new URLSearchParams('grouped=false&sort=name&direction=asc'),
    ).cards;
    assert.deepEqual(
      first.map((c) => c.card!.name),
      [...first.map((c) => c.card!.name)].sort((a, b) => a.localeCompare(b)),
    );
    const name = first[0]!.card!.name;
    assert.equal(
      f.inventory.collection(a, new URLSearchParams({ q: name, type: 'science', rarity: 'common' }))
        .cards[0]!.card!.name,
      name,
    );
    assert.equal(f.inventory.collection(a, new URLSearchParams('rarity=legendary')).total, 0);
    assert.equal(f.inventory.collection(a, new URLSearchParams('page=2')).cards.length, 0);
    const key = randomUUID(),
      opening = f.inventory.open(a, key);
    const db = openDatabase(f.path);
    try {
      const i = new Inventory(db, f.store, cfg(), f.settings);
      assert.deepEqual(i.open(a, key), opening);
      assert.equal(i.balance(a), 1);
    } finally {
      db.close();
    }
    const version = first[0]!.versionId,
      definition = f.store.data.cards[version]!;
    delete f.store.data.published[definition.id];
    assert.equal(f.inventory.owned(a, first[0]!.id).playable, true);
    f.store.data.quarantined[version] = 'review';
    assert.equal(f.inventory.owned(a, first[0]!.id).playable, false);
    for (const c of Object.values(f.store.data.cards))
      if (c.rarity === 'common') f.store.data.quarantined[c.versionId] = 'review';
    f.inventory.bootstrap(b);
    assert.equal(f.inventory.onboarded(b), true);
    assert.equal(f.inventory.collection(b, new URLSearchParams()).copies, 0);
    assert.equal(f.inventory.open(a, key).cards.length, 5);
  } finally {
    f.clean();
  }
});

test('library sessions survive reopening and valid login/logout revokes access', async () => {
  const f = await playerFixture();
  try {
    const id = await f.user();
    f.inventory.bootstrap(id);
    const response = await f.auth.auth.api.signInEmail({
      body: { email: 'player1@example.com', password: 'password123' },
      asResponse: true,
    });
    assert.equal(response.status, 200);
    const cookie = response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const { createAuth } = await import('../src/player/auth.js');
    const db = openDatabase(f.path);
    try {
      const restored = createAuth(
        db,
        'http://localhost:3102',
        'testing-secret-123456789012345678901234',
      );
      assert.equal((await restored.session({ cookie })).user.id, id);
      await restored.auth.api.signOut({ headers: new Headers({ cookie }) });
      await assert.rejects(() => f.auth.session({ cookie }), /log in/);
      assert.equal(f.inventory.collection(id, new URLSearchParams()).copies, 0);
    } finally {
      db.close();
    }
  } finally {
    f.clean();
  }
});

test('catalogue exposes all playable definitions without trivia and collection defaults to individual rarity/date order', async () => {
  const f = await playerFixture();
  try {
    const user = await f.user();
    f.inventory.bootstrap(user);
    assert.equal(f.inventory.collection(user, new URLSearchParams()).total, 0);
    const all = f.inventory.catalogue(new URLSearchParams());
    assert.equal(all.total, 15);
    assert.equal(all.cards[0]!.card!.rarity, 'legendary');
    assert.ok(!JSON.stringify(all).includes('correctIndex'));
    assert.ok(!JSON.stringify(all).includes('questionIds'));
    assert.ok(
      f.inventory
        .catalogue(new URLSearchParams('rarity=common&type=science'))
        .cards.every((c) => c.card!.rarity === 'common' && c.card!.type === 'science'),
    );
    const opened = f.inventory.open(user, randomUUID());
    for (let i = 0; i < 5; i++)
      f.db
        .prepare('UPDATE owned_cards SET acquired_at=? WHERE id=?')
        .run('2026-01-0' + (i + 1), opened.cards[i]!.id);
    const copies = f.inventory.collection(user, new URLSearchParams());
    assert.equal(copies.cards.length, 5);
    assert.equal(copies.cards[0]!.id, opened.cards[4]!.id);
  } finally {
    f.clean();
  }
});
