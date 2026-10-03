import { readFileSync } from 'node:fs';
import { z } from 'zod';
const range = z
  .tuple([z.number().int().positive(), z.number().int().positive()])
  .refine(([a, b]) => a <= b);
export const configSchema = z
  .object({
    version: z.string(),
    generationVersion: z.string(),
    hp: range,
    defense: range,
    standardPower: range,
    specialPower: range,
    effects: z.object({
      burn: z.object({ damage: z.number().positive(), turns: z.number().int().positive() }),
      heal: z.object({ hp: z.number().positive() }),
      pierce: z.object({}).strict(),
      weaken: z.object({ multiplier: z.number().min(0).max(1) }),
      splash: z.object({ fraction: z.number().min(0).max(1) }),
    }),
    passives: z.object({
      stalwart: z.object({ multiplier: z.number().min(0).max(1) }),
      recovery: z.object({ hp: z.number().positive(), threshold: z.number().min(0).max(1) }),
      immune: z.object({}).strict(),
    }),
    battle: z.object({
      teamSize: z.number().int().positive(),
      correctMultiplier: z.number().nonnegative(),
      incorrectMultiplier: z.number().nonnegative(),
      exhaustedMultiplier: z.number().nonnegative(),
      exhaustedEffects: z.boolean(),
      minimumDamage: z.number().int().positive(),
    }),
    trivia: z
      .object({
        target: z.number().int().min(10).max(15),
        min: z.number().int().min(10).max(15),
        max: z.number().int().min(10).max(15),
        extraCandidates: z.number().int().nonnegative(),
        attempts: z.number().int().positive(),
        nearDuplicateThreshold: z.number().min(0).max(1),
      })
      .refine((x) => x.min <= x.target && x.target <= x.max),
    ingestion: z.object({
      minWords: z.number().int().positive(),
      minParagraphs: z.number().int().positive(),
      minProseFraction: z.number().min(0).max(1),
      pageviewDays: z.literal(90),
      pageviewDelayRetries: z.number().int().nonnegative(),
    }),
    rarity: z
      .object({
        version: z.string(),
        minPopulation: z.number().int().min(2),
        tiers: z
          .array(
            z.tuple([
              z.enum(['common', 'uncommon', 'rare', 'epic', 'legendary']),
              z.number().min(0).max(1),
            ]),
          )
          .length(5),
      })
      .refine(
        (x) =>
          new Set(x.tiers.map((t) => t[0])).size === 5 &&
          x.tiers.at(-1)?.[1] === 1 &&
          x.tiers.every((t, i) => i === 0 || t[1] > x.tiers[i - 1]![1]),
      ),
    http: z.object({
      attempts: z.number().int().positive(),
      timeoutMs: z.number().positive(),
      intervalMs: z.number().nonnegative(),
      backoffMs: z.number().nonnegative(),
    }),
    model: z.object({
      temperature: z.number().min(0).max(2),
      maxTokens: z.number().int().positive(),
      schemaAttempts: z.number().int().positive(),
      maxSourceChars: z.number().int().positive(),
    }),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export function loadConfig(
  path = process.env.CARD_CONFIG ?? new URL('../config/gameplay.json', import.meta.url),
) {
  return configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
export const defaultConfig = loadConfig();
export const effectiveness = z
  .object({
    version: z.string(),
    neutral: z.literal(1),
    strong: z.number().gt(1),
    weak: z.number().gt(0).lt(1),
    counters: z.record(z.string(), z.string()),
  })
  .parse(
    JSON.parse(
      readFileSync(
        process.env.TYPE_CONFIG ?? new URL('../config/effectiveness.json', import.meta.url),
        'utf8',
      ),
    ),
  );
