# Trivattle card catalogue

Offline Wikipedia ingestion, card generation and validated trivia for a future trading-card game. TypeScript / Node 22+; a normalized JSON catalogue supplies fast, credential-free runtime reads. There is no pack opener, inventory, trading service, web server or multiplayer battle loop.

## Quick start

```sh
npm ci
cp .env.example .env
# Edit .env: a real Wikimedia contact and your DeepSeek key.
npm run check
npm test
npm run build

# Inspect the plan without network calls or writes.
npm run cards -- --titles-file data/seed-titles.txt --random 40 --batch 40 --dry-run

# Ingest a diverse reference population, rank it, then generate up to 40 cards.
npm run cards -- --titles-file data/seed-titles.txt --random 40 --batch 40
npm run cards -- --stats
npm run cards -- --retry-failed
npm run cards -- --validate --export data/cards-public.json
```

The initial target is 30–50 **playable** cards. Not all candidates will pass: begin with the 50 curated seeds plus 40 or more random candidates, and add candidates if needed. A title alone can publish once a diverse reference population exists. No real cards are bundled or claimed to be generated: the committed fixtures are explicitly synthetic, non-playable development data. Real generation requires working credentials and provider access.

## Configuration

| Variable                   | Purpose                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `WIKIMEDIA_USER_AGENT`     | Required for online CLI operations; e.g. `Trivattle/0.1 (mailto:you@your-domain.org)`. Supply a real contact. |
| `DEEPSEEK_API_KEY`         | Server/admin-only generative and review credential.                                                           |
| `DEEPSEEK_MODEL`           | Defaults to `deepseek-flash` (DeepSeek-V4.1-Flash).                                                           |
| `DEEPSEEK_BASE_URL`        | Defaults to `https://api.deepseek.com`; compatible providers can be substituted.                              |
| `JEV_API_KEY`              | Optional; enables TypeSafe structured decisions.                                                              |
| `JEV_MODEL`                | Defaults to `jev-latest`.                                                                                     |
| `CARD_CATALOGUE`           | Defaults to `data/catalogue`.                                                                                 |
| `CARD_CONFIG` / `--config` | Override `config/gameplay.json`.                                                                              |
| `TYPE_CONFIG`              | Override `config/effectiveness.json`.                                                                         |

No credentials belong in browser bundles, exported catalogues or git. `.env` is ignored. Cached reads, validation, statistics and export work without any API credentials.

`config/gameplay.json` controls stat ranges, effect magnitudes and durations, passive thresholds, trivia target/retry limits, word/prose thresholds, HTTP retry policy and model generation settings. It is validated at startup. Trivia bounds remain within the required 10–15 questions; the exact rarity progression and five effect/three passive IDs are schema invariants. The separate effectiveness file controls matchups without regenerating cards. Basic is always neutral in both directions.

## Generation commands

```sh
npm run cards -- --title "Albert Einstein"
npm run cards -- --random 50 --popular 30 --batch 40
npm run cards -- --titles-file data/seed-titles.txt --random 50
npm run cards -- --retry-failed
npm run cards -- --rank
npm run cards -- --validate
npm run cards -- --revalidate-trivia
npm run cards -- --stats
npm run cards -- --export data/cards-public.json
npm run cards -- --export data/cards-server.json --include-answers

# Refresh measurement windows together, then make an explicit new reference population.
npm run cards -- --refresh-pageviews --rank
# Use an earlier shared anchor if different articles have delayed analytics data.
npm run cards -- --refresh-pageviews --as-of 2026-10-01 --rank

# Stage and generate new card versions when measured rarity tiers change.
npm run cards -- --rebalance --batch 40

# For source/config changes, bump generationVersion in your configuration first.
npm run cards -- --title "Albert Einstein" --regenerate
```

`--batch` caps generation after ingestion; incomplete jobs remain resumable. `--retry-failed` processes pending/failed generation jobs, excluding quarantined published versions which require explicit regeneration. Rejected source articles keep their rejection reason; explicit regeneration with a new generator version retries changed source/filter rules. `--dry-run` performs no writes or network activity. Flags can be combined; validation/export/statistics run after generation. The process exits nonzero when jobs fail or validation fails, while preserving successful stages. No scheduled/live generation is installed.

