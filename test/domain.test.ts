import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCard, types, wordCount, questionSchema } from '../src/domain.js';
import { cleanArticle, filterArticle } from '../src/wikipedia.js';
import { rankPopulation } from '../src/rarity.js';
import { classify, makePlan, RulesDecisions } from '../src/providers.js';
import { card, cfg, source, views, questions } from './helpers.js';
test('count meaningful prose; exclude citations, tables, navigation and references', () => {
  const html =
    '<nav>navigation noise</nav><p>This is meaningful prose about a historical scientific subject.<sup>[1]</sup></p><table><tr><td>table words</td></tr></table><section><h2>References</h2><p>These irrelevant bibliography notes must not count toward this article.</p></section>';
  const clean = cleanArticle(html);
  assert.equal(clean.wordCount, 9);
  assert.equal(wordCount('well-known 1930s café & < >'), 3);
  assert(!clean.text.includes('bibliography'));
  assert(!clean.text.includes('table'));
});
test('filters insufficient, disambiguation, non-articles, lists and table-dominated content', () => {
  const c = cfg(),
    ok = { text: '', wordCount: 500, paragraphs: 5, proseFraction: 0.9 };
  assert.deepEqual(filterArticle({ ns: 0, title: 'Earth' }, ok, c), []);
  for (const meta of [
    { ns: 1, title: 'Earth' },
    { ns: 0, title: 'List of planets' },
    { ns: 0, title: 'Mercury', pageprops: { disambiguation: '' } },
  ])
    assert(filterArticle(meta, ok, c).length);
  assert(filterArticle({ ns: 0, title: 'X' }, { ...ok, wordCount: 499 }, c).length);
  assert(filterArticle({ ns: 0, title: 'X' }, { ...ok, proseFraction: 0.1 }, c).length);
});
test('rarity is view-ranked with exact tiers, deterministic ties, missing separate from zero', () => {
  const c = cfg();
  const pool = Array.from({ length: 100 }, (_, i) => views(source(i + 1), 100 - i));
  const p = rankPopulation(pool, c, true);
  assert.deepEqual(
    Object.values(p.assignments).reduce(
      (a, v) => ((a[v.rarity] = (a[v.rarity] ?? 0) + 1), a),
      {} as Record<string, number>,
    ),
    { legendary: 5, epic: 10, rare: 20, uncommon: 30, common: 35 },
  );
  assert.equal(rankPopulation([...pool].reverse(), c, true).id, p.id);
  assert.throws(() => rankPopulation(pool, c, false));
  assert.throws(() => rankPopulation(pool.slice(0, 2), c, true));
  const tied = pool.map((v) => ({ ...v, total: 0, average: 0 }));
  assert.equal(
    new Set(Object.values(rankPopulation(tied, c, true).assignments).map((a) => a.rarity)).size,
    1,
  );
  assert.throws(() =>
    rankPopulation(
      pool.map((v) => ({ ...v, status: 'missing', total: null, average: null })),
      c,
      true,
    ),
  );
});
test('exact rarity combinations, bounded stats, valid types and fixed effects', () => {
  for (const rarity of ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const) {
    const c = card(rarity);
    validateCard(c, cfg());
    const invalid = structuredClone(c);
    invalid.attacks.push({ ...invalid.attacks[0]!, id: 'extra' });
    assert.throws(() => validateCard(invalid, cfg()));
    for (const type of types) validateCard({ ...c, type }, cfg());
    assert.throws(() => validateCard({ ...c, hp: 1000 }, cfg()));
    assert.throws(() => validateCard({ ...c, type: 'magic' }, cfg()));
    assert.throws(() => validateCard({ ...c, passive: { id: 'shield' } }, cfg()));
  }
  validateCard(card('rare', 100, 'B'), cfg());
  assert.throws(() =>
    validateCard({ ...card('epic'), type: 'basic', passive: { id: 'immune' } }, cfg()),
  );
  const c = card('epic');
  c.attacks[0]!.effectParameters = { amount: 999 };
  assert.throws(() => validateCard(c, cfg()));
});
test('question schema forbids invalid options, index and difficulty', () => {
  const q = questions()[0]!;
  questionSchema.parse(q);
  assert.throws(() => questionSchema.parse({ ...q, correctIndex: 4 }));
  assert.throws(() => questionSchema.parse({ ...q, options: ['one', 'two'] }));
  assert.throws(() => questionSchema.parse({ ...q, difficulty: 'easy' }));
});
test('rules classifier tries specific subjects and generation is deterministic', async () => {
  assert.equal(
    classify({ ...source(), summary: 'A physicist and scientist', categories: [] }),
    'science',
  );
  assert.equal(
    classify({
      ...source(),
      title: 'Miscellaneous concept',
      summary: 'Unrelated abstract concept',
      categories: [],
    }),
    'basic',
  );
  const a = await makePlan(source(), 'rare', new RulesDecisions(), cfg());
  assert.deepEqual(a, await makePlan(source(), 'rare', new RulesDecisions(), cfg()));
  for (const r of ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const) {
    assert.equal(card(r).hp, card('common').hp);
    assert.equal(card(r).defense, card('common').defense);
  }
});
