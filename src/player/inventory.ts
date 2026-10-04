import { randomInt, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { rarities, types, type Card } from '../domain.js';
import { cardView, isPlayable, playable } from '../battle/catalogue.js';
import { BattleError } from '../battle/engine.js';
import type { CatalogueStore } from '../store.js';
import type { Config } from '../config.js';
import type { PlayerConfig } from './config.js';
import type { Collection, Owned, Opening } from './types.js';
import { transaction } from './database.js';
type Row = { id: string; user_id: string; version_id: string; acquired_at: string; source: string };
export function weightedIndex(weights: number[], choose: (n: number) => number) {
  let roll = choose(weights.reduce((s, n) => s + n, 0));
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i]!;
    if (roll < 0) return i;
  }
  throw Error('Invalid random selection');
}
export class Inventory {
  constructor(
    readonly db: DatabaseSync,
    readonly store: CatalogueStore,
    readonly config: Config,
    readonly settings: PlayerConfig,
    readonly refresh: () => void = () => {},
    readonly choose = randomInt,
    readonly now = Date.now,
  ) {}
  balance(user: string) {
    return Number(
      this.db.prepare('SELECT packs FROM inventory WHERE user_id=?').get(user)?.packs ?? 0,
    );
  }
  onboarded(user: string) {
    return !!this.db.prepare('SELECT user_id FROM starter_grants WHERE user_id=?').get(user);
  }
  view(row: Row): Owned {
    const card = this.store.data.cards[row.version_id];
    return {
      id: row.id,
      versionId: row.version_id,
      acquiredAt: row.acquired_at,
      source: row.source,
      card:
        card && this.store.data.sources[card.sourceKey] ? cardView(card, this.store.data) : null,
      playable: !!card && isPlayable(card, this.store, this.config),
      quantity: 1,
    };
  }
  owned(user: string, id: string): Owned {
    const row = this.db
      .prepare('SELECT * FROM owned_cards WHERE id=? AND user_id=?')
      .get(id, user) as Row | undefined;
    if (!row) throw new BattleError('Owned card not found', 404);
    return this.view(row);
  }
  resolve(user: string, ids: string[], complete = true): Card[] {
    if ((complete && ids.length !== 5) || ids.length > 5 || new Set(ids).size !== ids.length)
      throw new BattleError('Choose five different owned copies', 422);
    return ids.map((id) => {
      const owned = this.owned(user, id);
      if (!owned.playable)
        throw new BattleError('A selected card is unavailable. Replace it.', 422);
      return this.store.data.cards[owned.versionId]!;
    });
  }
  private award(user: string, cards: Card[], source: string, event: string) {
    const at = new Date(this.now()).toISOString();
    this.db.prepare('INSERT INTO acquisitions VALUES (?,?,?,?)').run(event, user, source, at);
    return cards.map((card) => {
      const id = randomUUID();
      this.db
        .prepare('INSERT INTO owned_cards VALUES (?,?,?,?,?,?)')
        .run(id, user, card.versionId, at, source, event);
      return id;
    });
  }
  bootstrap(user: string) {
    this.refresh();
    transaction(this.db, () => {
      if (this.onboarded(user)) return;
      const event = randomUUID();
      this.award(user, [], 'starter', event);
      this.db.prepare('INSERT INTO inventory VALUES (?,?)').run(user, this.settings.starterPacks);
      this.db.prepare('INSERT INTO starter_grants VALUES (?,?)').run(user, event);
    });
  }
  pools() {
    this.refresh();
    const cards = playable(this.store, this.config);
    const pools = rarities.map((r) => cards.filter((c) => c.rarity === r));
    const missing = rarities.filter((_, i) => this.settings.weights[i]! > 0 && !pools[i]!.length);
    const weights = this.settings.weights.map((w, i) => (pools[i]!.length ? w : 0));
    const available =
      weights.some((w) => w > 0) &&
      (this.settings.emptyPool === 'renormalize' || missing.length === 0);
    return { pools, weights, missing, available };
  }
  packInfo(user: string) {
    const { weights, missing, available } = this.pools();
    const total = weights.reduce((s, x) => s + x, 0);
    return {
      packs: this.balance(user),
      available,
      missing,
      policy: this.settings.emptyPool,
      odds: Object.fromEntries(rarities.map((r, i) => [r, available ? weights[i]! / total : 0])),
    };
  }
  opening(user: string, id: string): Opening {
    if (!this.db.prepare('SELECT id FROM pack_openings WHERE id=? AND user_id=?').get(id, user))
      throw new BattleError('Opening not found', 404);
    const rows = this.db
      .prepare(
        'SELECT c.* FROM pack_rewards r JOIN owned_cards c ON c.id=r.instance_id WHERE r.opening_id=? ORDER BY r.reveal_slot',
      )
      .all(id) as Row[];
    return { id, cards: rows.map((r) => this.view(r)) };
  }
  history(user: string) {
    return this.db
      .prepare('SELECT id FROM pack_openings WHERE user_id=? ORDER BY rowid DESC LIMIT 10')
      .all(user)
      .map((r) => this.opening(user, String(r.id)));
  }
  open(user: string, key: string): Opening {
    z.string().uuid().parse(key);
    this.refresh();
    const id = transaction(this.db, () => {
      const prior = this.db
        .prepare('SELECT id FROM pack_openings WHERE user_id=? AND request_key=?')
        .get(user, key);
      if (prior) return String(prior.id);
      if (this.balance(user) < 1) throw new BattleError('No packs remaining', 409);
      const { pools, weights, missing, available } = this.pools();
      if (!available)
        throw new BattleError(
          `Pack unavailable: missing eligible rarity pools (${missing.join(', ') || 'all'}). No pack was spent.`,
          422,
        );
      const cards = Array.from({ length: 5 }, () => {
        const pool = pools[weightedIndex(weights, this.choose)]!;
        return pool[this.choose(pool.length)]!;
      });
      const opening = randomUUID(),
        ids = this.award(user, cards, 'pack', opening);
      this.db
        .prepare('INSERT INTO pack_openings VALUES (?,?,?,?)')
        .run(opening, user, key, JSON.stringify(weights));
      const order = cards
        .map((c, slot) => ({ c, slot }))
        .sort(
          (a, b) => rarities.indexOf(a.c.rarity) - rarities.indexOf(b.c.rarity) || a.slot - b.slot,
        );
      order.forEach(({ slot }, reveal) =>
        this.db
          .prepare('INSERT INTO pack_rewards VALUES (?,?,?,?)')
          .run(opening, slot, reveal, ids[slot]!),
      );
      this.db.prepare('UPDATE inventory SET packs=packs-1 WHERE user_id=?').run(user);
      return opening;
    });
    return this.opening(user, id);
  }
  catalogue(params: URLSearchParams): Collection {
    this.refresh();
    const query = z
      .object({
        q: z.string().max(200).default(''),
        type: z.enum(['', ...types]).default(''),
        rarity: z.enum(['', ...rarities]).default(''),
        sort: z.enum(['rarity', 'name', 'type', 'date']).default('rarity'),
        direction: z.enum(['asc', 'desc']).default('desc'),
        page: z.coerce.number().int().min(1).max(1000000).default(1),
      })
      .parse(Object.fromEntries(params));
    const all = playable(this.store, this.config);
    const entries = all.filter(
      (c) =>
        (!query.q || c.name.toLowerCase().includes(query.q.toLowerCase())) &&
        (!query.type || c.type === query.type) &&
        (!query.rarity || c.rarity === query.rarity),
    );
    entries.sort((a, b) => {
      const cmp =
        query.sort === 'rarity'
          ? rarities.indexOf(a.rarity) - rarities.indexOf(b.rarity)
          : query.sort === 'type'
            ? a.type.localeCompare(b.type)
            : query.sort === 'date'
              ? a.createdAt.localeCompare(b.createdAt)
              : a.name.localeCompare(b.name);
      return (
        cmp * (query.direction === 'asc' ? 1 : -1) ||
        a.name.localeCompare(b.name) ||
        a.versionId.localeCompare(b.versionId)
      );
    });
    return {
      cards: entries.slice((query.page - 1) * 20, query.page * 20).map((c) => ({
        id: c.versionId,
        versionId: c.versionId,
        acquiredAt: c.createdAt,
        source: 'catalogue',
        card: cardView(c, this.store.data),
        playable: true,
        quantity: 1,
      })),
      total: entries.length,
      copies: all.length,
      page: query.page,
      pageSize: 20,
    };
  }
  collection(user: string, params: URLSearchParams): Collection {
    this.refresh();
    const query = z
      .object({
        q: z.string().max(200).default(''),
        type: z.enum(['', ...types]).default(''),
        rarity: z.enum(['', ...rarities]).default(''),
        sort: z.enum(['name', 'rarity', 'date', 'type']).default('rarity'),
        direction: z.enum(['asc', 'desc']).default('desc'),
        page: z.coerce.number().int().min(1).max(1000000).default(1),
        grouped: z.enum(['true', 'false']).default('false'),
        version: z.string().optional(),
      })
      .parse(Object.fromEntries(params));
    const rows = this.db.prepare('SELECT * FROM owned_cards WHERE user_id=?').all(user) as Row[];
    const copies = rows.length;
    let entries = rows.filter((r) => {
      const c = this.store.data.cards[r.version_id];
      return (
        (!query.version || query.version === r.version_id) &&
        (!query.q ||
          (c?.name ?? 'Unavailable card').toLowerCase().includes(query.q.toLowerCase())) &&
        (!query.type || c?.type === query.type) &&
        (!query.rarity || c?.rarity === query.rarity)
      );
    });
    const counts = new Map<string, number>();
    for (const row of entries) counts.set(row.version_id, (counts.get(row.version_id) ?? 0) + 1);
    if (query.grouped === 'true') {
      const groups = new Map<string, Row>();
      for (const row of entries) {
        const old = groups.get(row.version_id);
        if (!old || row.acquired_at > old.acquired_at) groups.set(row.version_id, row);
      }
      entries = [...groups.values()];
    }
    entries.sort((a, b) => {
      const ac = this.store.data.cards[a.version_id],
        bc = this.store.data.cards[b.version_id];
      const cmp =
        query.sort === 'name'
          ? (ac?.name ?? '').localeCompare(bc?.name ?? '')
          : query.sort === 'rarity'
            ? rarities.indexOf(ac?.rarity ?? 'common') - rarities.indexOf(bc?.rarity ?? 'common')
            : query.sort === 'type'
              ? (ac?.type ?? '').localeCompare(bc?.type ?? '')
              : a.acquired_at.localeCompare(b.acquired_at);
      return (
        cmp * (query.direction === 'asc' ? 1 : -1) ||
        b.acquired_at.localeCompare(a.acquired_at) ||
        a.id.localeCompare(b.id)
      );
    });
    return {
      cards: entries
        .slice((query.page - 1) * 20, query.page * 20)
        .map((r) => ({ ...this.view(r), quantity: counts.get(r.version_id)! })),
      total: entries.length,
      copies,
      page: query.page,
      pageSize: 20,
    };
  }
}
