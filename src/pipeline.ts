import { hash, seededInt, validateCard, type Source, type Job } from './domain.js';
import { CatalogueStore } from './store.js';
import {
  RejectedArticle,
  meetsPageviewThreshold,
  requireEligiblePageviews,
  type WikiProvider,
} from './wikipedia.js';
import {
  makePlan,
  attackTextSchema,
  reviewBank,
  type DecisionProvider,
  type TextProvider,
} from './providers.js';
import { generateTrivia, validateBank, type TriviaOptions } from './trivia.js';
import { rankPopulation } from './rarity.js';
import type { Config } from './config.js';
import { cardContext } from './progress.js';
export class Pipeline {
  constructor(
    readonly store: CatalogueStore,
    readonly wiki: WikiProvider,
    readonly text: TextProvider,
    readonly decisions: DecisionProvider,
    readonly config: Config,
    readonly triviaOptions: TriviaOptions & {
      concurrency?: number;
      onProgress?: (message: string) => void;
    } = {},
  ) {}
  private save(job: Job) {
    job.updatedAt = new Date().toISOString();
    this.store.data.jobs[job.id] = job;
    this.store.save();
  }
  private fail(job: Job, e: unknown) {
    job.status = e instanceof RejectedArticle ? 'rejected' : 'failed';
    job.errors.push({
      stage: job.stage,
      message: e instanceof Error ? e.message : String(e),
      at: new Date().toISOString(),
    });
    this.save(job);
  }
  async ingest(
    title: string,
    discovery: Source['discovery'] = 'manual',
    regenerate = false,
  ): Promise<Job> {
    const data = this.store.data;
    const pageId = data.aliases[title.toLowerCase()];
    if (pageId && !regenerate) {
      const existing =
        Object.values(data.jobs).find((j) => j.pageId === pageId && j.status === 'published') ??
        Object.values(data.jobs).find((j) => j.pageId === pageId);
      if (existing && existing.sourceKey && data.views[existing.sourceKey]?.status === 'complete') {
        this.checkCachedEligibility(existing);
        return existing;
      }
    }
    const id = hash([
      title.toLowerCase(),
      this.config.generationVersion,
      regenerate ? hash(this.config) : 'initial',
    ]);
    let job = data.jobs[id];
    if (job?.status === 'published') return job;
    job ??= {
      id,
      title,
      discovery,
      status: 'pending',
      stage: 'source',
      attempts: 0,
      errors: [],
      conflicts: [],
      updatedAt: new Date().toISOString(),
      config: structuredClone(this.config),
      providers: { text: this.text.id, decisions: this.decisions.id },
    };
    job.attempts++;
    this.save(job);
    try {
      job.stage = 'source';
      let source: Source;
      if (job.sourceKey) source = this.store.source(job.sourceKey);
      else {
        source = await this.wiki.article(title, discovery);
        const prior = Object.values(data.jobs).find(
          (j) =>
            j.id !== id &&
            j.pageId === source.pageId &&
            (!regenerate || j.config.generationVersion === this.config.generationVersion),
        );
        if (prior && !regenerate) {
          data.aliases[title.toLowerCase()] = source.pageId;
          delete data.jobs[id];
          this.store.save();
          this.checkCachedEligibility(prior);
          return prior;
        }
        job.pageId = source.pageId;
        job.sourceKey = this.store.putSource(source, title);
        this.save(job);
      }
      job.stage = 'pageviews';
      this.save(job);
      if (data.views[job.sourceKey!]?.status !== 'complete')
        data.views[job.sourceKey!] = await this.wiki.pageviews(source);
      requireEligiblePageviews(data.views[job.sourceKey!], this.config);
      job.stage = 'rarity';
      job.status = 'pending';
      this.save(job);
    } catch (e) {
      this.fail(job, e);
    }
    return job;
  }
  private checkCachedEligibility(job: Job): boolean {
    // Existing playable versions remain immutable when the admin changes discovery filters.
    if (job.status === 'published') return true;
    try {
      requireEligiblePageviews(
        job.sourceKey ? this.store.data.views[job.sourceKey] : undefined,
        this.config,
      );
      if (job.status === 'rejected' && job.stage === 'pageviews') {
        job.status = 'pending';
        job.stage = 'rarity';
        this.save(job);
      }
      return true;
    } catch (error) {
      job.stage = 'pageviews';
      this.fail(job, error);
      return false;
    }
  }
  rank() {
    for (const job of Object.values(this.store.data.jobs)) {
      if (job.sourceKey) this.checkCachedEligibility(job);
    }
    const sources = Object.values(this.store.data.sources);
    const latest = new Map<number, Source>();
    for (const s of sources) latest.set(s.pageId, s);
    const candidates = [...latest.values()].filter(
      (s) =>
        meetsPageviewThreshold(this.store.data.views[`${s.pageId}:${s.revisionId}`], this.config) &&
        (this.config.rarity.referenceMode !== 'popular' || s.discovery === 'popular'),
    );
    const diverse =
      this.config.rarity.referenceMode === 'popular' ||
      (candidates.some((s) => s.discovery === 'random') &&
        candidates.some((s) => s.discovery === 'curated' || s.discovery === 'popular'));
    const population = rankPopulation(
      candidates.map((s) => this.store.data.views[`${s.pageId}:${s.revisionId}`]!),
      this.config,
      diverse,
    );
    this.store.data.populations[population.id] = population;
    for (const job of Object.values(this.store.data.jobs)) {
      if (job.status === 'published' || !job.pageId || !population.assignments[job.pageId])
        continue;
      const previous = job.assignment && this.store.data.populations[job.assignment.populationId];
      if (
        !job.assignment ||
        previous?.eligibility?.minPageviews90d !== this.config.ingestion.minPageviews90d ||
        (previous?.config.referenceMode ?? 'mixed') !== this.config.rarity.referenceMode
      ) {
        job.assignment = population.assignments[job.pageId];
        // A new eligible population can change rarity and therefore the required attack slots.
        job.draft = undefined;
      }
    }
    this.store.save();
    return population;
  }
  async generate(job: Job) {
    if (job.status === 'published') return;
    job.attempts++;
    try {
      if (!job.sourceKey) throw Error('Source ingestion must succeed first');
      const source = this.store.source(job.sourceKey);
      const cfg = job.config;
      job.stage = 'pageviews';
      requireEligiblePageviews(this.store.data.views[job.sourceKey], this.config);
      job.stage = 'rarity';
      if (!job.assignment)
        throw Error(
          'Build a sufficiently diverse rarity reference population before generating cards',
        );
      const reference = this.store.data.populations[job.assignment.populationId];
      if (
        !reference ||
        reference.eligibility?.minPageviews90d !== this.config.ingestion.minPageviews90d ||
        reference.members.some((views) => !meetsPageviewThreshold(views, this.config))
      ) {
        throw Error('Popularity eligibility changed; run --rank before resuming generation');
      }
      if (!job.draft) {
        job.stage = 'metadata';
        job.providers.metadata = this.text.id;
        job.providers.decisions = this.decisions.id;
        this.save(job);
        const plan = await makePlan(source, job.assignment.rarity, this.decisions, cfg);
        const generated = await this.text.json(
          'Name and describe exactly the supplied attacks in order using distinctive concepts in the source article. These are fictional thematic interpretations. Do not change mechanics or introduce new effects. Include thematicSupport explaining each association; if an effect cannot plausibly fit, do not fabricate it (return an empty attacks array, which rejects this stage).',
          {
            title: source.title,
            summary: source.summary,
            source: source.text.slice(0, cfg.model.maxSourceChars),
            plan,
          },
          attackTextSchema,
        );
        if (generated.attacks.length !== plan.attacks.length)
          throw Error('Attack count mismatch or no thematic assignment');
        const seed = [source.pageId, cfg.generationVersion, hash(cfg)];
        const versionId = `enwiki:${source.pageId}@${hash([source.revisionId, seed, job.assignment])}`;
        job.draft = {
          id: `enwiki:${source.pageId}`,
          versionId,
          pageId: source.pageId,
          sourceKey: job.sourceKey,
          name: source.title,
          type: plan.type,
          rarity: job.assignment.rarity,
          hp: seededInt([...seed, 'hp'], cfg.hp),
          defense: seededInt([...seed, 'defense'], cfg.defense),
          attacks: plan.attacks.map((a, i) => ({
            id: `${versionId}:a:${i}`,
            name: generated.attacks[i]!.name,
            description: generated.attacks[i]!.description,
            type: a.type,
            effectId: a.effectId,
            effectParameters: a.effectId ? cfg.effects[a.effectId] : null,
            power: seededInt(
              [...seed, a.effectId ? 'specialPower' : 'standardPower'],
              a.effectId ? cfg.specialPower : cfg.standardPower,
            ),
          })),
          passive: plan.passive ? { id: plan.passive } : null,
          rarityAssignment: job.assignment,
          generationVersion: cfg.generationVersion,
          balanceVersion: cfg.version,
          createdAt: new Date().toISOString(),
        };
        this.save(job);
      }
      job.stage = 'trivia';
      job.providers.trivia = this.text.id;
      this.save(job);
      // A new card version can reuse a verified bank from the same immutable revision.
      // This avoids resampling the same stem with different answer options on a rebalance.
      const previous = Object.values(this.store.data.cards).find(
        (card) => card.sourceKey === job.sourceKey && !this.store.data.quarantined[card.versionId],
      );
      if (!job.questions && previous) {
        job.questions = previous.questionIds.map((id) => this.store.data.questions[id]!);
      }
      const questions = await generateTrivia(
        source,
        this.text,
        cfg,
        job.questions ?? [],
        (progress) => {
          job.questions = progress.questions;
          job.conflicts.push(
            ...progress.conflicts.filter(
              (c) => !job.conflicts.some((old) => JSON.stringify(old) === JSON.stringify(c)),
            ),
          );
          job.bankReviewed = progress.reviewed;
          job.leakageReviewSkipped = !!this.triviaOptions.skipLeakageReview;
          for (const message of progress.errors)
            if (!job.errors.some((e) => e.message === message))
              job.errors.push({ stage: 'trivia', message, at: new Date().toISOString() });
          this.save(job);
        },
        this.triviaOptions,
      );
      job.stage = 'publish';
      validateBank(questions, source, cfg);
      if (!job.bankReviewed && !this.triviaOptions.skipLeakageReview)
        throw Error('Final bank review required');
      const card = validateCard(
        { ...job.draft, status: 'published', questionIds: questions.map((q) => q.id) },
        cfg,
      );
      // Immutable versions are never overwritten. Questions are globally unique, across revisions too.
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i]!,
          prior = this.store.data.questions[q.id];
        if (prior) {
          if (JSON.stringify({ ...prior, quality: 0 }) !== JSON.stringify({ ...q, quality: 0 }))
            throw Error(
              'Question ID already has different immutable content; retry with a different stem',
            );
          questions[i] = prior;
        }
      }
      if (this.store.data.cards[card.versionId])
        throw Error('Version already exists; bump generationVersion for explicit regeneration');
      for (const q of questions) this.store.putQuestion(q);
      this.store.data.cards[card.versionId] = card;
      this.store.data.published[card.id] = card.versionId;
      this.store.data.configs[card.versionId] = cfg;
      job.status = 'published';
      job.publishedVersion = card.versionId;
      this.save(job);
    } catch (e) {
      this.fail(job, e);
    }
  }
  async generateBatch(jobs: Job[]) {
    const concurrency = this.triviaOptions.concurrency ?? 1;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
      throw Error('Concurrency must be an integer from 1 to 16');
    let next = 0,
      published = 0,
      processed = 0;
    const worker = async () => {
      while (next < jobs.length) {
        // Claim synchronously before yielding; each worker owns a distinct job.
        const index = next++;
        const job = jobs[index]!;
        this.triviaOptions.onProgress?.(`Working on ${job.title} [${index + 1}/${jobs.length}]`);
        await cardContext.run(job.title, () => this.generate(job));
        if (job.status === 'published') published++;
        processed++;
        this.triviaOptions.onProgress?.(
          `${job.title}: ${job.status}/${job.stage} — ${published}/${jobs.length} cards published; ${processed}/${jobs.length} processed`,
        );
      }
    };
    // Even an unexpected save/logging failure must not release the catalogue lock
    // while another worker is still using the shared in-memory store.
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  async retryFailed(options: { skipFailedPageviews?: boolean } = {}) {
    const jobs = Object.values(this.store.data.jobs).filter(
      (j) =>
        (j.status === 'failed' || j.status === 'pending') &&
        !j.publishedVersion &&
        !(options.skipFailedPageviews && j.status === 'failed' && j.stage === 'pageviews'),
    );
    for (const job of jobs) {
      if (!job.sourceKey || this.store.data.views[job.sourceKey]?.status !== 'complete') {
        await this.ingest(job.title, job.discovery ?? 'manual');
      }
    }
    const ready = jobs.filter(
      (job) => job.sourceKey && this.store.data.views[job.sourceKey]?.status === 'complete',
    );
    if (
      ready.some(
        (job) =>
          !job.assignment ||
          this.store.data.populations[job.assignment.populationId]?.eligibility?.minPageviews90d !==
            this.config.ingestion.minPageviews90d,
      )
    ) {
      try {
        this.rank();
      } catch (error) {
        for (const job of ready.filter((job) => !job.assignment)) {
          job.stage = 'rarity';
          this.fail(job, error);
        }
      }
    }
    await this.generateBatch(ready.filter((job) => job.assignment));
  }
  validateAll() {
    const errors: string[] = [];
    for (const c of Object.values(this.store.data.cards)) {
      try {
        if (this.store.data.quarantined[c.versionId])
          throw Error(`Quarantined: ${this.store.data.quarantined[c.versionId]}`);
        const config = this.store.data.configs[c.versionId];
        if (!config) throw Error('Missing version configuration');
        validateCard(c, config);
        validateBank(
          c.questionIds.map((id) => this.store.data.questions[id]!),
          this.store.source(c.sourceKey),
          config,
        );
      } catch (e) {
        errors.push(`${c.versionId}: ${String(e)}`);
      }
    }
    return errors;
  }
  async revalidateBanks() {
    const issues: string[] = [];
    for (const c of Object.values(this.store.data.cards).filter((c) => c.status === 'published')) {
      const job = Object.values(this.store.data.jobs).find(
        (j) => j.publishedVersion === c.versionId,
      );
      if (!job) throw Error('Missing generation metadata');
      try {
        const conflicts = await reviewBank(
          this.text,
          this.store.source(c.sourceKey),
          c.questionIds.map((id) => this.store.data.questions[id]!),
        );
        job.conflicts.push(...conflicts);
        if (conflicts.length) {
          issues.push(`${c.versionId}: ${conflicts.length} question-bank conflicts`);
          job.bankReviewed = false;
          job.status = 'failed';
          job.stage = 'trivia';
          this.store.data.quarantined[c.versionId] = 'Question-bank leakage detected';
          job.questions = job.questions?.filter(
            (q) => !conflicts.some((conflict) => conflict.removeId === q.id),
          );
          if (this.store.data.published[c.id] === c.versionId)
            delete this.store.data.published[c.id];
        }
      } catch (e) {
        issues.push(`${c.versionId}: review incomplete: ${String(e)}`);
        job.errors.push({
          stage: 'trivia',
          message: `Revalidation incomplete: ${String(e)}`,
          at: new Date().toISOString(),
        });
      }
      this.save(job);
    }
    return issues;
  }
  rebalance() {
    const population = this.rank();
    for (const old of Object.values(this.store.data.published).map(
      (id) => this.store.data.cards[id]!,
    )) {
      const assignment = population.assignments[old.pageId];
      if (!assignment || assignment.rarity === old.rarity) continue;
      const id = hash(['rebalance', old.versionId, population.id, this.config]);
      this.store.data.jobs[id] ??= {
        id,
        title: old.name,
        discovery: this.store.source(old.sourceKey).discovery,
        pageId: old.pageId,
        sourceKey: old.sourceKey,
        status: 'pending',
        stage: 'metadata',
        attempts: 0,
        errors: [],
        conflicts: [],
        updatedAt: new Date().toISOString(),
        config: structuredClone(this.config),
        providers: { text: this.text.id, decisions: this.decisions.id },
        assignment,
      };
    }
    this.store.save();
    return population;
  }
}
