import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardArtCache, imageCandidates } from '../src/card-art.js';

test('shared artwork retries Wikimedia hosts, deduplicates and survives cache restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trivattle-art-'));
  try {
    const calls: string[] = [];
    const transport = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return String(url).includes('thumb.wikimedia.org')
        ? new Response('', { status: 429 })
        : new Response('image-bytes', { headers: { 'content-type': 'image/jpeg' } });
    }) as typeof fetch;
    const cache = new CardArtCache(dir, transport);
    const url = 'https://thumb.wikimedia.org/wikipedia/commons/a/ab/Earth.jpg?utm_source=test';
    const [a, b] = await Promise.all([cache.get(url), cache.get(url)]);
    assert.deepEqual(a, b);
    assert.equal(a.bytes.toString(), 'image-bytes');
    assert.equal(calls.length, 2);
    assert.ok(calls.every((u) => !u.includes('?')));
    const restored = new CardArtCache(dir, (() => {
      throw Error('Must use cached bytes');
    }) as typeof fetch);
    assert.deepEqual(await restored.get(url), a);
    assert.deepEqual(imageCandidates('https://localhost/private'), []);
    assert.deepEqual(imageCandidates('https://upload.wikimedia.org:123/wikipedia/a.jpg'), []);
    await assert.rejects(cache.get('https://example.com/a.jpg'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
