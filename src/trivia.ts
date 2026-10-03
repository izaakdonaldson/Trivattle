import {
  questionDraftSchema,
  questionSchema,
  normalize,
  type QuestionDraft,
  type Question,
  type Source,
  type Conflict,
} from './domain.js';
import {
  questionId,
  candidatesSchema,
  accuracySchema,
  accuracyPrompt,
  reviewBank,
  type TextProvider,
} from './providers.js';
import type { Config } from './config.js';
export function validateGrounding(q: QuestionDraft, s: Source) {
  questionDraftSchema.parse(q);
  if (new Set(q.options.map(normalize)).size !== 4) throw Error('Duplicate options');
  if (!normalize(s.text).includes(normalize(q.evidence)))
    throw Error('Evidence not found in stored revision');
  if (!normalize(q.evidence).includes(normalize(q.options[q.correctIndex]!)))
    throw Error('Correct answer must appear explicitly in quoted evidence');
  if (normalize(q.text).includes(normalize(q.options[q.correctIndex]!)))
    throw Error('Stem reveals correct answer');
}
function similarity(a: string, b: string) {
  const x = new Set(normalize(a).split(' ')),
    y = new Set(normalize(b).split(' '));
  return [...x].filter((v) => y.has(v)).length / new Set([...x, ...y]).size;
}
export function deterministicConflicts(bank: Question[], config: Config): Conflict[] {
  const conflicts: Conflict[] = [];
  for (let i = 0; i < bank.length; i++)
    for (let j = i + 1; j < bank.length; j++) {
      const a = bank[i]!,
        b = bank[j]!;
      if (
        normalize(a.factKey) === normalize(b.factKey) ||
        normalize(a.evidence) === normalize(b.evidence) ||
        similarity(a.text, b.text) >= config.trivia.nearDuplicateThreshold
      )
        conflicts.push({
          a: a.id,
          b: b.id,
          removeId: a.quality < b.quality ? a.id : b.id,
          reason: 'Duplicate fact, evidence, or near-identical stem',
        });
    }
  return conflicts;
}
export function validateBank(bank: Question[], source: Source, config: Config) {
  if (bank.length < config.trivia.min || bank.length > config.trivia.max)
    throw Error('Trivia bank outside allowed size');
  if (new Set(bank.map((q) => q.id)).size !== bank.length) throw Error('Duplicate question IDs');
  for (const q of bank) {
    questionSchema.parse(q);
    if (
      q.pageId !== source.pageId ||
      q.revisionId !== source.revisionId ||
      q.sourceUrl !== source.url ||
      q.id !== questionId(source, q.text)
    )
      throw Error('Question source identity mismatch');
    validateGrounding(
      questionDraftSchema.parse({
        text: q.text,
        options: q.options,
        correctIndex: q.correctIndex,
        explanation: q.explanation,
        evidence: q.evidence,
        factKey: q.factKey,
      }),
      source,
    );
  }
  if (deterministicConflicts(bank, config).length) throw Error('Duplicate facts remain');
}
export type TriviaProgress = {
  questions: Question[];
  conflicts: Conflict[];
  reviewed: boolean;
  errors: string[];
};
export async function generateTrivia(
  source: Source,
  provider: TextProvider,
  config: Config,
  prior: Question[],
  onProgress: (p: TriviaProgress) => void,
): Promise<Question[]> {
  let bank = [...prior];
  const conflicts: Conflict[] = [];
  const errors: string[] = [];
  let reviewed = false;
  for (let attempt = 0; attempt < config.trivia.attempts; attempt++) {
    if (bank.length < config.trivia.target) {
      try {
        const candidates = await provider.json(
          'Generate article-specific multiple-choice trivia using independent notable facts, not difficulty levels. Four distinct options, exactly one correctIndex, concise explanation, exact contiguous evidence passage from source containing the literal correct answer, and a concise canonical factKey describing the factual relationship. Avoid ambiguous, subjective, current-changing, footnote facts and facts used by retained or rejected questions. Do not leak other answers in stems, options, or explanations. Generate the requested count; facts must come from the supplied prose only.',
          {
            title: source.title,
            revisionId: source.revisionId,
            source: source.text.slice(0, config.model.maxSourceChars),
            count: config.trivia.target - bank.length + config.trivia.extraCandidates,
            retained: bank,
            previousConflicts: conflicts,
            previousErrors: errors.slice(-20),
          },
          candidatesSchema,
        );
        const drafts: Question[] = [];
        for (const q of candidates.questions) {
          try {
            validateGrounding(q, source);
            const item = {
              ...q,
              id: questionId(source, q.text),
              pageId: source.pageId,
              revisionId: source.revisionId,
              sourceUrl: source.url,
              validation: 'validated' as const,
              quality: 0,
            };
            if (!bank.some((x) => x.id === item.id) && !drafts.some((x) => x.id === item.id))
              drafts.push(item);
          } catch (e) {
            errors.push(String(e));
          }
        }
        if (drafts.length) {
          const result = await provider.json(
            accuracyPrompt,
            {
              source: source.text.slice(0, config.model.maxSourceChars),
              revisionId: source.revisionId,
              questions: drafts,
            },
            accuracySchema,
          );
          if (
            result.reviews.length !== drafts.length ||
            new Set(result.reviews.map((r) => r.id)).size !== drafts.length ||
            result.reviews.some((r) => !drafts.some((q) => q.id === r.id))
          )
            throw Error('Accuracy review did not cover each question exactly once');
          for (const q of drafts) {
            const r = result.reviews.find((r) => r.id === q.id)!;
            if (r.supported && r.singleCorrect && r.distractorsIncorrect && r.timeSafe && r.notable)
              bank.push({ ...q, quality: r.quality });
            else errors.push(`${q.id}: ${r.reason}`);
          }
        }
      } catch (e) {
        errors.push(String(e));
      }
    }
    const deterministic = deterministicConflicts(bank, config);
    conflicts.push(...deterministic);
    const remove = new Set(deterministic.map((c) => c.removeId));
    bank = bank
      .filter((q) => !remove.has(q.id))
      .sort((a, b) => b.quality - a.quality || a.id.localeCompare(b.id))
      .slice(0, config.trivia.target);
    reviewed = false;
    try {
      const review = await reviewBank(provider, source, bank);
      conflicts.push(...review);
      const remove = new Set(review.map((c) => c.removeId));
      bank = bank.filter((q) => !remove.has(q.id));
      reviewed = review.length === 0;
    } catch (e) {
      errors.push(String(e));
    }
    onProgress({ questions: bank, conflicts: [...conflicts], reviewed, errors: [...errors] });
    if (reviewed && bank.length >= config.trivia.target) {
      validateBank(bank, source, config);
      return bank;
    }
  }
  if (reviewed && bank.length >= config.trivia.min) {
    validateBank(bank, source, config);
    return bank;
  }
  throw Error(
    `Trivia pending review: ${bank.length} retained, bank reviewed=${reviewed}; ${errors.at(-1) ?? 'insufficient independent facts'}`,
  );
}