Rebalancing only creates new versions for cards whose rarity tier changes. Published popularity scores retain their original immutable reference population; use explicit versioned regeneration to republish metadata without a tier change. A staged replacement does not displace the previous playable version until publication succeeds.

## Ingestion and popularity

The Action API resolves aliases and redirects to a stable page ID, checks namespace/disambiguation metadata, reads categories and requests free representative images. The REST `with_html` response supplies the source revision and content. The parser removes navigation, infoboxes, references, lists, tables, figures and unrelated templates before counting actual Unicode words in prose paragraphs. Defaults require 500 words, five meaningful paragraphs and 35% prose. A second factual-quality gate occurs during trivia generation. Articles with no suitable image have `image: null`, allowing the frontend to render its own placeholder.

Each source retains its canonical URL, revision, Wikidata ID, clean prose, summary, timestamp, categories, image URL and per-file license/attribution when available. Unknown image licensing fields stay null. Display attribution using plain text, and check the linked file page before distributing an image with unknown metadata. Attribute Wikipedia text to its article/revision and CC BY-SA 4.0; retain the source and license links in downstream uses. Image licenses vary and are stored separately.

The analytics client requests `all-access/user` daily data for the last **90 complete UTC days**, trying up to three earlier windows for delayed data. All 90 distinct dated values must be present; zero is valid, a gap is missing data. Incomplete analytics block ranking/publication rather than becoming zero. Measurement windows are cached until an explicit refresh. Ranking requires all included candidates to share a window.

The default mixed reference pool requires at least 30 eligible measured page IDs, with random discovery plus curated or popular discovery. This is a minimum safeguard, not a statistical guarantee of a representative sample. The committed seed list spans all six specific subject types. Popular discovery uses Wikimedia's daily top-article endpoint. Rarity uses raw total pageviews, descending rank and the configured 5/10/20/30/35% tiers. Ties share the midpoint rank, so proportions are approximate and equal views never receive different tiers. Population records retain every measurement and the exact ranking configuration. Article length never raises rarity.

Requests run sequentially with an informative User-Agent, spacing, request timeouts, bounded exponential backoff, `Retry-After`, and MediaWiki `maxlag` handling. Fetching/reviewing large catalogues can take time; pack and battle services never run this workflow.

### Sample only popular articles

```sh
# Build and save a reusable title pool first (24 monthly pageview requests initially;
# no article downloads or model calls):
npm run cards -- --build-popular-pool

# Randomly select 100 unattempted titles from that pool and generate up to 40 cards:
npm run cards -- --popular-only 100 --batch 40

# Use the last three completed calendar months instead:
npm run cards -- --popular-only 100 --popular-months 3 --batch 40
```

`--popular-only` combines the top 1,000 pages from each of the last 24 completed calendar months by default (`--popular-months 1–24`). This is a **deduplicated union**, potentially larger than 1,000 titles, not an exact top-1,000 ranking across 90 days or two years. Wikimedia supplies daily and monthly top lists, not a direct rolling 90-day top list. Three calendar months approximate that shorter discovery window. `--as-of YYYY-MM-DD` can anchor the discovery history to an earlier date.

Monthly responses and the readable title list are stored in `<catalogue>/popular-pool/`, with titles and period metadata in `pool.json`. Completed months are reused across runs; missing data fails explicitly and already fetched months stay cached for retry. Main Page, namespaced pages and obvious list/index/outline titles are removed before sampling. Each title has an equal chance of selection regardless of how many months it appeared. Previously attempted titles and known aliases are skipped, including rejected titles; use `--retry-failed` for failures or `--regenerate` to permit resampling. Exhaustion reports fewer selected candidates and never falls back to unrestricted random pages.

Popular-only discovery cannot be combined with `--random`, `--popular`, `--title`, or `--titles-file`. It explicitly permits a popularity-biased rarity reference population without random-article seeds, using only sources discovered as popular. The minimum population size, prose checks and complete recent 90-day pageview cutoff still apply. Rarity is relative to this eligible popular sample; historical popularity does not guarantee current eligibility. Existing published cards remain stable. For later standalone ranking/rebalancing of this pool, set `rarity.referenceMode` to `"popular"` in your configuration (`"mixed"` is the default). `--build-popular-pool` exits before ingestion, ranking or generation; `--dry-run` performs no network calls or writes.

