import { mkdirSync, writeFileSync } from 'node:fs';
import { card, source, questions, cfg } from '../test/helpers.js';
import { validateCard } from '../src/domain.js';
import { validateBank } from '../src/trivia.js';
const cards = (['common', 'uncommon', 'rare', 'epic', 'legendary'] as const).map((r, i) => {
  const s = source(900001 + i),
    c = card(r, s.pageId);
  validateCard(c, cfg());
  const trivia = questions(s);
  validateBank(trivia, s, cfg());
  return { card: c, wikipedia: s, trivia };
});
mkdirSync('data/fixtures', { recursive: true });
writeFileSync(
  'data/fixtures/cards.json',
  JSON.stringify(
    {
      notice:
        'SYNTHETIC DEVELOPMENT FIXTURES. These titles, IDs, revisions, prose, and trivia are invented for tests, not real Wikipedia articles or verified playable cards. Never import into a published catalogue.',
      cards,
    },
    null,
    2,
  ) + '\n',
);
console.log('Wrote 5 non-playable fixtures covering all rarities.');
