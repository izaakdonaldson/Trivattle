import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, type Fetch } from '../src/http.js';
import { Wikipedia } from '../src/wikipedia.js';
import { JevDecisions, DeepSeek } from '../src/providers.js';
import { z } from 'zod';
import { source, cfg } from './helpers.js';
const response = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const client = (fetcher: Fetch) =>
  new HttpClient(
    { ...cfg().http, intervalMs: 0, backoffMs: 0 },
    'Trivattle/0.1 (test@example.org)',
    fetcher,
    async () => {},
  );
test('HTTP respects Retry-After and retries transient failures but not auth errors', async () => {
  let calls = 0;
  const waits: number[] = [];
  const h = new HttpClient(
    { ...cfg().http, intervalMs: 0 },
    'test',
    async () =>
      ++calls === 1 ? response({}, 429, { 'retry-after': '2' }) : response({ ok: true }),
    async (ms) => {
      waits.push(ms);
    },
  );
  assert.deepEqual(await h.json('https://example.org'), { ok: true });
  assert(waits.includes(2000));
  calls = 0;
  await assert.rejects(
    client(async () => {
      calls++;
      return response({}, 401);
    }).json('https://example.org'),
  );
  assert.equal(calls, 1);
});
test('Jev uses documented structured Choice contract and validates returned option', async () => {
  let body: any;
  const h = client(async (_url, init) => {
    body = JSON.parse(init!.body as string);
    return response({
      model: 'jev-latest',
      answers: {
        decision: {
          type: 'choice',
          choice: 'science',
          confidence: 0.9,
          probabilities: { science: 0.9, basic: 0.1 },
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
  assert.equal(
    await new JevDecisions(h, 'fake').choose(source(), 'Classify', ['science', 'basic'], 'basic'),
    'science',
  );
  assert.equal(body.questions.decision.type, 'choice');
  assert.deepEqual(body.questions.decision.criteria, { science: 'science', basic: 'basic' });
});
test('DeepSeek defaults to deepseek-flash JSON output and bounds schema retries', async () => {
  let body: any,
    calls = 0;
  const h = client(async (_url, init) => {
    calls++;
    body = JSON.parse(init!.body as string);
    return response({
      choices: [
        { finish_reason: 'stop', message: { content: calls === 1 ? '{}' : '{"answer":"ok"}' } },
      ],
    });
  });
  const provider = new DeepSeek(h, cfg(), 'fake');
  assert.deepEqual(await provider.json('test', {}, z.object({ answer: z.string() })), {
    answer: 'ok',
  });
  assert.equal(calls, 2);
  assert.equal(body.model, 'deepseek-flash');
  assert.equal(body.response_format.type, 'json_object');
  await assert.rejects(
    new DeepSeek(h, cfg(), '').json('test', {}, z.object({ answer: z.string() })),
  );
});
test('pageviews use 90 complete UTC days and distinguish zero from missing', async () => {
  let url = '';
  const h = client(async (u) => {
    url = String(u);
    const parts = url.split('/');
    const from = parts.at(-2)!;
    const date = new Date(`${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6, 8)}T00:00:00Z`);
    return response({
      items: Array.from({ length: 90 }, (_, i) => ({
        timestamp:
          new Date(+date + i * 86400000).toISOString().slice(0, 10).replaceAll('-', '') + '00',
        views: 0,
      })),
    });
  });
  const result = await new Wikipedia(h, cfg()).pageviews(
    { ...source(), title: 'A / B' },
    new Date('2026-10-03T23:59:00Z'),
  );
  assert.equal(result.total, 0);
  assert.equal(result.status, 'complete');
  assert.equal(result.start, '2026-07-05');
  assert.equal(result.end, '2026-10-02');
  assert(url.includes('all-access/user/A_%2F_B'));
  const missing = await new Wikipedia(
    client(async () => response({ items: [] })),
    cfg(),
  ).pageviews(source(), new Date('2026-10-03'));
  assert.equal(missing.status, 'missing');
  assert.equal(missing.total, null);
});
test('Wikipedia follows canonical titles, resolves IDs, uses free images with per-file license', async () => {
  const urls: string[] = [];
  const prose = Array.from(
    { length: 10 },
    () =>
      '<p>' +
      'This article describes a notable scientific subject with meaningful historical facts. '.repeat(
        6,
      ) +
      '</p>',
  ).join('');
  const h = client(async (u) => {
    const url = String(u);
    urls.push(url);
    if (url.includes('/with_html'))
      return response({ id: 100, title: 'Canonical / Name', latest: { id: 77 }, html: prose });
    if (url.includes('imageinfo'))
      return response({
        query: {
          pages: [
            {
              imageinfo: [
                {
                  descriptionurl: 'https://commons.wikimedia.org/wiki/File:X.jpg',
                  extmetadata: {
                    Artist: { value: '<b>Example artist</b>' },
                    LicenseShortName: { value: 'CC BY 4.0' },
                    LicenseUrl: { value: 'https://creativecommons.org/licenses/by/4.0/' },
                  },
                },
              ],
            },
          ],
        },
      });
    return response({
      query: {
        pages: [
          {
            pageid: 100,
            ns: 0,
            title: 'Canonical / Name',
            fullurl: 'https://en.wikipedia.org/wiki/Canonical',
            pageprops: { wikibase_item: 'Q1' },
            categories: [{ title: 'Category:Science' }],
            thumbnail: { source: 'https://upload.wikimedia.org/example.jpg' },
            pageimage: 'X.jpg',
          },
        ],
      },
    });
  });
  const s = await new Wikipedia(h, cfg()).article('Alias');
  assert.equal(s.pageId, 100);
  assert.equal(s.revisionId, 77);
  assert.equal(s.image!.license, 'CC BY 4.0');
  assert.equal(s.image!.attribution, 'Example artist');
  assert(urls.some((u) => u.includes('Canonical%20%2F%20Name/with_html')));
  assert(urls[0]!.includes('pilicense=free'));
  assert(s.wordCount >= 500);
});
