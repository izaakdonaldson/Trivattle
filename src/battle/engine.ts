import { battlePacing } from './rules.js';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { effectiveness, type Config } from '../config.js';
import { type Card } from '../domain.js';
import {
  freshCombatant,
  resolveHit,
  endOwnTurn,
  type Combatant,
  type HitEvent,
} from '../mechanics.js';
import { CachedCatalogue } from '../runtime.js';
import type { Catalogue } from '../store.js';
import { cardView } from './catalogue.js';
import type { BattleView, BattleEvent, Command, AttackCommand } from './types.js';
const base = {
  commandId: z.string().min(1).max(100),
  revision: z.number().int().nonnegative(),
  playerId: z.string(),
};
export const commandSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...base,
      kind: z.literal('attack'),
      attackerId: z.string(),
      attackId: z.string(),
      targetId: z.string(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('answer'),
      questionId: z.string(),
      answerIndex: z.number().int().min(0).max(3),
    })
    .strict(),
]);
export type BattleUnit = Combatant & { instanceId: string; playerId: string; position: number };
export type BattleState = Omit<BattleView, 'teams' | 'stats'> & {
  teams: [BattleUnit[], BattleUnit[]];
  usedQuestions: string[];
  commands: string[];
  config: Config;
  chart: typeof effectiveness;
};
export class BattleError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new BattleError(message);
}
function event(s: BattleState, e: Omit<BattleEvent, 'id' | 'turn'>) {
  s.events.push({ id: s.events.length + 1, turn: s.turn, ...e });
}
export function createBattle(id: string, cards: [Card[], Card[]], config: Config): BattleState {
  ensure(
    config.battle.teamSize === 5 && cards.every((t) => t.length === 5),
    'Choose exactly five cards per team',
  );
  const players: [string, string] = ['player-1', 'player-2'];
  return {
    id,
    revision: 0,
    turn: 1,
    currentPlayer: players[0],
    players,
    phase: 'SELECTING_ATTACK',
    teams: cards.map((team, p) =>
      team.map((c, position) => ({
        ...freshCombatant({ ...c, hp: Math.max(1, Math.round(c.hp * battlePacing.hpMultiplier)) }),
        instanceId: `${id}:${p}:${position}`,
        playerId: players[p]!,
        position,
      })),
    ) as BattleState['teams'],
    pending: null,
    feedback: null,
    winner: null,
    events: [],
    usedQuestions: [],
    commands: [],
    config: structuredClone(config),
    chart: structuredClone(effectiveness),
    rules: {
      correctMultiplier: config.battle.correctMultiplier,
      counters: { ...effectiveness.counters },
      strong: effectiveness.strong,
      weak: effectiveness.weak,
    },
  };
}
function checkWin(s: BattleState) {
  const loser = s.teams.findIndex((t) => t.every((c) => c.hp === 0));
  if (loser < 0) return false;
  s.winner = s.players[1 - loser]!;
  s.phase = 'BATTLE_FINISHED';
  event(s, {
    kind: 'victory',
    playerId: s.winner,
    message: `${s.winner === 'player-1' ? 'Player 1' : 'Player 2'} wins!`,
  });
  return true;
}
function resolve(
  s: BattleState,
  action: Pick<AttackCommand, 'attackerId' | 'targetId' | 'attackId'>,
  outcome: 'correct' | 'incorrect' | 'exhausted',
) {
  s.phase = 'RESOLVING_ATTACK';
  const p = s.players.indexOf(s.currentPlayer),
    own = s.teams[p]!,
    enemy = s.teams[1 - p]!;
  const attacker = own.find((c) => c.instanceId === action.attackerId)!,
    target = enemy.find((c) => c.instanceId === action.targetId)!;
  const emit = (e: HitEvent) => {
    const subject = e.subject as BattleUnit;
    const reason = e.reason;
    const message =
      e.kind === 'damage'
        ? `${subject.card.name} took ${e.amount} ${reason === 'direct' ? '' : reason + ' '}damage.`
        : e.kind === 'heal'
          ? `${subject.card.name} restored ${e.amount} HP.`
          : e.kind === 'knockout'
            ? `${subject.card.name} was knocked out!`
            : `${subject.card.name}: ${reason.replaceAll('-', ' ')}${e.amount ? ` (+${e.amount} HP)` : ''}.`;
    event(s, {
      kind: e.kind,
      subjectId: subject.instanceId,
      playerId:
        reason === 'burn' || e.kind === 'knockout'
          ? s.players[1 - s.players.indexOf(subject.playerId)]
          : attacker.playerId,
      message,
      reason,
      amount: e.amount,
      calculated: e.calculated,
      hp: e.hp,
    });
  };
  const hit = resolveHit(
    attacker,
    attacker.card.attacks.findIndex((a) => a.id === action.attackId),
    enemy,
    target.position,
    outcome,
    s.config,
    emit,
    s.chart,
  );
  event(s, {
    kind: 'matchup',
    message:
      hit.type > 1
        ? 'Super effective! ×' + hit.type
        : hit.type < 1
          ? 'Resisted. ×' + hit.type
          : 'Neutral matchup. ×1',
  });
  s.pending = null;
  if (checkWin(s)) return;
  for (const c of own) endOwnTurn(c, s.config, emit);
  if (checkWin(s)) return;
  s.currentPlayer = s.players[1 - p]!;
  s.turn++;
  s.phase = 'SELECTING_ATTACK';
  event(s, {
    kind: 'turn',
    playerId: s.currentPlayer,
    message: `${s.currentPlayer === 'player-1' ? 'Player 1' : 'Player 2'} — your turn.`,
  });
}
/** Clone before any validation-side effects; only the returned state may be committed. */
export function applyCommand(
  previous: BattleState,
  input: Command,
  data: Catalogue,
  choose: (n: number) => number = randomInt,
): BattleState {
  const command = commandSchema.parse(input);
  ensure(previous.phase !== 'BATTLE_FINISHED', 'This battle has finished');
  ensure(command.revision === previous.revision, 'Stale battle revision; refresh the match');
  ensure(!previous.commands.includes(command.commandId), 'Command already submitted');
  const s = structuredClone(previous);
  const catalogue = new CachedCatalogue({ data }, s.config);
  if (command.kind === 'attack') {
    ensure(s.phase === 'SELECTING_ATTACK', 'An answer is pending');
    ensure(command.playerId === s.currentPlayer, 'It is not this player’s turn');
    const p = s.players.indexOf(command.playerId);
    const attacker = s.teams[p]!.find((c) => c.instanceId === command.attackerId);
    const target = s.teams[1 - p]!.find((c) => c.instanceId === command.targetId);
    ensure(attacker && attacker.hp > 0, 'Invalid or defeated attacker');
    ensure(target && target.hp > 0, 'Invalid or defeated target');
    const attack = attacker.card.attacks.find((a) => a.id === command.attackId);
    ensure(attack, 'Attack does not belong to this card');
    s.feedback = null;
    event(s, {
      kind: 'attack',
      subjectId: attacker.instanceId,
      playerId: attacker.playerId,
      message: `${attacker.card.name} used ${attack.name} on ${target.card.name}!`,
    });
    const used = new Set(s.usedQuestions);
    const selected = catalogue.getUnusedQuestion(attacker.card.versionId, used, choose);
    s.usedQuestions = [...used];
    if (selected.kind === 'question') {
      s.pending = {
        attackerId: attacker.instanceId,
        attackId: attack.id,
        targetId: target.instanceId,
        defenderId: target.playerId,
        question: selected.question,
      };
      s.phase = 'ANSWERING_TRIVIA';
    } else {
      event(s, {
        kind: 'exhausted',
        message: `No unused questions remain for ${attacker.card.name}. Damage ×${s.config.battle.exhaustedMultiplier}; ${selected.activateEffects ? 'effects enabled' : 'no special effect'}.`,
      });
      resolve(s, command, 'exhausted');
    }
  } else {
    ensure(s.phase === 'ANSWERING_TRIVIA' && s.pending, 'No question is awaiting an answer');
    const pending = s.pending;
    ensure(command.playerId === pending.defenderId, 'Only the defending player can answer');
    ensure(
      command.questionId === pending.question.id,
      'Question does not match the pending attack',
    );
    const attacker = s.teams.flat().find((c) => c.instanceId === pending.attackerId)!;
    const answer = catalogue.evaluateAnswer(
      attacker.card.versionId,
      command.questionId,
      command.answerIndex,
    );
    s.feedback = { question: pending.question, ...answer };
    event(s, {
      kind: 'trivia',
      playerId: command.playerId,
      correct: answer.correct,
      message: answer.correct
        ? `Correct! Incoming damage ×${s.config.battle.correctMultiplier}.`
        : 'Incorrect. Full damage and special effect activated.',
    });
    resolve(s, pending, answer.correct ? 'correct' : 'incorrect');
  }
  s.commands.push(command.commandId);
  s.revision++;
  return s;
}
export function publicBattle(s: BattleState, data: Catalogue): BattleView {
  const stats: BattleView['stats'] = Object.fromEntries(
    s.players.map((p) => [p, { damage: 0, knockouts: 0, answered: 0, correct: 0 }]),
  );
  for (const e of s.events) {
    const stat = e.playerId ? stats[e.playerId] : undefined;
    if (!stat) continue;
    if (e.kind === 'damage') stat.damage += e.amount ?? 0;
    if (e.kind === 'knockout') stat.knockouts++;
    if (e.kind === 'trivia') {
      stat.answered++;
      stat.correct += Number(e.correct);
    }
  }
  return structuredClone({
    id: s.id,
    revision: s.revision,
    turn: s.turn,
    currentPlayer: s.currentPlayer,
    players: s.players,
    phase: s.phase,
    teams: s.teams.map((t) =>
      t.map((c) => ({
        instanceId: c.instanceId,
        playerId: c.playerId,
        position: c.position,
        card: { ...cardView(c.card, data), summary: undefined, url: undefined },
        hp: c.hp,
        burnTurns: c.burnTurns,
        weakened: c.weakened,
        recoveryUsed: c.recoveryUsed,
      })),
    ) as BattleView['teams'],
    pending: s.pending,
    feedback: s.feedback,
    winner: s.winner,
    events: s.events,
    stats,
    rules: s.rules,
  });
}
