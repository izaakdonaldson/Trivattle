import 'dotenv/config';
import { Command } from 'commander';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { CatalogueStore } from './store.js';
import { HttpClient } from './http.js';
import { Wikipedia } from './wikipedia.js';
import { DeepSeek, JevDecisions, RulesDecisions } from './providers.js';
import { Pipeline } from './pipeline.js';
import { buildPopularPool, popularMonths, samplePopular } from './popular.js';
import type { Source } from './domain.js';
const program = new Command()
  .name('generate-cards')
  .description('Offline Wikipedia card generation; cached reads need no credentials.')
  .option('--title <title>', 'ingest one article')
  .option('--random <count>', 'discover random articles', Number)
  .option('--popular <count>', 'discover popular articles from a recent daily list', Number)
  .option('--popular-only <count>', 'sample only from cached monthly top-1000 lists', Number)
  .option('--popular-months <count>', 'completed months in the popular pool (1–24)', Number, 24)
  .option(
    '--build-popular-pool',
    'cache monthly top-1000 lists and exit without article or AI requests',
  )
  .option('--titles-file <path>', 'curated title list, one title per line')
  .option('--batch <count>', 'maximum eligible jobs to generate', Number, 50)
  .option('--retry-failed', 'resume incomplete jobs')
  .option('--skip-leakage-review', 'skip AI cross-question leakage review for this run (demo mode)')
  .option(
    '--min-pageviews90d <count>',
    'minimum complete 90-day views (default 50000; 0 disables cutoff)',
    Number,
  )
  .option('--rank', 'compute a rarity population; published cards stay stable')
  .option('--rebalance', 'explicitly stage new versions for changed rarities')
  .option('--regenerate', 'fetch a source again; bump generationVersion in configuration first')
  .option('--refresh-pageviews', 'refresh candidate pageview cache for a new ranking')
  .option(
    '--as-of <date>',
    'UTC pageview window anchor, YYYY-MM-DD (use a shared date when data is delayed)',
  )
  .option('--validate', 'validate cached published versions deterministically')
  .option('--revalidate-trivia', 'online full-bank leakage review; quarantine conflicts')
  .option('--export <path>', 'export public cards without answers')
  .option('--include-answers', 'include full trivia in server-only export')
  .option('--stats', 'show generation statistics')
  .option('--verbose', 'log AI request timing, output tokens and schema retries')
  .option('--dry-run', 'show intended actions without network calls, generation or file writes')
  .option(
    '--catalogue <path>',
    'catalogue directory',
    process.env.CARD_CATALOGUE ?? 'data/catalogue',
  )
  .option('--config <path>', 'gameplay configuration JSON');
