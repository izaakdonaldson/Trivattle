import { randomInt } from 'node:crypto';
import { CatalogueStore } from './store.js';
import {
  hash,
  normalize,
  type Card,
  type Question,
  type RarityName,
  type CardType,
} from './domain.js';
import type { Config } from './config.js';
export type PublicQuestion = Pick<Question, 'id' | 'pageId' | 'text' | 'options'>;
const publicQuestion = (q: Question): PublicQuestion => ({
  id: q.id,
  pageId: q.pageId,
  text: q.text,
  options: [...q.options],
});
export type QuestionSelection =
  | { kind: 'question'; question: PublicQuestion }
  | { kind: 'exhausted'; triviaMultiplier: number; activateEffects: boolean };
/** Server-only module. Do not bundle a catalogue or this evaluator into browser code. */
export class CachedCatalogue {
  constructor(
    private store: CatalogueStore,
    private config: Config,
  ) {}
  getCard(id: string): Card | undefined {
    const version = this.store.data.published[id] ?? id;
    const card = this.store.data.cards[version];
    return card?.status === 'published' && !this.store.data.quarantined[version]
      ? structuredClone(card)
      : undefined;
  }
  getCards(filters: { rarity?: RarityName; type?: CardType } = {}) {
    return Object.values(this.store.data.published)
      .map((id) => this.getCard(id)!)
      .filter(
        (c) =>
          c &&
          (!filters.rarity || c.rarity === filters.rarity) &&
          (!filters.type || c.type === filters.type),
      );
  }
  getCardsByRarity(rarity: RarityName) {
    return this.getCards({ rarity });
  }
  getRandomCachedCard(rarity?: RarityName) {
    const cards = this.getCards({ rarity });
    return cards.length ? cards[randomInt(cards.length)] : undefined;
  }
  getCardQuestions(id: string): PublicQuestion[] {
    const c = this.getCard(id);
    return c ? c.questionIds.map((id) => publicQuestion(this.store.data.questions[id]!)) : [];
  }
  getUnusedQuestion(cardId: string, usedQuestionIds: Set<string>): QuestionSelection {
    const card = this.getCard(cardId);
    if (!card) throw Error('Unknown playable card');
    const questions = this.getCardQuestions(cardId).filter(
      (q) =>
        !usedQuestionIds.has(`${q.pageId}/${q.id}`) &&
        !usedQuestionIds.has(`${q.pageId}/stem/${hash(normalize(q.text))}`),
    );
    if (!questions.length)
      return {
        kind: 'exhausted',
        triviaMultiplier: this.config.battle.exhaustedMultiplier,
        activateEffects: this.config.battle.exhaustedEffects,
      };
    const q = questions[randomInt(questions.length)]!;
    usedQuestionIds.add(`${q.pageId}/${q.id}`);
    usedQuestionIds.add(`${q.pageId}/stem/${hash(normalize(q.text))}`);
    return { kind: 'question', question: q };
  }
  /** Call only after the server checks the pending question, submitting player, and one-answer-per-turn. */
  evaluateAnswer(cardId: string, questionId: string, index: number) {
    if (!Number.isInteger(index) || index < 0 || index > 3) throw Error('Invalid answer index');
    const card = this.getCard(cardId);
    if (!card?.questionIds.includes(questionId)) throw Error('Question not in this card version');
    const q = this.store.data.questions[questionId]!;
    return {
      correct: q.correctIndex === index,
      correctIndex: q.correctIndex,
      explanation: q.explanation,
      sourceUrl: q.sourceUrl,
      revisionId: q.revisionId,
    };
  }
  /** Admin-only: metadata can include answer-bearing prompts/errors and retained questions. */
  getCardGenerationMetadata(id: string) {
    const c = this.getCard(id);
    return c
      ? structuredClone(
          Object.values(this.store.data.jobs).find((j) => j.publishedVersion === c.versionId),
        )
      : undefined;
  }
}
