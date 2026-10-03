import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogueStore } from '../src/store.js';
import { Pipeline } from '../src/pipeline.js';
import { CachedCatalogue } from '../src/runtime.js';
import { RulesDecisions } from '../src/providers.js';
import { RejectedArticle, type WikiProvider } from '../src/wikipedia.js';
import { source, views, cfg, MockText } from './helpers.js';
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'trivattle-'));
  const store = new CatalogueStore(directory);
  const config = cfg();
  config.rarity.minPopulation = 2;
  const text = new MockText();
  let fetches = 0;
  const wiki: WikiProvider = {
    article: async (title, discovery) => {
      fetches++;
      return { ...source(title === 'Other' ? 101 : 100), discovery };
    },
    pageviews: async (s) => views(s, s.pageId === 100 ? 10 : 100),
    random: async () => [],
    popular: async () => [],
  };
  const pipeline = new Pipeline(store, wiki, text, new RulesDecisions(), config);
  return {
    directory,
    store,
    config,
    text,
    wiki,
    pipeline,
    fetches: () => fetches,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
test('page IDs deduplicate redirects, published cards are reused without external requests', async () => {
  const x = setup();
  try {
    await x.store.withWriter(async () => {
      const first = await x.pipeline.ingest('Observatory', 'curated');
      const duplicate = await x.pipeline.ingest('Alternate spelling', 'curated');
      assert.equal(first.id, duplicate.id);
      assert.equal(Object.keys(x.store.data.sources).length, 1);
      await x.pipeline.ingest('Other', 'random');
      x.pipeline.rank();
      await x.pipeline.generate(first);
      assert.equal(first.status, 'published');
      const calls = x.text.calls.length,
        fetches = x.fetches();
      assert.equal((await x.pipeline.ingest('Observatory')).status, 'published');
      await x.pipeline.generate(first);
      assert.equal(x.text.calls.length, calls);
      assert.equal(x.fetches(), fetches);
      assert.deepEqual(x.pipeline.validateAll(), []);
    });
    const reloaded = new CatalogueStore(x.directory, true);
    assert.equal(Object.keys(reloaded.data.published).length, 1);
  } finally {
    x.cleanup();
  }
});
test('interrupted trivia generation resumes metadata and publishes only after review', async () => {
  const x = setup();
  try {
    await x.store.withWriter(async () => {
      const j = await x.pipeline.ingest('Observatory', 'curated');
      await x.pipeline.ingest('Other', 'random');
      x.pipeline.rank();
      x.text.failTrivia = true;
      await x.pipeline.generate(j);
      assert.equal(j.status, 'failed');
      assert.equal(j.stage, 'trivia');
      assert(j.draft);
      assert.equal(Object.keys(x.store.data.published).length, 0);
      const drafts = x.text.calls.filter((c) => c.startsWith('Name and describe')).length;
      x.text.failTrivia = false;
      await x.pipeline.generate(j);
      assert.equal(j.status, 'published');
      assert.equal(x.text.calls.filter((c) => c.startsWith('Name and describe')).length, drafts);
    });
  } finally {
    x.cleanup();
  }
});
test('rarity remains stable after score refresh and rank, historical versions stay cached', async () => {
  const x = setup();
  try {
    await x.store.withWriter(async () => {
      const j = await x.pipeline.ingest('Observatory', 'curated');
      await x.pipeline.ingest('Other', 'random');
      x.pipeline.rank();
      await x.pipeline.generate(j);
      const original = x.store.data.cards[j.publishedVersion!]!;
      const old = JSON.stringify(original);
      x.store.data.views[j.sourceKey!]!.total = 10000;
      x.pipeline.rank();
      assert.equal(JSON.stringify(x.store.data.cards[j.publishedVersion!]), old);
      x.pipeline.rebalance();
      assert.equal(JSON.stringify(x.store.data.cards[j.publishedVersion!]), old);
      assert(
        Object.values(x.store.data.jobs).some(
          (job) =>
            job.id !== j.id &&
            job.pageId === j.pageId &&
            job.assignment?.rarity !== original.rarity,
        ),
      );
    });
  } finally {
    x.cleanup();
  }
});
test('cached runtime is answer-free, nonrepeating across copies, and exhausts safely without credentials', async () => {
  const x = setup();
  try {
    await x.store.withWriter(async () => {
      const j = await x.pipeline.ingest('Observatory', 'curated');
      await x.pipeline.ingest('Other', 'random');
      x.pipeline.rank();
      await x.pipeline.generate(j);
    });
    const runtime = new CachedCatalogue(new CatalogueStore(x.directory, true), x.config);
    const c = runtime.getCard('enwiki:100')!;
    assert(c);
    assert.equal(runtime.getCardsByRarity(c.rarity).length, 1);
    assert(runtime.getRandomCachedCard());
    assert(runtime.getCardGenerationMetadata(c.id));
    const used = new Set<string>(),
      seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const selected = runtime.getUnusedQuestion(i % 2 ? c.id : c.versionId, used);
      assert.equal(selected.kind, 'question');
      if (selected.kind === 'question') {
        assert(!seen.has(selected.question.id));
        seen.add(selected.question.id);
        const json = JSON.stringify(selected.question);
        assert(!json.includes('correctIndex'));
        assert(!json.includes('explanation'));
        assert(!json.includes('evidence'));
      }
    }
    assert.deepEqual(runtime.getUnusedQuestion(c.id, used), {
      kind: 'exhausted',
      triviaMultiplier: 0.5,
      activateEffects: false,
    });
    assert.equal(runtime.getUnusedQuestion(c.id, new Set()).kind, 'question');
    assert.equal(runtime.evaluateAnswer(c.id, c.questionIds[0]!, 0).correct, true);
    assert.throws(() => runtime.evaluateAnswer(c.id, 'invalid', 0));
    assert.throws(() => runtime.evaluateAnswer(c.id, c.questionIds[0]!, 4));
    x.store.export(join(x.directory, 'public.json'));
    assert(!readFileSync(join(x.directory, 'public.json'), 'utf8').includes('correctIndex'));
    assert.throws(() => new CatalogueStore(x.directory, true).save());
  } finally {
    x.cleanup();
  }
});
test('rejected candidates retain reasons, missing views do not rank, writer locking prevents races', async () => {
  const x = setup();
  try {
    await x.store.withWriter(async () => {
      const other = new CatalogueStore(x.directory);
      await assert.rejects(other.withWriter(async () => {}));
      x.wiki.article = async () => {
        throw new RejectedArticle('disambiguation');
      };
      const rejected = await x.pipeline.ingest('Mercury');
      assert.equal(rejected.status, 'rejected');
      assert.match(rejected.errors[0]!.message, /disambiguation/);
      x.wiki.article = async () => source();
      x.wiki.pageviews = async (s) => ({
        ...views(s),
        total: null,
        average: null,
        status: 'missing',
      });
      const missing = await x.pipeline.ingest('No views');
      assert.equal(missing.stage, 'pageviews');
      assert.equal(missing.status, 'failed');
      assert.throws(() => x.pipeline.rank());
    });
  } finally {
    x.cleanup();
  }
});
test('explicit regeneration preserves old versions and reuses immutable trivia for unchanged revision', async () => {
  const x = setup();
  try {
    await x.store.withWriter(async () => {
      const original = await x.pipeline.ingest('Observatory', 'curated');
      await x.pipeline.ingest('Other', 'random');
      x.pipeline.rank();
      await x.pipeline.generate(original);
      assert.equal(original.status, 'published');
      const oldVersion = original.publishedVersion!;
      const nextConfig = structuredClone(x.config);
      nextConfig.generationVersion = 'generator-2';
      const p = new Pipeline(x.store, x.wiki, x.text, new RulesDecisions(), nextConfig);
      const next = await p.ingest('Observatory', 'curated', true);
      p.rank();
      await p.generate(next);
      assert.equal(next.status, 'published', JSON.stringify(next.errors));
      assert.notEqual(next.publishedVersion, oldVersion);
      assert(x.store.data.cards[oldVersion]);
      assert.equal(x.store.data.published['enwiki:100'], next.publishedVersion);
    });
  } finally {
    x.cleanup();
  }
});
test('leakage revalidation quarantines current and explicit version reads', async () => {
  const x = setup();
  try {
    await x.store.withWriter(async () => {
      const j = await x.pipeline.ingest('Observatory', 'curated');
      await x.pipeline.ingest('Other', 'random');
      x.pipeline.rank();
      await x.pipeline.generate(j);
      x.text.leak = true;
      const issues = await x.pipeline.revalidateBanks();
      assert.equal(issues.length, 1);
      assert.match(x.pipeline.validateAll()[0]!, /Quarantined/);
      const runtime = new CachedCatalogue(x.store, x.config);
      assert.equal(runtime.getCard('enwiki:100'), undefined);
      assert.equal(runtime.getCard(j.publishedVersion!), undefined);
      assert(j.conflicts.length);
    });
  } finally {
    x.cleanup();
  }
});
test('retry-failed recovers missing analytics then establishes rarity and completes generation', async () => {
  const x = setup();
  try {
    await x.store.withWriter(async () => {
      const normal = x.wiki.pageviews;
      x.wiki.pageviews = async () => {
        throw Error('Temporary analytics outage');
      };
      const first = await x.pipeline.ingest('Observatory', 'curated');
      const second = await x.pipeline.ingest('Other', 'random');
      assert.equal(first.stage, 'pageviews');
      assert.equal(second.status, 'failed');
      x.wiki.pageviews = normal;
      await x.pipeline.retryFailed();
      assert.equal(first.status, 'published', JSON.stringify(first.errors));
      assert.equal(second.status, 'published', JSON.stringify(second.errors));
      assert.equal(Object.keys(x.store.data.published).length, 2);
    });
  } finally {
    x.cleanup();
  }
});
