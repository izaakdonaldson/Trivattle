import { randomInt, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { BattleError } from '../battle/engine.js';
import { transaction } from './database.js';
import type { Friendship, FriendList, PublicPlayer } from './social-types.js';
type Relationship = {
  id: string;
  user_a: string;
  user_b: string;
  requester: string;
  status: Friendship['status'];
  revision: number;
  updated_at: number;
};
export class Friends {
  readonly dirty = new Set<string>();
  private limits = new Map<string, number[]>();
  onRemove: (a: string, b: string) => void = () => {};
  constructor(
    readonly db: DatabaseSync,
    readonly now = Date.now,
    readonly choose = randomInt,
  ) {}
  limited(user: string, kind: string, limit = 30) {
    const key = user + ':' + kind,
      time = this.now(),
      old = (this.limits.get(key) ?? []).filter((t) => time - t < 60000);
    if (old.length >= limit) throw new BattleError('Too many requests. Try again shortly.', 429);
    old.push(time);
    this.limits.set(key, old);
    for (const [k, v] of this.limits) if (v.at(-1)! < time - 60000) this.limits.delete(k);
  }
  profile(user: string): PublicPlayer {
    if (!this.db.prepare('SELECT user_id FROM player_profiles WHERE user_id=?').get(user)) {
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      for (let attempt = 0; attempt < 100; attempt++) {
        const code = Array.from({ length: 8 }, () => alphabet[this.choose(alphabet.length)]).join(
          '',
        );
        const result = this.db
          .prepare('INSERT OR IGNORE INTO player_profiles VALUES (?,?)')
          .run(user, code);
        if (result.changes) break;
      }
    }
    const row = this.db
      .prepare(
        'SELECT u.id,u.name,p.friend_code FROM user u JOIN player_profiles p ON p.user_id=u.id WHERE u.id=?',
      )
      .get(user);
    if (!row) throw new BattleError('Unable to create friend code', 503);
    const code = String(row.friend_code);
    return {
      id: String(row.id),
      name: String(row.name),
      friendCode: code.slice(0, 4) + '-' + code.slice(4),
    };
  }
  lookup(code: string): PublicPlayer {
    const normalized = z
      .string()
      .trim()
      .toUpperCase()
      .transform((v) => v.replace(/[-\s]/g, ''))
      .pipe(z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/))
      .parse(code);
    const row = this.db
      .prepare('SELECT user_id FROM player_profiles WHERE friend_code=?')
      .get(normalized);
    if (!row) throw new BattleError('Friend code not found', 404);
    return this.profile(String(row.user_id));
  }
  accepted(a: string, b: string) {
    const [lo, hi] = [a, b].sort();
    return !!this.db
      .prepare("SELECT id FROM relationships WHERE user_a=? AND user_b=? AND status='ACCEPTED'")
      .get(lo!, hi!);
  }
  get(user: string, id: string): Relationship {
    const row = this.db
      .prepare('SELECT * FROM relationships WHERE id=? AND (user_a=? OR user_b=?)')
      .get(id, user, user) as Relationship | undefined;
    if (!row) throw new BattleError('Friend request not found', 404);
    return row;
  }
  view(user: string, r: Relationship): Friendship {
    return {
      id: r.id,
      player: this.profile(r.user_a === user ? r.user_b : r.user_a),
      status: r.status,
      incoming: r.requester !== user,
      revision: r.revision,
    };
  }
  list(user: string, page = 1): FriendList {
    const where = "(user_a=? OR user_b=?) AND status IN ('PENDING','ACCEPTED')";
    const total = Number(
      this.db.prepare('SELECT count(*) AS n FROM relationships WHERE ' + where).get(user, user)!.n,
    );
    const rows = this.db
      .prepare(
        'SELECT * FROM relationships WHERE ' +
          where +
          ' ORDER BY updated_at DESC,id LIMIT 30 OFFSET ?',
      )
      .all(user, user, (page - 1) * 30) as Relationship[];
    return { items: rows.map((r) => this.view(user, r)), total, page, pageSize: 30 };
  }
  request(user: string, code: string) {
    const other = this.lookup(code).id;
    if (user === other) throw new BattleError('You cannot add yourself', 422);
    const [a, b] = [user, other].sort();
    const id = transaction(this.db, () => {
      const old = this.db
        .prepare('SELECT * FROM relationships WHERE user_a=? AND user_b=?')
        .get(a!, b!) as Relationship | undefined;
      if (old && ['PENDING', 'ACCEPTED'].includes(old.status)) return old.id;
      if (old) {
        this.db
          .prepare(
            "UPDATE relationships SET requester=?,status='PENDING',revision=revision+1,updated_at=? WHERE id=?",
          )
          .run(user, this.now(), old.id);
        return old.id;
      }
      const id = randomUUID();
      this.db
        .prepare("INSERT INTO relationships VALUES (?,?,?,?,'PENDING',0,?)")
        .run(id, a!, b!, user, this.now());
      return id;
    });
    this.dirty.add(user);
    this.dirty.add(other);
    return this.view(user, this.get(user, id));
  }
  act(
    user: string,
    id: string,
    action: 'accept' | 'decline' | 'cancel' | 'remove',
    revision: number,
  ) {
    const statuses = {
      accept: 'ACCEPTED',
      decline: 'DECLINED',
      cancel: 'CANCELLED',
      remove: 'REMOVED',
    } as const;
    const row = transaction(this.db, () => {
      const r = this.get(user, id);
      if ((action === 'accept' || action === 'decline') && r.requester === user)
        throw new BattleError('Only the recipient can answer this request', 403);
      if (action === 'cancel' && r.requester !== user)
        throw new BattleError('Only the sender can cancel this request', 403);
      if (r.status === statuses[action] && r.revision === revision + 1) return r;
      if (r.revision !== revision)
        throw new BattleError('Friendship changed. Refresh and try again.', 409);
      if (r.status !== (action === 'remove' ? 'ACCEPTED' : 'PENDING'))
        throw new BattleError('This action is no longer available', 409);
      this.db
        .prepare('UPDATE relationships SET status=?,revision=revision+1,updated_at=? WHERE id=?')
        .run(statuses[action], this.now(), id);
      if (action === 'remove') this.onRemove(r.user_a, r.user_b);
      return this.get(user, id);
    });
    this.dirty.add(row.user_a);
    this.dirty.add(row.user_b);
    return this.view(user, row);
  }
}
