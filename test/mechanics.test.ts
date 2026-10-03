import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  typeMultiplier,
  freshCombatant,
  resolveHit,
  splashTargets,
  endOwnTurn,
} from '../src/mechanics.js';
import { types } from '../src/domain.js';
import { card, cfg } from './helpers.js';
const team = () => Array.from({ length: 5 }, (_, i) => freshCombatant(card('common', i + 1)));
test('complete effectiveness cycle, Basic neutrality and Immune only removes weaknesses', () => {
  for (const type of types) {
    assert.equal(typeMultiplier('basic', type), 1);
    assert.equal(typeMultiplier(type, 'basic'), 1);
  }
  assert.equal(typeMultiplier('science', 'nature'), 1.25);
  assert.equal(typeMultiplier('nature', 'science'), 0.8);
  assert.equal(typeMultiplier('geography', 'science', true), 1);
  assert.equal(typeMultiplier('nature', 'science', true), 0.8);
  for (const type of types.filter((t) => t !== 'basic')) {
    assert.equal(types.filter((other) => typeMultiplier(type, other) > 1).length, 1);
    assert.equal(types.filter((other) => typeMultiplier(type, other) < 1).length, 1);
  }
});
test('Immune still takes normal damage', () => {
  const t = team();
  t[0]!.card.passive = { id: 'immune' };
  const a = freshCombatant(card());
  a.card.attacks[0]!.type = 'geography';
  const before = t[0]!.hp;
  const result = resolveHit(a, 0, t, 0, 'incorrect', cfg());
  assert(result.damage > 0);
  assert(t[0]!.hp < before);
});
test('splash uses uncapped primary damage, correct adjacency, skips defeated and never recurses', () => {
  const t = team(),
    a = freshCombatant(card('epic'));
  a.card.attacks[0]!.effectId = 'splash';
  a.card.attacks[0]!.power = 40;
  t[2]!.hp = 1;
  t[1]!.hp = 0;
  const hp = t.map((c) => c.hp);
  const hit = resolveHit(a, 0, t, 2, 'incorrect', cfg());
  assert(hit.damage > 1);
  assert.deepEqual(hit.splash, [{ position: 3, damage: Math.floor(hit.damage * 0.2) }]);
  assert.equal(t[0]!.hp, hp[0]);
  assert.equal(t[4]!.hp, hp[4]);
  assert.deepEqual(splashTargets(0, team(), 1, cfg()), [{ position: 1, damage: 1 }]);
  assert.deepEqual(splashTargets(4, team(), 10, cfg()), [{ position: 3, damage: 2 }]);
  assert.throws(() => splashTargets(-1, team(), 10, cfg()));
});
test('effects gated on incorrect including pierce, heal and exhaustion', () => {
  for (const effect of ['burn', 'heal', 'pierce', 'weaken', 'splash'] as const) {
    for (const outcome of ['correct', 'exhausted'] as const) {
      const t = team(),
        a = freshCombatant(card('epic'));
      a.card.attacks[0]!.effectId = effect;
      a.hp = 50;
      const hit = resolveHit(a, 0, t, 0, outcome, cfg());
      assert.equal(hit.effects, false);
      assert.equal(a.hp, 50);
      assert.equal(t[0]!.burnTurns, 0);
      assert.equal(t[0]!.weakened, false);
      assert.deepEqual(hit.splash, []);
    }
  }
});
test('burn refreshes without stacking and expires; weaken consumes once', () => {
  const t = team(),
    a = freshCombatant(card('epic'));
  a.card.attacks[0]!.effectId = 'burn';
  resolveHit(a, 0, t, 0, 'incorrect', cfg());
  assert.equal(t[0]!.burnTurns, 2);
  endOwnTurn(t[0]!, cfg());
  assert.equal(t[0]!.burnTurns, 1);
  endOwnTurn(t[0]!, cfg());
  assert.equal(t[0]!.burnTurns, 0);
  const hp = t[0]!.hp;
  endOwnTurn(t[0]!, cfg());
  assert.equal(t[0]!.hp, hp);
  a.weakened = true;
  const weak = resolveHit(a, 0, team(), 0, 'incorrect', cfg()).damage;
  assert.equal(a.weakened, false);
  assert(resolveHit(a, 0, team(), 0, 'incorrect', cfg()).damage > weak);
});
test('recovery occurs once below threshold, never revives defeated cards; heal caps', () => {
  const t = team(),
    a = freshCombatant(card('epic'));
  t[0]!.card.passive = { id: 'recovery' };
  t[0]!.hp = 45;
  resolveHit(a, 0, t, 0, 'incorrect', cfg());
  assert.equal(t[0]!.recoveryUsed, true);
  t[1]!.card.passive = { id: 'recovery' };
  t[1]!.hp = 1;
  resolveHit(a, 0, t, 1, 'incorrect', cfg());
  assert.equal(t[1]!.hp, 0);
  assert.equal(t[1]!.recoveryUsed, false);
  a.card.attacks[0]!.effectId = 'heal';
  a.hp = a.card.hp - 1;
  resolveHit(a, 0, t, 2, 'incorrect', cfg());
  assert.equal(a.hp, a.card.hp);
});
