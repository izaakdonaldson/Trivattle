import { effectiveness, type Config } from './config.js';
import type { Card, CardType } from './domain.js';
export type TypeChart = typeof effectiveness;
export function typeMultiplier(
  attack: CardType,
  defense: CardType,
  immune = false,
  chart = effectiveness,
) {
  if (attack === 'basic' || defense === 'basic') return 1;
  const m =
    chart.counters[attack] === defense
      ? chart.strong
      : chart.counters[defense] === attack
        ? chart.weak
        : chart.neutral;
  return immune && m > 1 ? 1 : m;
}
export type Combatant = {
  card: Card;
  hp: number;
  burnTurns: number;
  weakened: boolean;
  recoveryUsed: boolean;
};
export type HitEvent = {
  kind: 'damage' | 'heal' | 'status' | 'passive' | 'knockout';
  subject: Combatant;
  amount?: number;
  calculated?: number;
  hp?: number;
  reason: string;
};
export type Emit = (event: HitEvent) => void;
const silent: Emit = () => {};
export const freshCombatant = (card: Card): Combatant => ({
  card: structuredClone(card),
  hp: card.hp,
  burnTurns: 0,
  weakened: false,
  recoveryUsed: false,
});
function recover(c: Combatant, before: number, cfg: Config, emit: Emit) {
  const threshold = c.card.hp * cfg.passives.recovery.threshold;
  if (
    c.hp > 0 &&
    before >= threshold &&
    c.hp < threshold &&
    c.card.passive?.id === 'recovery' &&
    !c.recoveryUsed
  ) {
    c.recoveryUsed = true;
    const amount = Math.min(c.card.hp - c.hp, cfg.passives.recovery.hp);
    c.hp += amount;
    emit({ kind: 'passive', subject: c, amount, hp: c.hp, reason: 'recovery' });
  }
}
function hurt(c: Combatant, damage: number, reason: string, emit: Emit) {
  const amount = Math.min(c.hp, damage);
  c.hp -= amount;
  emit({ kind: 'damage', subject: c, amount, calculated: damage, hp: c.hp, reason });
}
function knockout(c: Combatant, emit: Emit) {
  if (c.hp === 0) {
    c.burnTurns = 0;
    c.weakened = false;
    emit({ kind: 'knockout', subject: c, reason: 'knockout' });
  }
}
export function splashTargets(position: number, team: Combatant[], damage: number, cfg: Config) {
  if (!Number.isInteger(position) || position < 0 || position >= cfg.battle.teamSize)
    throw Error('Invalid battlefield position');
  const amount = damage > 0 ? Math.max(1, Math.floor(damage * cfg.effects.splash.fraction)) : 0;
  return [position - 1, position + 1]
    .filter((p) => p >= 0 && p < cfg.battle.teamSize && team[p] && team[p]!.hp > 0)
    .map((p) => ({ position: p, damage: amount }));
}
export function resolveHit(
  attacker: Combatant,
  attackIndex: number,
  team: Combatant[],
  position: number,
  outcome: 'correct' | 'incorrect' | 'exhausted',
  cfg: Config,
  emit: Emit = silent,
  chart = effectiveness,
) {
  if (team.length !== cfg.battle.teamSize) throw Error('Invalid team size');
  if (!Number.isInteger(position) || position < 0 || position >= team.length)
    throw Error('Invalid target');
  const target = team[position]!;
  const attack = attacker.card.attacks[attackIndex];
  if (!Number.isInteger(attackIndex) || !attack || attacker.hp <= 0 || target.hp <= 0)
    throw Error('Invalid attacker, attack, or target');
  const effects =
    outcome === 'incorrect' || (outcome === 'exhausted' && cfg.battle.exhaustedEffects);
  const trivia =
    outcome === 'correct'
      ? cfg.battle.correctMultiplier
      : outcome === 'incorrect'
        ? cfg.battle.incorrectMultiplier
        : cfg.battle.exhaustedMultiplier;
  const rawType = typeMultiplier(attack.type, target.card.type, false, chart);
  const type = typeMultiplier(
    attack.type,
    target.card.type,
    target.card.passive?.id === 'immune',
    chart,
  );
  if (rawType !== type) emit({ kind: 'passive', subject: target, reason: 'immune' });
  const defense = effects && attack.effectId === 'pierce' ? 0 : target.card.defense;
  const weaken = attacker.weakened ? cfg.effects.weaken.multiplier : 1;
  if (attacker.weakened) emit({ kind: 'status', subject: attacker, reason: 'weaken-consumed' });
  attacker.weakened = false;
  const passive = target.card.passive?.id === 'stalwart' ? cfg.passives.stalwart.multiplier : 1;
  if (passive !== 1) emit({ kind: 'passive', subject: target, reason: 'stalwart' });
  const damage = Math.max(
    cfg.battle.minimumDamage,
    Math.ceil((attack.power * weaken * type - defense) * trivia * passive),
  );
  const splash =
    effects && attack.effectId === 'splash' ? splashTargets(position, team, damage, cfg) : [];
  const before = team.map((c) => c.hp);
  hurt(target, damage, 'direct', emit);
  if (effects) {
    switch (attack.effectId) {
      case 'burn':
        if (target.hp > 0) {
          target.burnTurns = cfg.effects.burn.turns;
          emit({ kind: 'status', subject: target, reason: 'burn' });
        }
        break;
      case 'weaken':
        if (target.hp > 0) {
          target.weakened = true;
          emit({ kind: 'status', subject: target, reason: 'weaken' });
        }
        break;
      case 'heal': {
        const amount = Math.min(attacker.card.hp - attacker.hp, cfg.effects.heal.hp);
        attacker.hp += amount;
        emit({ kind: 'heal', subject: attacker, amount, hp: attacker.hp, reason: 'heal' });
        break;
      }
      case 'pierce':
        emit({ kind: 'status', subject: target, reason: 'pierce' });
        break;
    }
  }
  for (const hit of splash) hurt(team[hit.position]!, hit.damage, 'splash', emit);
  for (const p of [position, ...splash.map((h) => h.position)]) {
    recover(team[p]!, before[p]!, cfg, emit);
    knockout(team[p]!, emit);
  }
  return { damage, splash, effects, type };
}
export function endOwnTurn(card: Combatant, cfg: Config, emit: Emit = silent) {
  if (card.hp > 0 && card.burnTurns > 0) {
    const before = card.hp;
    card.burnTurns--;
    hurt(card, cfg.effects.burn.damage, 'burn', emit);
    recover(card, before, cfg, emit);
    if (!card.burnTurns) emit({ kind: 'status', subject: card, reason: 'burn-expired' });
    knockout(card, emit);
  }
}
