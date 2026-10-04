// Type-only imports keep this contract safe for the browser.
import type { Card, Source } from '../domain.js';
import type { PublicQuestion } from '../runtime.js';
export type CardView = Pick<
  Card,
  | 'id'
  | 'versionId'
  | 'pageId'
  | 'name'
  | 'type'
  | 'rarity'
  | 'hp'
  | 'defense'
  | 'attacks'
  | 'passive'
> & { image: Source['image']; url?: string; summary?: string };
export type Unit = {
  instanceId: string;
  playerId: string;
  position: number;
  card: CardView;
  hp: number;
  burnTurns: number;
  weakened: boolean;
  recoveryUsed: boolean;
};
export type BattleEvent = {
  id: number;
  turn: number;
  kind:
    | 'attack'
    | 'trivia'
    | 'exhausted'
    | 'damage'
    | 'heal'
    | 'status'
    | 'passive'
    | 'knockout'
    | 'turn'
    | 'victory'
    | 'matchup';
  message: string;
  subjectId?: string;
  playerId?: string;
  amount?: number;
  calculated?: number;
  hp?: number;
  reason?: string;
  correct?: boolean;
};
export type AttackCommand = {
  kind: 'attack';
  commandId: string;
  revision: number;
  playerId: string;
  attackerId: string;
  attackId: string;
  targetId: string;
};
export type AnswerCommand = {
  kind: 'answer';
  commandId: string;
  revision: number;
  playerId: string;
  questionId: string;
  answerIndex: number;
};
export type Command = AttackCommand | AnswerCommand;
export type Pending = {
  attackerId: string;
  attackId: string;
  targetId: string;
  defenderId: string;
  question: PublicQuestion;
};
export type Feedback = {
  question: PublicQuestion;
  correct: boolean;
  correctIndex: number;
  explanation: string;
  sourceUrl: string;
  revisionId: number;
};
export type BattleView = {
  id: string;
  revision: number;
  turn: number;
  currentPlayer: string;
  players: [string, string];
  phase: 'SELECTING_ATTACK' | 'ANSWERING_TRIVIA' | 'RESOLVING_ATTACK' | 'BATTLE_FINISHED';
  teams: [Unit[], Unit[]];
  pending: Pending | null;
  feedback: Feedback | null;
  winner: string | null;
  events: BattleEvent[];
  stats: Record<string, { damage: number; knockouts: number; answered: number; correct: number }>;
  rules: {
    correctMultiplier: number;
    counters: Record<string, string>;
    strong: number;
    weak: number;
  };
};
export type CardsResponse = { cards: CardView[]; total: number; page: number; pageSize: number };
