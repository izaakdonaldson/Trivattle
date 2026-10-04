import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
export const types = [
  'history',
  'science',
  'technology',
  'nature',
  'culture',
  'geography',
  'basic',
] as const;
export const rarities = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;
export const effectIds = ['burn', 'heal', 'pierce', 'weaken', 'splash'] as const;
export const passiveIds = ['stalwart', 'recovery', 'immune'] as const;
export const Type = z.enum(types),
  Rarity = z.enum(rarities),
  Effect = z.enum(effectIds),
  Passive = z.enum(passiveIds);
export type CardType = z.infer<typeof Type>;
export type RarityName = z.infer<typeof Rarity>;
export const hash = (x: unknown) =>
  createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 20);
export const normalize = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
export const wordCount = (s: string) =>
  (s.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;
export const sourceSchema = z.object({
  pageId: z.number().int().positive(),
  title: z.string(),
  url: z.url(),
  revisionId: z.number().int().positive(),
  wikidataId: z.string().nullable(),
  summary: z.string(),
  wordCount: z.number().int(),
  text: z.string(),
  categories: z.array(z.string()),
  fetchedAt: z.iso.datetime(),
  image: z
    .object({
      url: z.url(),
      fileName: z.string(),
      attribution: z.string().nullable(),
      license: z.string().nullable(),
      licenseUrl: z.string().nullable(),
      descriptionUrl: z.string().nullable(),
    })
    .nullable(),
  textLicense: z.string(),
  discovery: z.enum(['curated', 'popular', 'random', 'manual']),
});
export type Source = z.infer<typeof sourceSchema>;
export const viewsSchema = z.object({
  pageId: z.number().int(),
  title: z.string(),
  status: z.enum(['complete', 'missing']),
  total: z.number().nonnegative().nullable(),
  average: z.number().nonnegative().nullable(),
  start: z.string(),
  end: z.string(),
  days: z.number().int(),
  fetchedAt: z.iso.datetime(),
});
export type Views = z.infer<typeof viewsSchema>;
export const questionDraftSchema = z
  .object({
    text: z.string().min(12),
    options: z.tuple([z.string().min(1), z.string().min(1), z.string().min(1), z.string().min(1)]),
    correctIndex: z.number().int().min(0).max(3),
    explanation: z.string().min(10),
    evidence: z.string().min(20),
    factKey: z.string().min(3),
  })
  .strict();
export const questionSchema = questionDraftSchema.extend({
  id: z.string(),
  pageId: z.number().int(),
  sourceUrl: z.url(),
  revisionId: z.number().int(),
  validation: z.literal('validated'),
  quality: z.number().min(0).max(1),
});
export type QuestionDraft = z.infer<typeof questionDraftSchema>;
export type Question = z.infer<typeof questionSchema>;
export const attackSchema = z
  .object({
    id: z.string(),
    name: z.string().min(3),
    type: Type,
    power: z.number().int(),
    effectId: Effect.nullable(),
    effectParameters: z.record(z.string(), z.number()).nullable(),
    description: z.string().min(10),
  })
  .strict();
export const rarityAssignmentSchema = z.object({
  rarity: Rarity,
  score: z.number().nonnegative(),
  percentile: z.number().min(0).max(1),
  version: z.string(),
  populationId: z.string(),
});
export type Assignment = z.infer<typeof rarityAssignmentSchema>;
export const cardSchema = z
  .object({
    id: z.string(),
    versionId: z.string(),
    pageId: z.number().int(),
    sourceKey: z.string(),
    name: z.string(),
    type: Type,
    rarity: Rarity,
    hp: z.number().int(),
    defense: z.number().int(),
    attacks: z.array(attackSchema),
    passive: z.object({ id: Passive }).nullable(),
    rarityAssignment: rarityAssignmentSchema,
    generationVersion: z.string(),
    balanceVersion: z.string(),
    status: z.enum(['published', 'fixture']),
    questionIds: z.array(z.string()),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const effects = c.attacks.filter((a) => a.effectId !== null).length,
      p = Number(c.passive !== null),
      n = c.attacks.length;
    const valid = {
      common: n === 1 && effects === 0 && p === 0,
      uncommon: n === 2 && effects === 0 && p === 0,
      rare: n === 2 && ((effects === 1 && p === 1) || (effects === 2 && p === 0)),
      epic: n === 2 && effects === 2 && p === 1,
      legendary: n === 3 && effects === 2 && p === 1,
    }[c.rarity];
    if (!valid)
      ctx.addIssue({ code: 'custom', message: 'Invalid rarity attack/effect/passive combination' });
    if (c.type === 'basic' && c.passive?.id === 'immune')
      ctx.addIssue({ code: 'custom', message: 'Basic cannot receive Immune' });
    if (new Set(c.attacks.map((a) => a.id)).size !== n)
      ctx.addIssue({ code: 'custom', message: 'Duplicate attack IDs' });
    if (new Set(c.questionIds).size !== c.questionIds.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate question IDs' });
    if (c.rarity !== c.rarityAssignment.rarity)
      ctx.addIssue({ code: 'custom', message: 'Rarity assignment mismatch' });
  });
export type Card = z.infer<typeof cardSchema>;
export function validateCard(card: unknown, config: Config) {
  const c = cardSchema.parse(card);
  for (const [v, range] of [
    [c.hp, config.hp],
    [c.defense, config.defense],
    ...c.attacks.map((a) => [a.power, a.effectId ? config.specialPower : config.standardPower]),
  ] as [number, [number, number]][])
    if (v < range[0] || v > range[1]) throw Error('Stat outside configured range');
  for (const a of c.attacks)
    if (
      JSON.stringify(a.effectParameters) !==
      JSON.stringify(a.effectId ? config.effects[a.effectId] : null)
    )
      throw Error('Invalid effect parameters');
  if (c.questionIds.length < config.trivia.min || c.questionIds.length > config.trivia.max)
    throw Error('Invalid question bank size');
  return c;
}
export function seededInt(seed: unknown, range: [number, number]) {
  return range[0] + (parseInt(hash(seed).slice(0, 8), 16) % (range[1] - range[0] + 1));
}
export type Stage = 'source' | 'pageviews' | 'rarity' | 'metadata' | 'trivia' | 'publish';
export type Conflict = { a: string; b: string; reason: string; removeId: string };
export type Job = {
  id: string;
  title: string;
  discovery: Source['discovery'];
  pageId?: number;
  sourceKey?: string;
  status: 'pending' | 'failed' | 'rejected' | 'published';
  stage: Stage;
  attempts: number;
  errors: { stage: Stage; message: string; at: string }[];
  conflicts: Conflict[];
  updatedAt: string;
  config: Config;
  providers: Record<string, string>;
  assignment?: Assignment;
  draft?: Omit<Card, 'questionIds' | 'status'>;
  questions?: Question[];
  bankReviewed?: boolean;
  leakageReviewSkipped?: boolean;
  publishedVersion?: string;
};
