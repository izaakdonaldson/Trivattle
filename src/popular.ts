import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { HttpClient } from './http.js';

const monthlySchema = z.object({
  items: z
    .array(
      z.object({
        articles: z
          .array(
            z.object({
              article: z.string().min(1),
              rank: z.number().int().positive(),
              views: z.number().int().nonnegative(),
            }),
          )
          .min(1)
          .max(1000),
      }),
    )
    .length(1),
});

/** Complete calendar months only: never cache a partial current month. */
export function popularMonths(months: number, now = new Date()): string[] {
  if (!Number.isInteger(months) || months < 1 || months > 24)
    throw Error('--popular-months must be an integer from 1 to 24');
  if (!Number.isFinite(+now)) throw Error('Invalid popular pool date');
  const result = Array.from({ length: months }, (_, i) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i - 1, 1))
      .toISOString()
      .slice(0, 7),
  );
  if (result.at(-1)! < '2015-07') throw Error('Pageview data starts in July 2015');
  return result;
}

function atomicWrite(path: string, value: unknown) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
}

/** The union of monthly top-1000 lists, not an exact ranking across the whole period. */
export async function buildPopularPool(
  http: HttpClient,
  directory: string,
  months = 24,
  now = new Date(),
) {
  const periods = popularMonths(months, now);
  mkdirSync(directory, { recursive: true });
  const titles = new Set<string>();
  for (const month of periods) {
    const path = join(directory, `${month}.json`);
    let data;
    if (existsSync(path)) {
      data = monthlySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    } else {
      // Fail visibly on missing data; successful prior months remain cached for retry.
      data = monthlySchema.parse(
        await http.json(
          `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia.org/all-access/${month.replace('-', '/')}/all-days`,
        ),
      );
      atomicWrite(path, data);
    }
    for (const article of data.items[0]!.articles) {
      const title = article.article.replaceAll('_', ' ');
      if (
        article.rank <= 1000 &&
        title !== 'Main Page' &&
        !title.includes(':') &&
        !/^(list of|lists of|index of|outline of)\b/i.test(title)
      )
        titles.add(title);
    }
  }
  const pool = {
    project: 'en.wikipedia.org',
    method: 'union-of-monthly-top-1000',
    months: periods,
    titles: [...titles].sort(),
  };
  atomicWrite(join(directory, 'pool.json'), pool);
  return pool;
}

/** Uniform sampling without replacement, skipping previously attempted titles. */
export function samplePopular(titles: string[], count: number, exclude: string[] = []) {
  if (!Number.isSafeInteger(count) || count < 1)
    throw Error('Popular count must be a positive safe integer');
  const seen = new Set(exclude.map((title) => title.replaceAll('_', ' ').toLowerCase()));
  const candidates = [...new Set(titles)].filter((title) => !seen.has(title.toLowerCase()));
  for (let i = 0; i < Math.min(count, candidates.length); i++) {
    const j = randomInt(i, candidates.length);
    [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
  }
  return candidates.slice(0, count);
}
