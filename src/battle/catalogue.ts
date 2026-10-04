import { cardSchema, questionSchema, sourceSchema, type Card } from '../domain.js';
import { CachedCatalogue } from '../runtime.js';
import { CatalogueStore, type Catalogue } from '../store.js';
import type { Config } from '../config.js';
import type { CardView } from './types.js';
export function cardView(card: Card, data: Catalogue): CardView {
  const { id, versionId, pageId, name, type, rarity, hp, defense, attacks, passive } = card;
  const source = data.sources[card.sourceKey]!;
  return structuredClone({
    id,
    versionId,
    pageId,
    name,
    type,
    rarity,
    hp,
    defense,
    attacks,
    passive,
    image: source.image,
    url: source.url,
    summary: source.summary,
  });
}
export function playable(store: CatalogueStore, config: Config): Card[] {
  return new CachedCatalogue(store, config).getCards().filter((c) => {
    const source = store.data.sources[c.sourceKey];
    return (
      cardSchema.safeParse(c).success &&
      sourceSchema.safeParse(source).success &&
      source?.pageId === c.pageId &&
      c.hp > 0 &&
      c.defense >= 0 &&
      c.attacks.every((a) => a.power > 0) &&
      c.questionIds.length >= config.trivia.min &&
      c.questionIds.length <= config.trivia.max &&
      c.questionIds.every((id) => {
        const q = store.data.questions[id];
        return (
          questionSchema.safeParse(q).success &&
          q?.pageId === c.pageId &&
          q.revisionId === source.revisionId
        );
      })
    );
  });
}
// Pin only the selected catalogue records, never generation jobs or provider data.
export function pin(store: CatalogueStore, cards: Card[]): Catalogue {
  const data: Catalogue = {
    schemaVersion: 1,
    sources: {},
    aliases: {},
    views: {},
    populations: {},
    jobs: {},
    cards: {},
    published: {},
    questions: {},
    configs: {},
    quarantined: {},
  };
  for (const c of cards) {
    data.cards[c.versionId] = c;
    data.published[c.id] = c.versionId;
    data.sources[c.sourceKey] = store.data.sources[c.sourceKey]!;
    for (const id of c.questionIds) data.questions[id] = store.data.questions[id]!;
  }
  return structuredClone(data);
}
