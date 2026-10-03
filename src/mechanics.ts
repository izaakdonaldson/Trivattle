import { effectiveness, type Config } from './config.js';
import type { Card, CardType } from './domain.js';
export function typeMultiplier(attack: CardType, defense: CardType, immune = false) {
  if (attack === 'basic' || defense === 'basic') return 1;
  const m =
    effectiveness.counters[attack] === defense
      ? effectiveness.strong
      : effectiveness.counters[defense] === attack
        ? effectiveness.weak
        : effectiveness.neutral;
  return immune && m > 1 ? 1 : m;
}
export type Combatant = {
  card: Card;
  hp: number;
  burnTurns: number;
  weakened: boolean;
  recoveryUsed: boolean;
};
export const freshCombatant = (card: Card): Combatant => ({
  card,
  hp: card.hp,
  burnTurns: 0,
  weakened: false,
  recoveryUsed: false,
});
function recover(c: Combatant, cfg: Config) {
  if (
    c.hp > 0 &&
    c.card.passive?.id === 'recovery' &&
    !c.recoveryUsed &&
    c.hp < c.card.hp * cfg.passives.recovery.threshold
  ) {
    c.recoveryUsed = true;
    c.hp = Math.min(c.card.hp, c.hp + cfg.passives.recovery.hp);
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
/** Isolated deterministic resolver for future integration; no turns, players, networking, or battle orchestration. */
export function resolveHit(
  attacker: Combatant,
  attackIndex: number,
  team: Combatant[],
  position: number,
  outcome: 'correct' | 'incorrect' | 'exhausted',
  cfg: Config,
) {
  if (team.length !== cfg.battle.teamSize) throw Error('Invalid team size');
  if (!Number.isInteger(position) || position < 0 || position >= team.length)
    throw Error('Invalid target');
  const target = team[position]!;
  const attack = attacker.card.attacks[attackIndex];
  if (!attack || attacker.hp <= 0 || target.hp <= 0)
    throw Error('Invalid attacker, attack, or target');
  const effects =
    outcome === 'incorrect' || (outcome === 'exhausted' && cfg.battle.exhaustedEffects);
  const trivia =
    outcome === 'correct'
      ? cfg.battle.correctMultiplier
      : outcome === 'incorrect'
        ? cfg.battle.incorrectMultiplier
        : cfg.battle.exhaustedMultiplier;
  const type = typeMultiplier(attack.type, target.card.type, target.card.passive?.id === 'immune');
  const defense = effects && attack.effectId === 'pierce' ? 0 : target.card.defense;
  const weaken = attacker.weakened ? cfg.effects.weaken.multiplier : 1;
  attacker.weakened = false;
  const passive = target.card.passive?.id === 'stalwart' ? cfg.passives.stalwart.multiplier : 1;
  const damage = Math.max(
    cfg.battle.minimumDamage,
    Math.ceil((attack.power * type - defense) * trivia * weaken * passive),
  );
  const splash =
    effects && attack.effectId === 'splash' ? splashTargets(position, team, damage, cfg) : [];
  target.hp = Math.max(0, target.hp - damage);
  recover(target, cfg);
  if (effects) {
    switch (attack.effectId) {
      case 'burn':
        if (target.hp > 0) target.burnTurns = cfg.effects.burn.turns;
        break;
      case 'weaken':
        if (target.hp > 0) target.weakened = true;
        break;
      case 'heal':
        attacker.hp = Math.min(attacker.card.hp, attacker.hp + cfg.effects.heal.hp);
        break;
    }
  }
  for (const hit of splash) {
    const adjacent = team[hit.position]!;
    adjacent.hp = Math.max(0, adjacent.hp - hit.damage);
    recover(adjacent, cfg);
  }
  return { damage, splash, effects };
}
export function endOwnTurn(card: Combatant, cfg: Config) {
  if (card.hp > 0 && card.burnTurns > 0) {
    card.burnTurns--;
    card.hp = Math.max(0, card.hp - cfg.effects.burn.damage);
    recover(card, cfg);
  }
}
