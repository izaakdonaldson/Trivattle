import { z } from 'zod';
import { defaultConfig } from '../src/config.js';
import {
  hash,
  seededInt,
  type Card,
  type Question,
  type Source,
  type Views,
} from '../src/domain.js';
import { questionId, type TextProvider } from '../src/providers.js';
export const cfg = () => structuredClone(defaultConfig);
export const facts = [
  [
    'What material forms the fictional observatory dome?',
    'Copper',
    'The observatory dome is built from Copper.',
  ],
  [
    'Which fictional architect designed the west entrance?',
    'Mira',
    'The west entrance was designed by Mira.',
  ],
  [
    'In what month does the fictional archive open?',
    'April',
    'The archive opens each year in April.',
  ],
  [
    'What animal appears on the fictional institute emblem?',
    'Otter',
    'The institute emblem depicts an Otter.',
  ],
  [
    'Which instrument is housed in the fictional north tower?',
    'Telescope',
    'The north tower houses a Telescope.',
  ],
  [
    'What color is the fictional laboratory floor?',
    'Amber',
    'The laboratory floor has an Amber color.',
  ],
  [
    'Which river borders the fictional research grounds?',
    'Tarn',
    'The research grounds border the Tarn river.',
  ],
  [
    'What fruit grows in the fictional courtyard orchard?',
    'Pear',
    'The courtyard orchard grows the Pear fruit.',
  ],
  [
    'Which language names the fictional lecture hall?',
    'Latin',
    'The lecture hall has a name in Latin.',
  ],
  [
    'What rock forms the fictional monument base?',
    'Granite',
    'The monument base consists of Granite.',
  ],
  [
    'Which musician composed the fictional academy anthem?',
    'Orin',
    'The academy anthem was composed by Orin.',
  ],
  [
    'What shape is the fictional library reading room?',
    'Hexagon',
    'The library reading room is shaped as a Hexagon.',
  ],
] as const;
export function source(pageId = 100): Source {
  return {
    pageId,
    title: `Fixture Observatory ${pageId}`,
    url: `https://en.wikipedia.org/wiki/Fixture_Observatory_${pageId}`,
    revisionId: 1,
    wikidataId: null,
    summary: 'A fictional scientific observatory used only for deterministic tests.',
    text: facts.map((f) => f[2]).join('\n\n'),
    wordCount: 600,
    categories: ['Science'],
    fetchedAt: '2026-10-01T00:00:00.000Z',
    image: null,
    textLicense: 'Synthetic test data, not Wikipedia content',
    discovery: pageId % 2 ? 'random' : 'curated',
  };
}
export function questions(s = source()): Question[] {
  return facts.map(([text, answer, evidence], i) => ({
    id: questionId(s, text),
    pageId: s.pageId,
    sourceUrl: s.url,
    revisionId: s.revisionId,
    text,
    options: [answer, `Alternative ${i} A`, `Alternative ${i} B`, `Alternative ${i} C`],
    correctIndex: 0,
    explanation: evidence,
    evidence,
    factKey: `independent-fact-${i}`,
    validation: 'validated',
    quality: 1,
  }));
}
export function views(s = source(), total = 100): Views {
  return {
    pageId: s.pageId,
    title: s.title,
    status: 'complete',
    total,
    average: total / 90,
    start: '2026-07-03',
    end: '2026-09-30',
    days: 90,
    fetchedAt: '2026-10-01T00:00:00.000Z',
  };
}
export function card(
  rarity: Card['rarity'] = 'common',
  pageId = 100,
  rareMode: 'A' | 'B' = 'A',
): Card {
  const s = source(pageId),
    c = cfg(),
    n = rarity === 'common' ? 1 : rarity === 'legendary' ? 3 : 2,
    e =
      rarity === 'common' || rarity === 'uncommon'
        ? 0
        : rarity === 'rare' && rareMode === 'A'
          ? 1
          : 2,
    p = rarity === 'epic' || rarity === 'legendary' || (rarity === 'rare' && rareMode === 'A');
  const seed = [pageId, c.generationVersion, hash(c)];
  return {
    id: `enwiki:${pageId}`,
    versionId: `fixture:${pageId}:${rarity}:${rareMode}`,
    pageId,
    sourceKey: `${pageId}:1`,
    name: s.title,
    type: 'science',
    rarity,
    hp: seededInt([...seed, 'hp'], c.hp),
    defense: seededInt([...seed, 'defense'], c.defense),
    attacks: Array.from({ length: n }, (_, i) => ({
      id: `fixture:${pageId}:${rarity}:attack:${i}`,
      name: `Observatory lens ${i + 1}`,
      description: 'Fictional lens attack for development fixtures.',
      type: 'science',
      power: seededInt(
        [...seed, i < e ? 'specialPower' : 'standardPower'],
        i < e ? c.specialPower : c.standardPower,
      ),
      effectId: i < e ? (i === 0 ? 'pierce' : 'weaken') : null,
      effectParameters: i < e ? (i === 0 ? c.effects.pierce : c.effects.weaken) : null,
    })),
    passive: p ? { id: 'stalwart' } : null,
    rarityAssignment: {
      rarity,
      score: 100,
      percentile: 0.5,
      version: 'fixture-only',
      populationId: 'fixture-only',
    },
    generationVersion: c.generationVersion,
    balanceVersion: c.version,
    status: 'fixture',
    questionIds: questions(s).map((q) => q.id),
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}
export class MockText implements TextProvider {
  readonly id = 'mock-test-only';
  calls: string[] = [];
  failTrivia = false;
  leak = false;
  accuracyReject = false;
  async json<T>(task: string, input: any, schema: z.ZodType<T>): Promise<T> {
    this.calls.push(task);
    let output: unknown;
    if (task.startsWith('Name and describe'))
      output = {
        attacks: input.plan.attacks.map((_: unknown, i: number) => ({
          name: `Observatory lens ${i + 1}`,
          description: 'A fictional optical response from the observatory.',
          thematicSupport: 'The source describes a scientific observatory.',
        })),
      };
    else if (task.startsWith('Generate article-specific')) {
      if (this.failTrivia) throw Error('Mock provider outage');
      output = {
        questions: questions({ ...source(), pageId: input.pageId ?? 100 }).map(
          ({ text, options, correctIndex, explanation, evidence, factKey }) => ({
            text,
            options,
            correctIndex,
            explanation,
            evidence,
            factKey,
          }),
        ),
      };
    } else if (task.startsWith('Audit EACH'))
      output = {
        reviews: input.questions.map((q: Question) => ({
          id: q.id,
          supported: !this.accuracyReject,
          singleCorrect: true,
          distractorsIncorrect: true,
          timeSafe: true,
          notable: true,
          quality: 1,
          reason: this.accuracyReject ? 'Unsupported' : 'Supported',
        })),
      };
    else
      output = {
        conflicts:
          this.leak && input.questions.length >= 2
            ? [
                {
                  a: input.questions[0].id,
                  b: input.questions[1].id,
                  removeId: input.questions[1].id,
                  reason: 'Indirect answer giveaway detected',
                },
              ]
            : [],
      };
    return schema.parse(output);
  }
}