### Minimum popularity filter

New candidates must have **at least 50,000 pageviews over the measured 90 complete UTC days** (about 556/day), in addition to the 500-word rule. This is a practical starting cutoff for excluding obscure articles, **not a measured equivalent of the top 50,000 articles**. All measurements remain English Wikipedia, `all-access/user` traffic.

Set `ingestion.minPageviews90d` in `config/gameplay.json`, or override it for one run:

```sh
npm run cards -- --titles-file data/seed-titles.txt --random 200 --min-pageviews90d 50000
npm run cards -- --rank --min-pageviews90d 100000
# Disable the popularity cutoff, retaining all other eligibility checks:
npm run cards -- --rank --min-pageviews90d 0
```

The cutoff is inclusive: exactly 50,000 passes. Lower totals are saved as rejected at the `pageviews` stage with the total, period and threshold; no AI generation occurs. Missing/incomplete analytics remain retryable failures. Cached measurements are checked too, including at ranking and before resuming generation, so an old pending job cannot bypass a raised cutoff. Rarity populations record the cutoff used; changed eligibility requires reranking unpublished assignments. Existing published card versions remain unchanged, but below-threshold pages are excluded from new reference pools. Run `--rank` to apply a changed cutoff to cached candidates; after lowering it, formerly low-traffic candidates can become pending again and `--retry-failed` can generate them. `--refresh-pageviews --rank` updates measurements and applies the filter together. Repeating `--title` also rechecks a cached candidate without refetching a complete measurement.

With this filter, most uniformly random articles may be rejected; use `--popular-only` to sample the historical popular pool instead. The minimum eligible reference-population size still applies **after** popularity filtering. `--dry-run` reports the active threshold without fetching counts.

