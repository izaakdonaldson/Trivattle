import { test } from 'node:test';
import assert from 'node:assert/strict';
import { card, cfg } from './helpers.js';
import { playable } from '../src/battle/catalogue.js';
import {
  createBattle,
  applyCommand,
  publicBattle,
  type BattleState,
} from '../src/battle/engine.js';
import { battleServer } from '../src/battle/server.js';
import { resolveHit, freshCombatant, endOwnTurn, typeMultiplier } from '../src/mechanics.js';
import { types } from '../src/domain.js';
import type { Command, BattleView } from '../src/battle/types.js';
import { fixture } from './battle-fixture.js';

function attack(s: BattleState): Command {
  const p = s.players.indexOf(s.currentPlayer),
    a = s.teams[p]!.find((c) => c.hp > 0)!,
    t = s.teams[1 - p]!.find((c) => c.hp > 0)!;
  return {
    kind: 'attack',
    commandId: `a${s.revision}`,
    revision: s.revision,
    playerId: s.currentPlayer,
    attackerId: a.instanceId,
    attackId: a.card.attacks[0]!.id,
    targetId: t.instanceId,
  };
}
function answer(s: BattleState, index = 0): Command {
  return {
    kind: 'answer',
    commandId: `q${s.revision}`,
    revision: s.revision,
    playerId: s.pending!.defenderId,
    questionId: s.pending!.question.id,
    answerIndex: index,
  };
}
test('battle initializes isolated instances, fixed positions, duplicate article history and resets', () => {
  const f = fixture();
  try {
    const s = createBattle('copies', [Array(5).fill(f.cards[0]), Array(5).fill(f.cards[0])], cfg());
    const original = structuredClone(s);
    let n = applyCommand(s, attack(s), f.data, () => 0);
    assert.deepEqual(s, original);
    assert.equal(new Set(n.teams.flat().map((c) => c.instanceId)).size, 10);
    assert.deepEqual(
      n.teams[0].map((c) => c.position),
      [0, 1, 2, 3, 4],
    );
    const first = n.pending!.question.id;
    n = applyCommand(n, answer(n), f.data);
    n = applyCommand(n, attack(n), f.data, () => 0);
    assert.notEqual(n.pending!.question.id, first);
    assert.equal(Math.round(f.cards[0]!.hp * 0.6), s.teams[0][0]!.hp);
    assert.deepEqual(
      createBattle('new', [f.cards.slice(0, 5), f.cards.slice(5)], cfg()).usedQuestions,
      [],
    );
  } finally {
    f.clean();
  }
});
test('validation rejects wrong actors, targets, attacks, phases, stale and duplicate commands', () => {
  const f = fixture();
  try {
    const s = f.state;
    const a = attack(s);
    assert.equal(a.kind, 'attack');
    if (a.kind !== 'attack') return;
    for (const change of [
      { playerId: 'player-2' },
      { attackerId: s.teams[1][0]!.instanceId },
      { targetId: s.teams[0][0]!.instanceId },
      { attackId: 'bad' },
      { revision: 4 },
    ])
      assert.throws(() => applyCommand(s, { ...a, ...change }, f.data));
    s.teams[0][0]!.hp = 0;
    assert.throws(() => applyCommand(s, a, f.data));
    s.teams[0][0]!.hp = 100;
    const n = applyCommand(s, a, f.data, () => 0);
    assert.throws(() => applyCommand(n, attack(n), f.data));
    assert.throws(() => applyCommand(n, { ...answer(n), playerId: 'player-1' }, f.data));
    assert.throws(() => applyCommand(n, { ...answer(n), questionId: 'bad' } as Command, f.data));
    const command = answer(n);
    const done = applyCommand(n, command, f.data);
    assert.equal(done.currentPlayer, 'player-2');
    assert.throws(() => applyCommand(done, command, f.data));
    assert.throws(() => applyCommand(done, { ...a, revision: done.revision }, f.data));
    const publicData = JSON.stringify(publicBattle(n, f.data));
    for (const key of [
      'correctIndex',
      'explanation',
      'evidence',
      'factKey',
      'questionIds',
      'usedQuestions',
    ])
      assert(!publicData.includes(key));
    assert(publicBattle(done, f.data).feedback?.explanation);
  } finally {
    f.clean();
  }
});
test('all type combinations and precise weaken/defense/trivia/stalwart arithmetic', () => {
  const counters: Record<string, string> = {
    science: 'nature',
    nature: 'technology',
    technology: 'history',
    history: 'culture',
    culture: 'geography',
    geography: 'science',
  };
  for (const a of types)
    for (const d of types) {
      const expected =
        a === 'basic' || d === 'basic' ? 1 : counters[a] === d ? 1.25 : counters[d] === a ? 0.8 : 1;
      assert.equal(typeMultiplier(a, d), expected);
      assert.equal(typeMultiplier(a, d, true), Math.min(expected, 1));
    }
  const a = freshCombatant(card()),
    t = Array.from({ length: 5 }, () => freshCombatant(card()));
  a.card.attacks[0]!.power = 31;
  a.weakened = true;
  t[0]!.card.defense = 7;
  t[0]!.card.passive = { id: 'stalwart' };
  assert.equal(
    resolveHit(a, 0, t, 0, 'correct', cfg()).damage,
    Math.ceil((31 * 0.8 - 7) * 0.5 * 0.95),
  );
  assert(!a.weakened);
});
test('recovery requires crossing threshold, triggers on burn and splash, never revives', () => {
  const c = cfg();
  for (const hp of [39, 40, 41, 4]) {
    const a = freshCombatant(card());
    a.card.hp = 100;
    a.hp = hp;
    a.card.passive = { id: 'recovery' };
    a.burnTurns = 1;
    endOwnTurn(a, c);
    assert.equal(a.recoveryUsed, hp >= 40);
    assert.equal(a.hp, hp >= 40 ? hp : Math.max(0, hp - 5));
  }
  const a = freshCombatant(card('epic')),
    team = Array.from({ length: 5 }, () => freshCombatant(card()));
  a.card.attacks[0]!.effectId = 'splash';
  a.card.attacks[0]!.power = 40;
  team[1]!.card.hp = 100;
  team[1]!.hp = 40;
  team[1]!.card.passive = { id: 'recovery' };
  resolveHit(a, 0, team, 0, 'incorrect', c);
  assert(team[1]!.recoveryUsed);
});
test('burn ticks all living own cards only after their turn, victory skips burn; splash and burn can win', () => {
  const f = fixture();
  try {
    let s = f.state;
    s.teams[0][1]!.burnTurns = 2;
    const hp = s.teams[0][1]!.hp;
    s = applyCommand(s, attack(s), f.data, () => 0);
    s = applyCommand(s, answer(s), f.data);
    assert.equal(s.teams[0][1]!.hp, hp - 5);
    assert.equal(s.teams[0][1]!.burnTurns, 1);
    for (const mode of ['direct', 'splash', 'burn']) {
      let n = createBattle(mode, [f.cards.slice(0, 5), f.cards.slice(5)], cfg());
      if (mode === 'burn') {
        n.teams[0].forEach((c) => {
          c.hp = 0;
        });
        n.teams[0][0]!.hp = 1;
        n.teams[0][0]!.burnTurns = 1;
      } else {
        n.teams[1].forEach((c) => (c.hp = 0));
        n.teams[1][0]!.hp = 1;
        n.teams[0].forEach((c) => (c.hp = 0));
        n.teams[0][0]!.hp = 1;
        n.teams[0][0]!.burnTurns = 1;
        if (mode === 'splash') {
          n.teams[1][1]!.hp = 1;
          n.teams[0][0]!.card.attacks[0]!.effectId = 'splash';
        }
      }
      n = applyCommand(n, attack(n), f.data, () => 0);
      const submitted = answer(n, 1);
      n = applyCommand(n, submitted, f.data);
      assert.equal(n.winner, mode === 'burn' ? 'player-2' : 'player-1');
      assert.throws(
        () =>
          applyCommand(
            n,
            { ...submitted, revision: n.revision, commandId: 'after-finish' },
            f.data,
          ),
        /finished/,
      );
      if (mode !== 'burn') assert.equal(n.teams[0][0]!.hp, 1);
    }
  } finally {
    f.clean();
  }
});
test('exhaustion never repeats and disables effects; complete deterministic battle', () => {
  const f = fixture();
  try {
    let s = f.state;
    const q = f.data.questions;
    s.usedQuestions = Object.values(q).map((q) => `${q.pageId}/${q.id}`);
    s.teams[0][0]!.card.attacks[0]!.effectId = 'burn';
    s = applyCommand(s, attack(s), f.data, () => 0);
    assert.equal(s.phase, 'SELECTING_ATTACK');
    assert.equal(s.teams[1][0]!.burnTurns, 0);
    assert(s.events.some((e) => e.kind === 'exhausted'));
    let steps = 0;
    while (s.phase !== 'BATTLE_FINISHED' && steps++ < 500)
      s = applyCommand(s, s.pending ? answer(s) : attack(s), f.data, () => 0);
    assert(s.winner);
    assert(steps < 500);
    assert.deepEqual(f.store.data.questions, f.data.questions);
  } finally {
    f.clean();
  }
});
test('HTTP boundaries, malformed requests, full match, pinned data and expiry', async () => {
  const f = fixture();
  let clock = 0;
  const server = battleServer({ store: f.store, config: cfg(), choose: () => 0, now: () => clock });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number };
  const root = `http://127.0.0.1:${address.port}`;
  const post = (path: string, data: unknown) =>
    fetch(root + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  try {
    assert.equal((await fetch(root + '/data/cards-server.json')).status, 404);
    assert.equal((await post('/api/battles', { teams: [] })).status, 400);
    const response = await post('/api/battles', { quickStart: true });
    assert.equal(response.status, 201);
    let s = (await response.json()) as BattleView;
    const path = `/api/battles/${s.id}`;
    f.store.data.questions = {};
    f.store.save();
    let count = 0;
    while (!s.winner && count++ < 400) {
      const p = s.players.indexOf(s.currentPlayer),
        a = s.teams[p]!.find((c) => c.hp > 0)!,
        t = s.teams[1 - p]!.find((c) => c.hp > 0)!;
      const command = s.pending
        ? {
            kind: 'answer',
            playerId: s.pending.defenderId,
            questionId: s.pending.question.id,
            answerIndex: 1,
          }
        : {
            kind: 'attack',
            playerId: s.currentPlayer,
            attackerId: a.instanceId,
            attackId: a.card.attacks[0]!.id,
            targetId: t.instanceId,
          };
      const r = await post(path + '/commands', {
        ...command,
        commandId: String(count),
        revision: s.revision,
      });
      assert.equal(r.status, 200);
      s = (await r.json()) as BattleView;
    }
    assert(s.winner);
    clock = 7200001;
    assert.equal((await fetch(root + path)).status, 404);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    f.clean();
  }
});
test('eligible catalogue excludes incomplete, fixture, quarantined and mismatched question banks', () => {
  const f = fixture();
  try {
    const [a, b, c, d] = f.cards;
    f.store.data.cards[a!.versionId]!.status = 'fixture';
    f.store.data.quarantined[b!.versionId] = 'audit';
    delete f.store.data.questions[c!.questionIds[0]!];
    f.store.data.questions[d!.questionIds[0]!]!.pageId = 99999;
    assert.equal(playable(f.store, cfg()).length, 6);
  } finally {
    f.clean();
  }
});
test('Burn refresh, surviving consecutive attacks, heal cap and Pierce gating use exact values', () => {
  const c = cfg(),
    a = freshCombatant(card('epic')),
    t = Array.from({ length: 5 }, () => freshCombatant(card()));
  a.card.attacks[0]!.power = 10;
  a.card.attacks[0]!.effectId = 'burn';
  resolveHit(a, 0, t, 0, 'incorrect', c);
  endOwnTurn(t[0]!, c);
  assert.equal(t[0]!.burnTurns, 1);
  resolveHit(a, 0, t, 0, 'incorrect', c);
  assert.equal(t[0]!.burnTurns, 2);
  endOwnTurn(t[0]!, c);
  endOwnTurn(t[0]!, c);
  const hp = t[0]!.hp;
  endOwnTurn(t[0]!, c);
  assert.equal(t[0]!.hp, hp);
  a.card.attacks[0]!.effectId = 'heal';
  a.hp = a.card.hp - 3;
  resolveHit(a, 0, t, 0, 'incorrect', c);
  assert.equal(a.hp, a.card.hp);
  a.card.attacks[0]!.effectId = 'pierce';
  a.card.attacks[0]!.power = 30;
  t[1]!.card.defense = 8;
  assert.equal(resolveHit(a, 0, t, 1, 'incorrect', c).damage, 30);
  assert.equal(
    resolveHit(a, 0, t, 2, 'correct', c).damage,
    Math.ceil((30 - t[2]!.card.defense) * 0.5),
  );
  const f = fixture();
  try {
    let s = f.state;
    const first = attack(s);
    for (let i = 0; i < 2; i++) {
      s = applyCommand(s, attack(s), f.data, () => 0);
      s = applyCommand(s, answer(s), f.data);
    }
    const next = attack(s);
    if (first.kind === 'attack' && next.kind === 'attack')
      assert.equal(first.attackerId, next.attackerId);
    assert.doesNotThrow(() => applyCommand(s, next, f.data));
  } finally {
    f.clean();
  }
});
test('concurrent HTTP commands commit exactly once against the current revision', async () => {
  const f = fixture();
  const server = battleServer({ store: f.store, config: cfg(), choose: () => 0 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, data: unknown) =>
    fetch(root + path, { method: 'POST', body: JSON.stringify(data) });
  try {
    const s = (await (await post('/api/battles', { quickStart: true })).json()) as BattleView;
    const a = s.teams[0][0]!,
      t = s.teams[1][0]!;
    const command = {
      kind: 'attack',
      commandId: 'one',
      revision: 0,
      playerId: s.currentPlayer,
      attackerId: a.instanceId,
      attackId: a.card.attacks[0]!.id,
      targetId: t.instanceId,
    };
    const path = `/api/battles/${s.id}/commands`;
    const results = await Promise.all([
      post(path, command),
      post(path, { ...command, commandId: 'two' }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const current = (await (await fetch(root + `/api/battles/${s.id}`)).json()) as BattleView;
    assert.equal(current.revision, 1);
    assert.equal(current.events.filter((e) => e.kind === 'attack').length, 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    f.clean();
  }
});

test('Weaken refreshes without stacking, survives incoming hits and is consumed on exhaustion', () => {
  const c = cfg(),
    a = freshCombatant(card('epic')),
    targets = Array.from({ length: 5 }, () => freshCombatant(card()));
  a.card.attacks[0]!.effectId = 'weaken';
  a.card.attacks[0]!.power = 5;
  resolveHit(a, 0, targets, 0, 'incorrect', c);
  resolveHit(a, 0, targets, 0, 'incorrect', c);
  assert.equal(targets[0]!.weakened, true);
  a.card.attacks[0]!.effectId = null;
  resolveHit(a, 0, targets, 0, 'correct', c);
  assert.equal(targets[0]!.weakened, true);
  const victim = targets[0]!,
    defenders = Array.from({ length: 5 }, () => freshCombatant(card()));
  victim.card.attacks[0]!.power = 30;
  assert.equal(
    resolveHit(victim, 0, defenders, 0, 'exhausted', c).damage,
    Math.ceil((30 * 0.8 - defenders[0]!.card.defense) * 0.5),
  );
  assert.equal(victim.weakened, false);
});
test('minimum damage, HP clamping and indirect damage bypass defensive passives', () => {
  const c = cfg(),
    a = freshCombatant(card('epic')),
    targets = Array.from({ length: 5 }, () => freshCombatant(card()));
  a.card.attacks[0]!.power = 1;
  a.card.attacks[0]!.effectId = null;
  targets[0]!.card.defense = 100;
  targets[0]!.hp = 1;
  assert.equal(resolveHit(a, 0, targets, 0, 'correct', c).damage, 1);
  assert.equal(targets[0]!.hp, 0);
  a.card.attacks[0]!.effectId = 'splash';
  a.card.attacks[0]!.power = 40;
  targets[2]!.card.passive = { id: 'stalwart' };
  targets[2]!.card.defense = 100;
  const before = targets[2]!.hp,
    hit = resolveHit(a, 0, targets, 1, 'incorrect', c);
  assert.equal(before - targets[2]!.hp, Math.max(1, Math.floor(hit.damage * 0.2)));
  targets[2]!.burnTurns = 1;
  const burned = targets[2]!.hp;
  endOwnTurn(targets[2]!, c);
  assert.equal(burned - targets[2]!.hp, 5);
});
test('Immune prevents weaknesses while allowing Burn, and match snapshots reset every transient field', () => {
  const a = freshCombatant(card('epic')),
    targets = Array.from({ length: 5 }, () => freshCombatant(card()));
  a.card.attacks[0]!.type = 'geography';
  a.card.attacks[0]!.effectId = 'burn';
  targets[0]!.card.passive = { id: 'immune' };
  assert.equal(resolveHit(a, 0, targets, 0, 'incorrect', cfg()).type, 1);
  assert.equal(targets[0]!.burnTurns, 2);
  const f = fixture();
  try {
    const config = cfg(),
      s = createBattle('old', [f.cards.slice(0, 5), f.cards.slice(5)], config);
    config.effects.burn.damage = 99;
    assert.equal(s.config.effects.burn.damage, 5);
    s.teams[0][0]!.hp = 1;
    s.teams[0][0]!.burnTurns = 2;
    s.teams[0][0]!.weakened = true;
    s.teams[0][0]!.recoveryUsed = true;
    s.usedQuestions = ['used'];
    const reset = createBattle('reset', [f.cards.slice(0, 5), f.cards.slice(5)], cfg());
    for (const c of reset.teams.flat()) {
      assert.equal(c.hp, c.card.hp);
      assert.equal(c.burnTurns, 0);
      assert.equal(c.weakened, false);
      assert.equal(c.recoveryUsed, false);
    }
    assert.deepEqual(reset.usedQuestions, []);
  } finally {
    f.clean();
  }
});

test('battle HP is scaled without altering cached stats; opponent article details are redacted', async () => {
  const f = fixture();
  const server = battleServer({ store: f.store, config: cfg(), choose: () => 0 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const s = (await (
      await fetch(root + '/api/battles', {
        method: 'POST',
        body: JSON.stringify({ quickStart: true }),
      })
    ).json()) as BattleView;
    for (const unit of s.teams.flat()) {
      assert.equal(
        unit.card.hp,
        Math.round(f.cards.find((c) => c.versionId === unit.card.versionId)!.hp * 0.6),
      );
      assert.equal(unit.hp, unit.card.hp);
      assert.equal(unit.card.summary, undefined);
      assert.equal(unit.card.url, undefined);
    }
    const detail = async (p: number, viewer = 'player-1') =>
      (
        await fetch(
          `${root}/api/battles/${s.id}/cards/${encodeURIComponent(s.teams[p]![0]!.instanceId)}?playerId=${viewer}`,
        )
      ).json();
    const own = await detail(0);
    assert(own.summary);
    assert(own.url);
    const opponent = await detail(1);
    assert.equal(opponent.summary, undefined);
    assert.equal(opponent.url, undefined);
    assert(opponent.attacks[0].description);
    const forgedViewer = await detail(1, 'player-2');
    assert.equal(forgedViewer.summary, undefined);
    assert.equal(f.store.data.cards[f.cards[0]!.versionId]!.hp, f.cards[0]!.hp);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    f.clean();
  }
});
