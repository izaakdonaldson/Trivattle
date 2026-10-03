import { writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { freshCombatant, resolveHit, endOwnTurn, type Combatant } from '../src/mechanics.js';
import { types, rarities, seededInt, hash, type Card } from '../src/domain.js';
import { card } from '../test/helpers.js';
const cfg = loadConfig();
const games = Number(process.env.SIM_GAMES ?? 2000),
  correctProbability = Number(process.env.SIM_CORRECT_PROBABILITY ?? 0.6),
  maxTurns = Number(process.env.SIM_MAX_TURNS ?? 200),
  seed = process.env.SIM_SEED ?? 'balance-v1';
if (
  !Number.isInteger(games) ||
  games < 1 ||
  correctProbability < 0 ||
  correctProbability > 1 ||
  !Number.isInteger(maxTurns) ||
  maxTurns < 1
)
  throw Error('Invalid simulation parameters');
function sample(rarity: Card['rarity'], id: number) {
  const c = card(rarity, id, id % 2 ? 'A' : 'B');
  c.hp = seededInt([id, cfg.version, 'hp'], cfg.hp);
  c.defense = seededInt([id, cfg.version, 'def'], cfg.defense);
  c.type = types[id % types.length]!;
  c.attacks.forEach((a, i) => {
    a.type = c.type;
    a.power = seededInt(
      [id, cfg.version, a.effectId ? 'specialPower' : 'standardPower'],
      a.effectId ? cfg.specialPower : cfg.standardPower,
    );
    if (a.effectId) {
      a.effectId = (['burn', 'heal', 'pierce', 'weaken', 'splash'] as const)[(id + i) % 5]!;
      a.effectParameters = cfg.effects[a.effectId];
    }
  });
  if (c.passive)
    c.passive.id = (
      c.type === 'basic'
        ? (['stalwart', 'recovery'] as const)
        : (['stalwart', 'recovery', 'immune'] as const)
    )[id % (c.type === 'basic' ? 2 : 3)]!;
  return c;
}
function teamFor(c: Combatant) {
  return Array.from({ length: cfg.battle.teamSize }, (_, i) =>
    i === 0 ? c : { ...freshCombatant(c.card), hp: 0 },
  );
}
function choose(a: Combatant, b: Combatant) {
  let best = 0,
    value = -Infinity;
  for (let i = 0; i < a.card.attacks.length; i++) {
    let score = 0;
    for (const outcome of ['correct', 'incorrect'] as const) {
      const aa = structuredClone(a),
        bb = structuredClone(b),
        before = aa.hp;
      const hit = resolveHit(aa, i, teamFor(bb), 0, outcome, cfg);
      const status =
        outcome === 'incorrect'
          ? aa.card.attacks[i]!.effectId === 'burn'
            ? cfg.effects.burn.damage * cfg.effects.burn.turns
            : aa.card.attacks[i]!.effectId === 'weaken'
              ? (1 - cfg.effects.weaken.multiplier) * cfg.standardPower[0]
              : 0
          : 0;
      score +=
        (outcome === 'correct' ? correctProbability : 1 - correctProbability) *
        (hit.damage + aa.hp - before + status);
    }
    if (score > value) {
      value = score;
      best = i;
    }
  }
  return best;
}
const results = rarities.map((rarity) => {
  let wins = 0,
    draws = 0;
  for (let game = 0; game < games; game++) {
    const a = freshCombatant(sample(rarity, 1000 + game * 2)),
      b = freshCombatant(sample('common', 1001 + game * 2));
    for (let turn = 0; turn < maxTurns && a.hp > 0 && b.hp > 0; turn++) {
      const [attacker, target] = (turn + game) % 2 === 0 ? [a, b] : [b, a];
      const random = parseInt(hash([seed, game, turn]).slice(0, 8), 16) / 0x100000000;
      resolveHit(
        attacker,
        choose(attacker, target),
        teamFor(target),
        0,
        random < correctProbability ? 'correct' : 'incorrect',
        cfg,
      );
      endOwnTurn(attacker, cfg);
    }
    if (a.hp > 0 && b.hp <= 0) wins++;
    else if (a.hp > 0 === b.hp > 0) draws++;
  }
  return { rarity, games, wins, draws, winRate: Number((wins / games).toFixed(4)) };
});
const report = {
  configVersion: cfg.version,
  seed,
  gamesPerRarity: games,
  correctProbability,
  maxTurns,
  results,
  limitations:
    'Seeded 1v1 probe against Common, alternating first move, equal trivia accuracy, independent identical stat ranges, all 7 types and all passives/effects. Greedy expected-value move policy. Splash has no adjacent targets here; this is not evidence of five-card balance. No question exhaustion modeled. Validate team play and player knowledge separately.',
};
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes('--write'))
  writeFileSync('data/balance-report.json', JSON.stringify(report, null, 2) + '\n');