An exact top-50,000 rule needs a complete 90-day ranking of English article traffic, then an allowlist or the view count at rank 50,000 (with a tie policy). [Wikimedia's top-pages endpoint supplies only the top 1,000 per day or month](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/examples/project-metrics.html); combining those lists does not recover the true 90-day top 50,000. The current script therefore implements the numeric cutoff, not a global rank guarantee. No rank-50,000 cutoff has been empirically measured here. A separately prepared ranked title list can be used with `--titles-file` (omit `--random` and `--popular` to keep discovery to that list), but arbitrary curated lists still use the mixed reference-population gate; use `--popular-only` for the explicit popular reference mode.

## Models, grounding and publication gates

`TextProvider` and `DecisionProvider` in `src/providers.ts` are replaceable interfaces. DeepSeek uses JSON output and local Zod parsing with bounded repair attempts. Its roles are attack names/flavor, article-specific question generation, answer accuracy review and full-bank leakage review. The TypeSafe adapter uses documented `/v1/systemone` Choice questions with `state`, named `questions`, `criteria` and a model. Jev selects primary/attack types, allowed effects, passives and Rare A/B. Missing Jev credentials select a deterministic keyword classifier and thematic decision table; configured Jev failures stop the stage for retry rather than silently changing providers.

DeepSeek cannot change powers, effect definitions, stats or rarity rules. Stats are seeded by page ID, generator version and the configuration hash. Standard attacks share one sampled power per card, and special attacks share a lower sampled power, preventing extra move slots from granting extra rolls for a higher raw damage number. Rarity is absent from the stat seed. Selected decisions and exact stats are cached. Attack/passive options obey:

| Rarity    | Attacks | Effects | Passive |
| --------- | ------: | ------: | ------- |
| Common    |       1 |       0 | None    |
| Uncommon  |       2 |       0 | None    |
| Rare A    |       2 |       1 | One     |
| Rare B    |       2 |       2 | None    |
| Epic      |       2 |       2 | One     |
| Legendary |       3 |       2 | One     |

Trivia generation oversamples candidates and retains quality-ranked independent facts:

1. Strict schema: four distinct options, one in-range answer index, no difficulty field.
2. The quoted evidence must occur in the stored clean revision, and the literal correct answer must appear in that evidence. This conservative rule intentionally rejects some valid paraphrases.
3. DeepSeek audits every candidate for factual support, one correct choice, incorrect distractors, notable facts and explicit historical framing where necessary. Missing/duplicate review IDs fail the stage.
4. Deterministic checks reject duplicate IDs, fact keys, identical evidence passages and highly similar stems.
5. A separate DeepSeek review receives the full retained bank, options, answers and explanations. It checks indirect giveaways, synonyms, paraphrases and repeated factual relationships, ignoring the shared article name. Conflicts identify both IDs, the weaker question and a reason.
6. Remove conflicting questions, generate replacements from other facts, recheck grounding/accuracy, and review the final bank again within the retry budget. Every retry checkpoint retains questions and review diagnostics.
7. Publish at the 12-question target, or accept 10–11 after the retry budget only when the final bank review passes. Fewer than 10, unresolved conflicts, or missing API credentials never produce a playable card.

Exact source matching verifies evidence provenance, **not logical entailment or uniquely wrong distractors**. LLM accuracy and leakage reviews remain fallible. The pipeline fails conservatively on detected/uncertain problems but does not claim a mathematical guarantee of factual truth or no semantic leakage. Use admin inspection for important releases. `--revalidate-trivia` audits saved banks; newly detected conflicts quarantine a version from runtime reads without deleting it. Bump the generator version and explicitly regenerate a quarantined card to repair it. A review API failure records an incomplete audit and does not alter an existing publication.

## Persistent schema and versioning

`data/catalogue/catalogue.json` is the MVP database, rather than a new server dependency:

| Map           | Unique key / contents                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `sources`     | `pageId:revisionId`: one immutable clean source snapshot                                                       |
| `aliases`     | normalized title → stable page ID                                                                              |
| `views`       | source key → cached complete or missing pageview measurement                                                   |
| `populations` | content hash → ranking configuration, complete measurement set, assignments                                    |
| `jobs`        | job ID → stage, status, attempts, error history, providers, config snapshot, draft, retained trivia, conflicts |
| `cards`       | immutable version ID → card stats, type, rarity, attack/passive data, source and question references           |
| `published`   | stable `enwiki:pageId` → current playable version                                                              |
| `questions`   | unique stable question ID → answer, explanation, revision evidence and validation data                         |
| `configs`     | version ID → generation/balance configuration used for validation                                              |
| `quarantined` | version ID → publication-blocking review reason                                                                |

Question IDs hash the page's revision and normalized stem. Identical stems within a revision cannot silently overwrite different options or explanations; such collisions stop publication. Runtime usage also tracks a page/stem fingerprint across revisions. Matches should pin card `versionId`s and one source version per page at match creation; cross-version paraphrase equivalence is not solved by hashing. Stable card IDs serve future collections/trades; version IDs serve immutable matches.

A writer holds an exclusive heartbeat file lock. Each checkpoint fsyncs a temporary file and atomically renames it; readers see complete snapshots. Interrupted jobs reuse saved source, pageviews and card drafts, resuming trivia separately. Never edit a live catalogue by hand. Multiple generator processes for the same directory are rejected. This single-writer JSON design is intended for a hackathon and modest catalogues; the maps and repository boundary can migrate to SQLite/Postgres when full-file writes become expensive. File permissions protect server-side answer data. Runtime instances read a snapshot; call `store.refresh()` between requests if another process has published new versions, and hold pinned snapshots for active matches.

## Runtime integration

```ts
import { CachedCatalogue, CatalogueStore, loadConfig } from './src/index.js';

const store = new CatalogueStore('data/catalogue', true); // read-only
const catalogue = new CachedCatalogue(store, loadConfig());
const card = catalogue.getCard('enwiki:736'); // undefined if not cached/published
const rares = catalogue.getCardsByRarity('rare');
const cards = catalogue.getCards({ type: 'science' });
const random = catalogue.getRandomCachedCard('common');

// Server-owned match state shared by BOTH players, not a card-instance property.
const usedQuestionIds = new Set<string>();
if (card) {
  const selected = catalogue.getUnusedQuestion(card.versionId, usedQuestionIds);
  if (selected.kind === 'question') {
    // Send only selected.question: id, pageId, text, options.
    // Persist its ID as the pending question; validate player and turn first.
    const result = catalogue.evaluateAnswer(card.versionId, selected.question.id, 2);
    // Return correctness/explanation only AFTER a single authorized submission.
  } else {
    // Apply selected.triviaMultiplier (default 0.5) and no special effects.
  }
}
```

Additional interfaces: `getCardQuestions(cardId)` returns answer-free views; `getCardGenerationMetadata(cardId)` is **admin-only**, because it includes retained trivia and diagnostics. All runtime methods use cached data only. Public export excludes trivia entirely; `--include-answers` is a server-only export and must never be served as a frontend asset. Future endpoints must enforce authentication, pending-question binding, match ownership and one submission per turn; the library does not provide an unauthenticated grading endpoint. Do not send the database or server-only evaluator to the browser.

`getUnusedQuestion` consumes the question immediately, preventing it being offered twice if a turn is abandoned. It uses the attacking card's bank, a shared set keyed by page/question ID, plus a cross-revision exact-stem fingerprint. Clear the set only for a new match. Exhaustion yields the configurable correct-answer fallback and disables effects by default.

## Deterministic mechanics contract

`src/mechanics.ts` supplies isolated helpers for integration tests and a future battle engine, not match orchestration. `freshCombatant` initializes match-local status; never store mutable combat state in the catalogue.

1. Resolve attack type against the defender's one type. Basic is neutral. Immune changes multipliers above 1 to 1 and leaves resistance unchanged.
2. Apply flat defense, except Pierce ignores it **only on an incorrect answer** (or if explicitly enabled for exhaustion).
3. Multiply `(power × typeMultiplier − defense)` by trivia multiplier, consumed Weaken multiplier and Stalwart multiplier, in that order. Round once with `ceil`, with minimum 1 damage.
4. Record the resolved damage **before remaining-HP clamping**; subtract it from the primary target, then check Recovery.
5. Only an incorrect answer activates an attack effect by default: Heal restores 10 up to max HP; Burn refreshes a non-stacking two-own-turn counter; Weaken sets a non-stacking flag consumed on the affected card's next attack (correct, incorrect or exhausted); Pierce already acted above.
6. Splash uses `floor(resolved primary damage × fraction)`, minimum 1 for a positive primary hit. Hit only surviving immediate neighbor positions inside 0–4. No additional type/defense/Stalwart reduction and no attack/status effects or recursive splash. Recovery can react to HP crossing its threshold because it is a defensive passive, not a new attack.
7. At the end of each affected card's owner's turn, the future engine calls `endOwnTurn` for **every surviving card on that team**, including ones that did not attack. Burn ticks for 5, decrements, and may trigger Recovery. Burn bypasses flat defense, Stalwart and Immune. Reapplication refreshes duration; damage does not stack.
8. Recovery restores 5 once, strictly below 40% max HP, only while still alive; it never revives a defeated card. No passive/effect/status persists into another match. A fresh match resets all usage flags and counters.

The caller manages turns, targets and victory rules. Effects are fixed IDs with typed configuration; no model-supplied code executes. Matches should snapshot the balance/effectiveness configuration used for resolution.

## Generation speed and diagnostics

DeepSeek requests explicitly disable thinking by default on `api.deepseek.com`. The current DeepSeek Flash API otherwise enables high-effort thinking by default, which can add substantial latency to every generation and audit call. Set `DEEPSEEK_THINKING=enabled` to opt back in, or `auto` to use the provider's default. Custom compatible API base URLs default to `auto` so they are not sent DeepSeek-specific fields unless explicitly configured. These settings apply on the next CLI run, including resumed jobs.

Accuracy and full-bank leakage reviews now run concurrently after candidate generation. The leakage review covers retained questions plus all grounded candidates before pruning; publication still requires both audits, complete accuracy-review coverage, deterministic grounding and a clean bank review. Removing rejected or excess candidates cannot introduce new leakage. Player-invisible evidence and source metadata are omitted from the leakage prompt. Question targets, retry budgets and quality checks are unchanged.

```sh
npm run cards -- --popular-only 100 --batch 40 --verbose
# Resume existing jobs with timing output:
npm run cards -- --retry-failed --verbose
```

To generate up to four cards concurrently, including retries:

```sh
npm run cards -- --retry-failed --concurrency 4 --skip-leakage-review --verbose
```

For a hackathon demo, add `--skip-leakage-review` to skip AI cross-question leakage review, including for previously saved jobs:

```sh
npm run cards -- --retry-failed --skip-leakage-review --verbose
npm run cards -- --popular-only 100 --batch 40 --skip-leakage-review --verbose
```

Accuracy review, evidence matching, schema validation, duplicate detection and question-count requirements still apply. The flag applies only to the current run; jobs record `leakageReviewSkipped: true` and do not claim a completed bank review. Omit it to restore normal review for subsequent generation. Existing published cards are unchanged; `--revalidate-trivia` can review them later and cannot be combined with the skip flag.

Generation and retry runs print `Working on <article> [1/40]` before each card, then its result and separate published/processed counts. The denominator is the number of jobs being attempted, so failures do not count as cards made.

`--verbose` reports AI request stages, thinking mode, elapsed seconds, output-token counts and schema retries without logging credentials or article content. A thinking-mode change can affect model judgments; audits remain mandatory, but no fixed latency or identical model quality is guaranteed. Card generation supports `--concurrency 1–16` (default 1), including `--retry-failed`. Use `--concurrency 4` to work on four cards at once. AI logs include article names, and published/processed counts track actual completions even when cards finish out of order. Ingestion and ranking stay sequential; one process retains the catalogue writer lock and saves synchronously. With leakage review enabled, each card can have two overlapping audit calls. Existing HTTP spacing and retries still apply. See [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/) for the API controls.

## Tests, fixtures and balance

```sh
npm test
npm run fixtures
npm run simulate -- --write
# Optional simulation overrides:
SIM_GAMES=5000 SIM_CORRECT_PROBABILITY=0.7 SIM_SEED=probe-2 npm run simulate
```

Tests mock Wikimedia, DeepSeek and Jev responses and require no network or secrets. They cover parsing/filtering, redirects and page identity, pageviews and missing data, population ranking/stability, rarity rules, types and stat bounds, grounded trivia/duplicates/leakage, persistent cache reuse, interrupted generation, explicit regeneration, quarantine, lock contention, safe runtime views, non-repeating selection/exhaustion, HTTP retry behavior and effect mechanics.

`data/fixtures/cards.json` contains five synthetic examples covering every rarity, each labeled `fixture` and excluded from runtime publication. Its IDs/URLs and supporting prose are invented test data, not Wikipedia claims. It is for UI shape and local mechanics development, not real gameplay. `npm run fixtures` regenerates it deterministically.

`data/balance-report.json` records 2,000 seeded duels per rarity against Common, with 60% correct-answer probability and alternating first move. Current win rates: Common 48.9%, Uncommon 48.9%, Rare 44.15%, Epic 47.6%, Legendary 56.15% (some simultaneous Burn knockouts draw). Legendary has a modest residual advantage from standard-plus-special options and a passive; Rare is weaker in this probe. These are not full-game fairness guarantees: the probe uses greedy move choice and no adjacent splash victims, trivia exhaustion or player knowledge differences. Five-card tests may raise the value of splash and alternative attack types. Tune config before a competitive release; preserve published versions when experimenting.

## API references

- [MediaWiki REST API](https://www.mediawiki.org/wiki/API:REST_API/Reference)
- [Action API page images](https://www.mediawiki.org/wiki/Extension:PageImages#API)
- [Wikimedia pageview analytics](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/reference/page-views.html)
- [Wikimedia API usage guidelines](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_API_Usage_Guidelines) and [User-Agent policy](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy)
- [DeepSeek JSON output](https://api-docs.deepseek.com/guides/json_mode/)
- [TypeSafe interactive documentation](https://api.typesafe.ai/docs) and [OpenAPI schema](https://api.typesafe.ai/openapi.json)
