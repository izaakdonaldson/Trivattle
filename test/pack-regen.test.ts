import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { playerFixture } from './player-fixture.js';
import { Inventory } from '../src/player/inventory.js';
import { cfg } from './helpers.js';
test('pack regeneration boundaries, partial progress, full cooldown, retries and rollback', async () => {
  const f = await playerFixture();
  let now = 1000000;
  try {
    const id = await f.user();
    const i = new Inventory(
      f.db,
      f.store,
      cfg(),
      f.settings,
      () => {},
      () => 0,
      () => now,
    );
    i.bootstrap(id);
    assert.equal(i.packStatus(id).nextPackAt, null);
    now += 3600000;
    const key = randomUUID();
    i.open(id, key);
    assert.equal(i.packStatus(id).nextPackAt, now + 300000);
    now += 180000;
    i.open(id, randomUUID());
    assert.equal(i.packStatus(id).nextPackAt, now + 120000);
    i.open(id, randomUUID());
    assert.equal(i.balance(id), 0);
    now += 119999;
    assert.equal(i.balance(id), 0);
    now++;
    assert.equal(i.balance(id), 1);
    now += 600000;
    assert.equal(i.balance(id), 3);
    assert.equal(i.packStatus(id).nextPackAt, null);
    now += 3600000;
    assert.equal(i.balance(id), 3);
    i.open(id, key);
    assert.equal(i.balance(id), 3);
    i.open(id, randomUUID());
    assert.equal(i.packStatus(id).nextPackAt, now + 300000);
    f.db.exec(
      "CREATE TRIGGER reject_regen BEFORE INSERT ON pack_rewards BEGIN SELECT RAISE(ABORT,'failure'); END",
    );
    assert.throws(() => i.open(id, randomUUID()));
    assert.equal(i.balance(id), 2);
    assert.equal(i.packStatus(id).nextPackAt, now + 300000);
    f.db.exec('DROP TRIGGER reject_regen');
    f.db.prepare('UPDATE inventory SET packs=7 WHERE user_id=?').run(id);
    assert.equal(i.balance(id), 7);
    i.open(id, randomUUID());
    assert.equal(i.balance(id), 6);
    assert.equal(i.packStatus(id).nextPackAt, null);
  } finally {
    f.clean();
  }
});

test('regeneration migration preserves balances and its initial timestamp on rerun', async () => {
  const f = await playerFixture();
  try {
    const { migrate } = await import('../src/player/database.js');
    const a = await f.user(),
      b = await f.user();
    f.inventory.bootstrap(a);
    f.inventory.bootstrap(b);
    f.db.prepare('UPDATE inventory SET packs=1 WHERE user_id=?').run(a);
    f.db.prepare('UPDATE inventory SET packs=8 WHERE user_id=?').run(b);
    f.db.exec(
      'ALTER TABLE inventory DROP COLUMN cooldown_anchor; DELETE FROM app_migrations WHERE version=2;',
    );
    const before = Date.now();
    migrate(f.db);
    const row = f.db.prepare('SELECT * FROM inventory WHERE user_id=?').get(a)!;
    assert.equal(row.packs, 1);
    assert.ok(Number(row.cooldown_anchor) >= before - 2);
    migrate(f.db);
    assert.equal(
      f.db.prepare('SELECT cooldown_anchor FROM inventory WHERE user_id=?').get(a)!.cooldown_anchor,
      row.cooldown_anchor,
    );
    assert.equal(f.inventory.balance(b), 8);
    assert.equal(f.inventory.packStatus(b).nextPackAt, null);
  } finally {
    f.clean();
  }
});

test('configured intervals, negative clock drift and repeated reconciliations do not duplicate accrual', async () => {
  const f = await playerFixture();
  let now = 100000;
  try {
    f.settings.packCapacity = 4;
    f.settings.packRegenMs = 1000;
    f.settings.starterPacks = 0;
    const i = new Inventory(
        f.db,
        f.store,
        cfg(),
        f.settings,
        () => {},
        () => 0,
        () => now,
      ),
      user = await f.user();
    i.bootstrap(user);
    assert.equal(i.packStatus(user).nextPackAt, 101000);
    now = 99999;
    assert.equal(i.balance(user), 0);
    assert.equal(i.packStatus(user).nextPackAt, 101000);
    now = 101500;
    const states = await Promise.all(Array.from({ length: 10 }, async () => i.packStatus(user)));
    assert.ok(states.every((s) => s.packs === 1 && s.nextPackAt === 102000));
    i.open(user, randomUUID());
    assert.equal(i.packStatus(user).nextPackAt, 102000);
    now = 105000;
    assert.equal(i.balance(user), 4);
    assert.equal(i.packStatus(user).nextPackAt, null);
    i.bootstrap(user);
    assert.equal(i.balance(user), 4);
  } finally {
    f.clean();
  }
});
