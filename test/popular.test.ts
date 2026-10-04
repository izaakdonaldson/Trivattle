import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPopularPool, popularMonths, samplePopular } from '../src/popular.js';
import { HttpClient, HttpError } from '../src/http.js';
import { cfg } from './helpers.js';

test('popular months cross year boundaries and exclude the current incomplete month', () => {
  assert.deepEqual(popularMonths(3, new Date('2026-02-01')), ['2026-01', '2025-12', '2025-11']);
  assert.equal(popularMonths(24, new Date('2026-10-03')).at(-1), '2024-10');
  for (const n of [0, 25, 1.5, NaN]) assert.throws(() => popularMonths(n));
});

test('monthly pool deduplicates and filters titles, persists metadata and reuses cached requests', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'popular-'));
  const urls: string[] = [];
  const http = new HttpClient({ ...cfg().http, intervalMs: 0 }, 'test', async (url) => {
    urls.push(String(url));
    return new Response(
      JSON.stringify({
        items: [
          {
            articles: [
              'Main_Page',
              'Special:Search',
              'List_of_cats',
              'Earth',
              'A_B',
              urls.length === 1 ? 'Sun' : 'Moon',
            ].map((article, i) => ({ article, rank: i + 1, views: 10000 })),
          },
        ],
      }),
    );
  });
  try {
    const pool = await buildPopularPool(http, directory, 2, new Date('2026-01-15'));
    assert.deepEqual(pool.titles, ['A B', 'Earth', 'Moon', 'Sun']);
    assert(urls[0]!.endsWith('/2025/12/all-days'));
    assert(urls[1]!.endsWith('/2025/11/all-days'));
    assert.deepEqual(await buildPopularPool(http, directory, 2, new Date('2026-01-31')), pool);
    assert.equal(urls.length, 2);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'pool.json'), 'utf8')), pool);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('missing monthly data fails visibly instead of silently shrinking the requested window', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'popular-'));
  const http = new HttpClient(
    { ...cfg().http, intervalMs: 0 },
    'test',
    async () => new Response('{}', { status: 404 }),
  );
  try {
    await assert.rejects(
      buildPopularPool(http, directory, 3),
      (e) => e instanceof HttpError && e.status === 404,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('sampling never repeats titles or falls back outside the pool when exhausted', () => {
  const pool = ['Earth', 'Sun', 'Moon', 'A B'];
  assert.deepEqual(new Set(samplePopular(pool, 10, ['earth', 'A_B'])), new Set(['Sun', 'Moon']));
  assert.deepEqual(samplePopular(pool, 2, pool), []);
  for (let i = 0; i < 30; i++) {
    const chosen = samplePopular(pool, 2);
    assert.equal(new Set(chosen).size, 2);
    assert(chosen.every((title) => pool.includes(title)));
  }
});
