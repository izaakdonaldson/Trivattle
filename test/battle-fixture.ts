import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { card, cfg, source, questions } from './helpers.js';
import { CatalogueStore } from '../src/store.js';
import { pin, playable } from '../src/battle/catalogue.js';
import { createBattle } from '../src/battle/engine.js';
export function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'trivattle-battle-'));
  const store = new CatalogueStore(directory);
  for (let i = 1; i <= 10; i++) {
    const c = card((['common', 'uncommon', 'rare', 'epic', 'legendary'] as const)[(i - 1) % 5]!, i);
    c.status = 'published';
    c.type = (
      ['science', 'nature', 'technology', 'history', 'culture', 'geography', 'basic'] as const
    )[(i - 1) % 7]!;
    if (c.rarity === 'epic') c.passive = { id: 'recovery' };
    if (c.rarity === 'legendary') c.passive = { id: 'immune' };
    const s = source(i);
    store.data.sources[c.sourceKey] = s;
    store.data.cards[c.versionId] = c;
    store.data.published[c.id] = c.versionId;
    for (const q of questions(s)) store.data.questions[q.id] = q;
  }
  store.save();
  const cards = playable(store, cfg()),
    data = pin(store, cards);
  const state = createBattle('test', [cards.slice(0, 5), cards.slice(5)], cfg());
  return {
    store,
    cards,
    data,
    state,
    clean: () => rmSync(directory, { recursive: true, force: true }),
  };
}
