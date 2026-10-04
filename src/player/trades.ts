import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { cardView, isPlayable } from '../battle/catalogue.js';
import { BattleError } from '../battle/engine.js';
import { transaction } from './database.js';
import type { Inventory } from './inventory.js';
import type { Friends } from './friends.js';
import type { TradeList, TradeState, TradeView } from './social-types.js';
type Row = {
  id: string;
  user_a: string;
  user_b: string;
  state: TradeState;
  revision: number;
  offer_revision: number;
  a_confirm: number | null;
  b_confirm: number | null;
  a_session: string | null;
  b_session: string | null;
  created_at: number;
  expires_at: number;
  completed_at: number | null;
  error: string | null;
};
type Offer = {
  trade_id: string;
  user_id: string;
  instance_id: string;
  version_id: string;
  position: number;
};
const active = "('INVITED','NEGOTIATING','SETTLING')";
const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept') }),
  z.object({ action: z.literal('reject') }),
  z.object({ action: z.literal('cancel') }),
  z.object({ action: z.literal('offer'), instances: z.array(z.string().uuid()).max(5) }),
  z.object({ action: z.literal('confirm'), offerRevision: z.number().int().nonnegative() }),
]);
const baseSchema = z.object({
  requestId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
});
export class Trades {
  readonly dirty = new Set<string>();
  readonly inventoryDirty = new Set<string>();
  constructor(
    readonly inventory: Inventory,
    readonly friends: Friends,
    readonly connected: (user: string) => boolean,
    readonly now = Date.now,
  ) {
    transaction(this.db, () => {
      this.db
        .prepare(
          "UPDATE trades SET a_confirm=NULL,b_confirm=NULL,a_session=NULL,b_session=NULL,revision=revision+1 WHERE state='NEGOTIATING' AND (a_confirm IS NOT NULL OR b_confirm IS NOT NULL)",
        )
        .run();
      this.expireInside();
    });
    friends.onRemove = (a, b) => this.cancelPairInside(a, b);
  }
  get db() {
    return this.inventory.db;
  }
  row(user: string, id: string) {
    const r = this.db
      .prepare('SELECT * FROM trades WHERE id=? AND (user_a=? OR user_b=?)')
      .get(id, user, user) as Row | undefined;
    if (!r) throw new BattleError('Trade unavailable or access denied', 404);
    return r;
  }
  changed(r: Row) {
    this.dirty.add(r.user_a);
    this.dirty.add(r.user_b);
  }
  clearInside(r: Row, error: string | null = null) {
    this.db
      .prepare(
        'UPDATE trades SET a_confirm=NULL,b_confirm=NULL,a_session=NULL,b_session=NULL,revision=revision+1,error=? WHERE id=?',
      )
      .run(error, r.id);
    this.changed(r);
  }
  finishInside(r: Row, state: 'CANCELLED' | 'EXPIRED') {
    this.db
      .prepare(
        'UPDATE trades SET state=?,a_confirm=NULL,b_confirm=NULL,a_session=NULL,b_session=NULL,revision=revision+1 WHERE id=?',
      )
      .run(state, r.id);
    this.db.prepare('DELETE FROM trade_reservations WHERE trade_id=?').run(r.id);
    this.changed(r);
  }
  cancelPairInside(a: string, b: string) {
    const rows = this.db
      .prepare(
        'SELECT * FROM trades WHERE state IN ' +
          active +
          ' AND ((user_a=? AND user_b=?) OR (user_a=? AND user_b=?))',
      )
      .all(a, b, b, a) as Row[];
    for (const r of rows) this.finishInside(r, 'CANCELLED');
  }
  expireInside() {
    const rows = this.db
      .prepare('SELECT * FROM trades WHERE state IN ' + active + ' AND expires_at<=?')
      .all(this.now()) as Row[];
    for (const r of rows) this.finishInside(r, 'EXPIRED');
  }
  validSession(user: string, id: string | null) {
    if (!id) return false;
    const row = this.db
      .prepare('SELECT expiresAt FROM session WHERE id=? AND userId=?')
      .get(id, user);
    if (!row) return false;
    const value = row.expiresAt;
    const time =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\d+$/.test(value)
          ? Number(value)
          : Date.parse(String(value));
    return time > this.now();
  }
  presence(user: string) {
    this.sweep();
    const rows = this.db
      .prepare('SELECT * FROM trades WHERE state IN ' + active + ' AND (user_a=? OR user_b=?)')
      .all(user, user) as Row[];
    for (const r of rows) {
      this.db.prepare('UPDATE trades SET revision=revision+1 WHERE id=?').run(r.id);
      this.changed(r);
    }
  }
  sweep() {
    transaction(this.db, () => {
      this.expireInside();
      const rows = this.db
        .prepare(
          "SELECT * FROM trades WHERE state='NEGOTIATING' AND (a_confirm IS NOT NULL OR b_confirm IS NOT NULL)",
        )
        .all() as Row[];
      for (const r of rows) {
        if (
          !this.connected(r.user_a) ||
          !this.connected(r.user_b) ||
          (r.a_confirm !== null && !this.validSession(r.user_a, r.a_session)) ||
          (r.b_confirm !== null && !this.validSession(r.user_b, r.b_session))
        )
          this.clearInside(r, 'Connection changed. Both players must confirm again.');
      }
    });
  }
  offers(id: string) {
    return this.db
      .prepare('SELECT * FROM trade_offers WHERE trade_id=? ORDER BY user_id,position')
      .all(id) as Offer[];
  }
  view(user: string, r: Row): TradeView {
    const offers = this.offers(r.id);
    return {
      id: r.id,
      state: r.state,
      revision: r.revision,
      offerRevision: r.offer_revision,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
      completedAt: r.completed_at,
      serverTime: this.now(),
      self: user,
      invitedBy: r.user_a,
      error: r.error,
      players: [r.user_a, r.user_b].map((id, i) => ({
        player: this.friends.profile(id),
        connected: this.connected(id),
        confirmed: (i === 0 ? r.a_confirm : r.b_confirm) === r.offer_revision,
        cards: offers
          .filter((o) => o.user_id === id)
          .map((o) => {
            const card = this.inventory.store.data.cards[o.version_id];
            // History and peer offers expose no current owner or later acquisition/reservation information.
            return {
              id: o.instance_id,
              versionId: o.version_id,
              acquiredAt: new Date(r.completed_at ?? r.created_at).toISOString(),
              source: 'trade',
              card:
                card && this.inventory.store.data.sources[card.sourceKey]
                  ? cardView(card, this.inventory.store.data)
                  : null,
              playable: !!card && isPlayable(card, this.inventory.store, this.inventory.config),
              quantity: 1,
            };
          }),
      })),
    };
  }
  detail(user: string, id: string) {
    this.sweep();
    this.inventory.refresh();
    return this.view(user, this.row(user, id));
  }
  list(user: string, history: boolean, page = 1): TradeList {
    this.sweep();
    this.inventory.refresh();
    const where =
      '(user_a=? OR user_b=?) AND state ' + (history ? 'NOT IN ' + active : 'IN ' + active);
    const total = Number(
      this.db.prepare('SELECT count(*) AS n FROM trades WHERE ' + where).get(user, user)!.n,
    );
    const rows = this.db
      .prepare(
        'SELECT * FROM trades WHERE ' + where + ' ORDER BY created_at DESC,id LIMIT 20 OFFSET ?',
      )
      .all(user, user, (page - 1) * 20) as Row[];
    return { items: rows.map((r) => this.view(user, r)), total, page, pageSize: 20 };
  }
  fingerprint(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
  prior(user: string, requestId: string, fingerprint: string) {
    const row = this.db
      .prepare('SELECT * FROM trade_requests WHERE user_id=? AND request_id=?')
      .get(user, requestId);
    if (row && row.fingerprint !== fingerprint)
      throw new BattleError('Request key was used for a different action', 409);
    return row ? String(row.trade_id) : null;
  }
  record(user: string, requestId: string, fp: string, id: string) {
    this.db.prepare('INSERT INTO trade_requests VALUES (?,?,?,?)').run(user, requestId, fp, id);
  }
  invite(user: string, other: string, requestId: string) {
    z.string().uuid().parse(requestId);
    z.string().min(1).max(128).parse(other);
    this.sweep();
    const fp = this.fingerprint(['invite', other]);
    const id = transaction(this.db, () => {
      const prior = this.prior(user, requestId, fp);
      if (prior) return prior;
      if (user === other || !this.friends.accepted(user, other))
        throw new BattleError('You can only trade with accepted friends', 403);
      for (const u of [user, other]) {
        const n = Number(
          this.db
            .prepare(
              'SELECT count(*) AS n FROM trades WHERE state IN ' +
                active +
                ' AND (user_a=? OR user_b=?)',
            )
            .get(u, u)!.n,
        );
        if (n >= 10) throw new BattleError('A player already has ten unfinished trades', 409);
      }
      const id = randomUUID(),
        now = this.now();
      this.db
        .prepare(
          "INSERT INTO trades (id,user_a,user_b,state,created_at,expires_at) VALUES (?,?,?,'INVITED',?,?)",
        )
        .run(id, user, other, now, now + this.inventory.settings.tradeExpiryMs);
      this.record(user, requestId, fp, id);
      return id;
    });
    const r = this.row(user, id);
    this.changed(r);
    return this.view(user, r);
  }
  validateOffer(user: string, ids: string[], trade: string) {
    if (new Set(ids).size !== ids.length)
      throw new BattleError('Choose distinct owned copies', 422);
    for (const id of ids) {
      const c = this.inventory.owned(user, id);
      if (!c.playable)
        throw new BattleError('A card is unavailable. Remove it from the offer.', 409);
      if (this.inventory.battleCommitted(id))
        throw new BattleError('A card is committed to a battle lobby or match', 409);
      const reservation = this.inventory.reservedTrade(id);
      if (reservation && reservation !== trade)
        throw new BattleError('A card is reserved for another trade', 409);
    }
  }
  settleInside(r: Row) {
    if (!this.friends.accepted(r.user_a, r.user_b))
      throw new BattleError('Friendship no longer exists', 409);
    if (r.expires_at <= this.now()) throw new BattleError('Trade expired', 409);
    if (r.a_confirm !== r.offer_revision || r.b_confirm !== r.offer_revision)
      throw new BattleError('Both players must confirm the current offers', 409);
    if (
      !this.connected(r.user_a) ||
      !this.connected(r.user_b) ||
      !this.validSession(r.user_a, r.a_session) ||
      !this.validSession(r.user_b, r.b_session)
    )
      throw new BattleError('Both players must be connected and authenticated', 409);
    const offers = this.offers(r.id);
    for (const u of [r.user_a, r.user_b]) {
      const ids = offers.filter((o) => o.user_id === u).map((o) => o.instance_id);
      if (ids.length < 1 || ids.length > 5)
        throw new BattleError('Each player must offer one to five cards', 422);
      this.validateOffer(u, ids, r.id);
      for (const id of ids)
        if (this.inventory.reservedTrade(id) !== r.id)
          throw new BattleError('A reservation is no longer valid', 409);
    }
    this.db.prepare("UPDATE trades SET state='SETTLING' WHERE id=?").run(r.id);
    const at = this.now(),
      stamp = new Date(at).toISOString(),
      events = new Map<string, string>();
    for (const u of [r.user_a, r.user_b]) {
      const event = randomUUID();
      events.set(u, event);
      this.db.prepare("INSERT INTO acquisitions VALUES (?,?,'trade',?)").run(event, u, stamp);
    }
    for (const o of offers) {
      const recipient = o.user_id === r.user_a ? r.user_b : r.user_a;
      const result = this.db
        .prepare(
          "UPDATE owned_cards SET user_id=?,acquired_at=?,source='trade',event_id=? WHERE id=? AND user_id=? AND version_id=?",
        )
        .run(recipient, stamp, events.get(recipient)!, o.instance_id, o.user_id, o.version_id);
      if (Number(result.changes) !== 1)
        throw new BattleError('Card ownership changed. Review your offers.', 409);
      this.db
        .prepare('INSERT INTO trade_transfers VALUES (?,?,?,?,?,?,?)')
        .run(r.id, o.instance_id, o.version_id, o.user_id, recipient, r.offer_revision, at);
    }
    this.db
      .prepare("UPDATE trades SET state='COMPLETED',completed_at=?,error=NULL WHERE id=?")
      .run(at, r.id);
    this.db.prepare('DELETE FROM trade_reservations WHERE trade_id=?').run(r.id);
  }
  command(user: string, sessionId: string, id: string, input: unknown): TradeView {
    const base = baseSchema.parse(input),
      action = commandSchema.parse(input);
    // Reject injected fields instead of silently using client authority.
    z.object({
      ...baseSchema.shape,
      ...('instances' in action ? { instances: z.array(z.string().uuid()).max(5) } : {}),
      ...('offerRevision' in action ? { offerRevision: z.number().int().nonnegative() } : {}),
      action: z.string(),
    })
      .strict()
      .parse(input);
    this.sweep();
    this.inventory.refresh();
    const fp = this.fingerprint([id, base.revision, action]);
    let attemptedSettlement = false;
    try {
      transaction(this.db, () => {
        const prior = this.prior(user, base.requestId, fp);
        if (prior) return;
        let r = this.row(user, id);
        if (r.revision !== base.revision)
          throw new BattleError('Trade changed. Review the latest offers.', 409);
        if (!['INVITED', 'NEGOTIATING'].includes(r.state))
          throw new BattleError('This trade has ended', 409);
        if (action.action === 'cancel' || action.action === 'reject') {
          if (action.action === 'reject' && (r.user_b !== user || r.state !== 'INVITED'))
            throw new BattleError('Only the recipient can reject an invitation', 403);
          this.finishInside(r, 'CANCELLED');
        } else if (action.action === 'accept') {
          if (r.user_b !== user || r.state !== 'INVITED')
            throw new BattleError('Only the recipient can accept this invitation', 403);
          if (!this.friends.accepted(r.user_a, r.user_b))
            throw new BattleError('You must still be friends', 403);
          this.db
            .prepare("UPDATE trades SET state='NEGOTIATING',revision=revision+1 WHERE id=?")
            .run(id);
        } else {
          if (r.state !== 'NEGOTIATING')
            throw new BattleError('Accept the trade invitation first', 409);
          if (action.action === 'offer') {
            this.validateOffer(user, action.instances, id);
            const old = this.offers(id)
              .filter((o) => o.user_id === user)
              .map((o) => o.instance_id);
            if (JSON.stringify(old) !== JSON.stringify(action.instances)) {
              this.db
                .prepare(
                  'DELETE FROM trade_reservations WHERE trade_id=? AND instance_id IN (SELECT instance_id FROM trade_offers WHERE trade_id=? AND user_id=?)',
                )
                .run(id, id, user);
              this.db
                .prepare('DELETE FROM trade_offers WHERE trade_id=? AND user_id=?')
                .run(id, user);
              action.instances.forEach((instance, position) => {
                const c = this.inventory.owned(user, instance);
                this.db
                  .prepare('INSERT INTO trade_offers VALUES (?,?,?,?,?)')
                  .run(id, user, instance, c.versionId, position);
                this.db.prepare('INSERT INTO trade_reservations VALUES (?,?)').run(instance, id);
              });
              this.db
                .prepare('UPDATE trades SET offer_revision=offer_revision+1 WHERE id=?')
                .run(id);
              this.clearInside(r);
            }
          } else {
            if (action.offerRevision !== r.offer_revision)
              throw new BattleError('Offers changed. Review them before confirming.', 409);
            attemptedSettlement = true;
            if (
              !this.connected(r.user_a) ||
              !this.connected(r.user_b) ||
              !this.validSession(user, sessionId)
            )
              throw new BattleError('Both players must be connected to confirm', 409);
            const offers = this.offers(id);
            for (const u of [r.user_a, r.user_b]) {
              const ids = offers.filter((o) => o.user_id === u).map((o) => o.instance_id);
              if (!ids.length)
                throw new BattleError('Each player must offer at least one card', 422);
              this.validateOffer(u, ids, id);
            }
            const side = user === r.user_a ? 'a' : 'b';
            this.db
              .prepare(
                'UPDATE trades SET ' +
                  side +
                  '_confirm=offer_revision,' +
                  side +
                  '_session=?,revision=revision+1,error=NULL WHERE id=?',
              )
              .run(sessionId, id);
            r = this.row(user, id);
            if (r.a_confirm === r.offer_revision && r.b_confirm === r.offer_revision) {
              attemptedSettlement = true;
              this.settleInside(r);
            }
          }
        }
        this.record(user, base.requestId, fp, id);
      });
    } catch (e) {
      if (attemptedSettlement)
        transaction(this.db, () => {
          const r = this.row(user, id);
          if (r.state === 'NEGOTIATING')
            this.clearInside(
              r,
              'Settlement failed. No cards moved; review your offers and confirm again.',
            );
        });
      throw e;
    }
    const r = this.row(user, id);
    this.changed(r);
    if (r.state === 'COMPLETED') {
      this.inventoryDirty.add(r.user_a);
      this.inventoryDirty.add(r.user_b);
    }
    return this.view(user, r);
  }
}