program.parse();
const opts = program.opts();
async function main() {
  if (opts.skipLeakageReview && opts.revalidateTrivia)
    throw Error('--skip-leakage-review cannot be combined with --revalidate-trivia');
  for (const key of ['random', 'popular', 'popularOnly', 'batch'])
    if (opts[key] !== undefined && (!Number.isSafeInteger(opts[key]) || opts[key] < 1))
      throw Error(`--${key === 'popularOnly' ? 'popular-only' : key} must be a positive integer`);
  const now = opts.asOf ? new Date(opts.asOf + 'T00:00:00Z') : new Date();
  if (
    opts.asOf &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(opts.asOf) ||
      !Number.isFinite(+now) ||
      now.toISOString().slice(0, 10) !== opts.asOf)
  )
    throw Error('Invalid --as-of date');
  const poolMonths =
    opts.popularOnly || opts.buildPopularPool ? popularMonths(opts.popularMonths, now) : undefined;
  if (
    (opts.popularOnly || opts.buildPopularPool) &&
    (opts.random || opts.popular || opts.title || opts.titlesFile)
  )
    throw Error(
      'Popular-only discovery cannot be combined with --random, --popular, --title or --titles-file',
    );
  const cfg = loadConfig(opts.config);
  if (opts.popularOnly) cfg.rarity.referenceMode = 'popular';
  if (opts.minPageviews90d !== undefined) {
    if (!Number.isSafeInteger(opts.minPageviews90d) || opts.minPageviews90d < 0) {
      throw Error('--min-pageviews90d must be a nonnegative safe integer');
    }
    cfg.ingestion.minPageviews90d = opts.minPageviews90d;
  }
  const store = new CatalogueStore(opts.catalogue, !!opts.dryRun);
  const titles: { title: string; discovery: Source['discovery'] }[] = [];
  if (opts.title) titles.push({ title: opts.title, discovery: 'manual' });
  if (opts.titlesFile)
    for (const title of readFileSync(opts.titlesFile, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#')))
      titles.push({ title, discovery: 'curated' });
  const network = !!(
    titles.length ||
    opts.random ||
    opts.popular ||
    opts.popularOnly ||
    opts.buildPopularPool ||
    opts.retryFailed ||
    opts.refreshPageviews ||
    opts.revalidateTrivia ||
    opts.rebalance
  );
  if (opts.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          minPageviews90d: cfg.ingestion.minPageviews90d,
          titles,
          random: opts.random ?? 0,
          popular: opts.popular ?? 0,
          popularOnly: opts.popularOnly ?? 0,
          popularPool:
            opts.popularOnly || opts.buildPopularPool
              ? {
                  months: poolMonths,
                  path: resolve(store.directory, 'popular-pool/pool.json'),
                  method: 'union-of-monthly-top-1000',
                }
              : undefined,
          batch: opts.batch,
          actions: opts,
          cachedCards: Object.keys(store.data.published).length,
        },
        null,
        2,
      ),
    );
    return;
  }
  const agent = process.env.WIKIMEDIA_USER_AGENT ?? '';
  if (network && !/\(.+(?:@|https?:\/\/).+\)/.test(agent))
    throw Error(
      'Set WIKIMEDIA_USER_AGENT to Trivattle/0.1 (contact email or URL) before online operations',
    );
  const http = new HttpClient(cfg.http, agent || 'Trivattle-offline');
  const wiki = new Wikipedia(http, cfg);
  const provider = new DeepSeek(
    http,
    cfg,
    undefined,
    undefined,
    undefined,
    undefined,
    opts.verbose ? (message) => console.error(message) : undefined,
  );
  const decisions = process.env.JEV_API_KEY ? new JevDecisions(http) : new RulesDecisions();
  const pipeline = new Pipeline(store, wiki, provider, decisions, cfg, {
    skipLeakageReview: !!opts.skipLeakageReview,
    onProgress: (message) => console.log(message),
  });
  if (opts.skipLeakageReview)
    console.log('AI leakage review skipped; accuracy and local validation remain enabled.');
  const report = () => {
    if (opts.validate) {
      const errors = pipeline.validateAll();
      console.log(JSON.stringify({ valid: errors.length === 0, errors }, null, 2));
      if (errors.length) process.exitCode = 1;
    }
    if (opts.export) {
      mkdirSync(dirname(resolve(opts.export)), { recursive: true });
      store.export(opts.export, opts.includeAnswers);
      console.log(
        `Exported ${Object.keys(store.data.published).length} cached cards to ${opts.export}`,
      );
    }
    if (opts.stats)
      console.log(
        JSON.stringify(
          {
            published: Object.keys(store.data.published).length,
            versions: Object.keys(store.data.cards).length,
            sources: Object.keys(store.data.sources).length,
            questions: Object.keys(store.data.questions).length,
            jobs: Object.values(store.data.jobs).reduce(
              (acc, j) => {
                const key = `${j.status}:${j.stage}`;
                acc[key] = (acc[key] ?? 0) + 1;
                return acc;
              },
              {} as Record<string, number>,
            ),
          },
          null,
          2,
        ),
      );
  };
  const write = network || opts.rank;
  if (!write) {
    report();
    return;
  }
  await store.withWriter(async () => {
    if (opts.popularOnly || opts.buildPopularPool) {
      const directory = resolve(store.directory, 'popular-pool');
      const pool = await buildPopularPool(http, directory, opts.popularMonths, now);
      console.log(
        `Popular pool: ${pool.titles.length} unique titles across ${pool.months.length} months; ${directory}/pool.json`,
      );
      if (opts.buildPopularPool) return;
      const selected = samplePopular(
        pool.titles,
        opts.popularOnly,
        opts.regenerate
          ? []
          : [
              ...Object.values(store.data.jobs).map((job) => job.title),
              ...Object.keys(store.data.aliases),
            ],
      );
      console.log(
        `Selected ${selected.length} of ${opts.popularOnly} requested popular candidates`,
      );
      titles.push(...selected.map((title) => ({ title, discovery: 'popular' as const })));
    }
    if (opts.random)
      titles.push(
        ...(await wiki.random(opts.random)).map((title) => ({
          title,
          discovery: 'random' as const,
        })),
      );
    if (opts.popular)
      titles.push(
        ...(await wiki.popular(opts.popular)).map((title) => ({
          title,
          discovery: 'popular' as const,
        })),
      );
    for (const [index, { title, discovery }] of titles.entries()) {
      console.log(`Ingesting ${title} [${index + 1}/${titles.length}]`);
      const j = await pipeline.ingest(title, discovery, opts.regenerate);
      console.log(`${title}: ${j.status}/${j.stage}`);
    }
    if (opts.refreshPageviews) {
      for (const [key, source] of Object.entries(store.data.sources)) {
        store.data.views[key] = await wiki.pageviews(source, now);
        store.save();
      }
    }
    if (opts.rank || titles.length || opts.rebalance) {
      try {
        if (opts.rebalance) pipeline.rebalance();
        else pipeline.rank();
      } catch (e) {
        console.error(String(e));
        process.exitCode = 1;
      }
    }
    if (opts.revalidateTrivia) {
      const issues = await pipeline.revalidateBanks();
      console.log(JSON.stringify({ bankReviewPassed: issues.length === 0, issues }, null, 2));
      if (issues.length) process.exitCode = 1;
    }
    if (opts.retryFailed) await pipeline.retryFailed();
    else if (titles.length || opts.rebalance) {
      const jobs = Object.values(store.data.jobs)
        .filter(
          (j) =>
            j.status !== 'published' &&
            j.status !== 'rejected' &&
            j.assignment &&
            (!opts.popularOnly ||
              titles.some(({ title }) => store.data.aliases[title.toLowerCase()] === j.pageId)),
        )
        .slice(0, opts.batch);
      await pipeline.generateBatch(jobs);
    }
    if (Object.values(store.data.jobs).some((j) => j.status === 'failed')) process.exitCode = 1;
  });
  report();
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
