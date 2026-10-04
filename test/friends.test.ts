import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playerFixture } from './player-fixture.js';
import { Friends } from '../src/player/friends.js';
test('friend codes, reciprocal requests, transitions and private projections', async () => {
  const f = await playerFixture();
  try {
    const friends = new Friends(f.db),
      a = await f.user(),
      b = await f.user(),
      c = await f.user();
    const pa = friends.profile(a),
      pb = friends.profile(b);
    friends.profile(c);
    assert.equal(friends.lookup(pb.friendCode.toLowerCase()).id, b);
    assert.throws(() => friends.request(a, pa.friendCode));
    const r = friends.request(a, pb.friendCode);
    assert.equal(friends.request(b, pa.friendCode).id, r.id);
    assert.throws(() => friends.act(a, r.id, 'accept', r.revision));
    assert.throws(() => friends.act(c, r.id, 'accept', r.revision));
    assert.throws(() => friends.act(b, r.id, 'cancel', r.revision));
    const accepted = friends.act(b, r.id, 'accept', r.revision);
    assert.ok(friends.accepted(a, b));
    assert.deepEqual(friends.act(b, r.id, 'accept', r.revision), accepted);
    const removed = friends.act(a, r.id, 'remove', accepted.revision);
    assert.equal(removed.status, 'REMOVED');
    assert.equal(friends.accepted(a, b), false);
    const again = friends.request(a, pb.friendCode);
    assert.throws(() => friends.act(b, r.id, 'accept', r.revision));
    assert.equal(friends.act(b, r.id, 'decline', again.revision).status, 'DECLINED');
    const last = friends.request(a, pb.friendCode);
    assert.equal(friends.act(a, r.id, 'cancel', last.revision).status, 'CANCELLED');
    assert.ok(!JSON.stringify(friends.list(a)).includes('email'));
  } finally {
    f.clean();
  }
});

test('friend code collisions retry without overwriting existing profiles', async () => {
  const f = await playerFixture();
  try {
    const a = await f.user(),
      b = await f.user();
    const first = new Friends(f.db, Date.now, () => 0);
    const code = first.profile(a).friendCode;
    let count = 0;
    const second = new Friends(f.db, Date.now, () => (count++ < 8 ? 0 : 1));
    assert.notEqual(second.profile(b).friendCode, code);
    assert.equal(second.profile(a).friendCode, code);
  } finally {
    f.clean();
  }
});
