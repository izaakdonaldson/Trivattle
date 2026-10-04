import { randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createBattle,
  applyCommand,
  publicBattle,
  BattleError,
  type BattleState,
} from '../battle/engine.js';
import { transaction } from '../player/database.js';
import { pin, cardView } from '../battle/catalogue.js';
import type { Catalogue } from '../store.js';
import type { Inventory } from '../player/inventory.js';
import type { LobbyView } from '../player/types.js';
import type { Command } from '../battle/types.js';
type Member = {
  id: string;
  name: string;
  selection: (string | null)[];
  ready: boolean;
  disconnectedAt: number | null;
};
export type Room = {
  id: string;
  code: string;
  revision: number;
  status: LobbyView['status'];
  members: Member[];
  touched: number;
  ended: number | null;
  state?: BattleState;
  announcementUntil?: number;
  data?: Catalogue;
  requests: Set<string>;
};
const envelope = z.object({
  roomId: z.string().uuid(),
  requestId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
});
export class Rooms {
  readonly rooms = new Map<string, Room>();
  readonly connections = new Map<string, Set<string>>();
  private limits = new Map<string, number[]>();
  constructor(
    readonly inventory: Inventory,
    readonly now = Date.now,
  ) {}
  limited(user: string) {
    const time = this.now(),
      prior = (this.limits.get(user) ?? []).filter((t) => time - t < 60000);
    if (prior.length >= 10)
      throw new BattleError('Too many lobby attempts. Try again shortly.', 429);
    prior.push(time);
    this.limits.set(user, prior);
  }
  connected(user: string) {
    return !!this.connections.get(user)?.size;
  }
  active(user: string) {
    return [...this.rooms.values()].find(
      (r) => r.ended === null && r.members.some((m) => m.id === user),
    );
  }
  get(id: string, user: string) {
    const r = this.rooms.get(id);
    if (!r || !r.members.some((m) => m.id === user))
      throw new BattleError('Lobby unavailable or access denied', 404);
    return r;
  }
  member(user: { id: string; name: string }): Member {
    return {
      ...user,
      selection: Array(5).fill(null),
      ready: false,
      disconnectedAt: this.connected(user.id) ? null : this.now(),
    };
  }
  create(user: { id: string; name: string }) {
    this.sweep();
    this.limited(user.id);
    const active = this.active(user.id);
    if (active) return active;
    let code = '';
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    do {
      code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('');
    } while ([...this.rooms.values()].some((r) => r.code === code));
    const r: Room = {
      id: randomUUID(),
      code,
      revision: 0,
      status: 'waiting',
      members: [this.member(user)],
      touched: this.now(),
      ended: null,
      requests: new Set(),
    };
    this.rooms.set(r.id, r);
    return r;
  }
  join(user: { id: string; name: string }, code: string) {
    this.sweep();
    this.limited(user.id);
    z.string()
      .regex(/^[A-Z2-9]{6}$/)
      .parse(code);
    const r = [...this.rooms.values()].find((r) => r.code === code && r.ended === null);
    if (!r) throw new BattleError('Invalid or expired lobby', 404);
    if (r.members.some((m) => m.id === user.id)) return r;
    if (this.active(user.id)) throw new BattleError('Leave your current lobby first');
    if (r.members.length === 2 || r.status !== 'waiting') throw new BattleError('Lobby is full');
    r.members.push(this.member(user));
    r.status = 'selecting';
    r.revision++;
    r.touched = this.now();
    return r;
  }
  presence(user: string, socket: string, connected: boolean) {
    const set = this.connections.get(user) ?? new Set<string>();
    if (connected) set.add(socket);
    else set.delete(socket);
    if (set.size) this.connections.set(user, set);
    else this.connections.delete(user);
    for (const r of this.rooms.values()) {
      const m = r.members.find((m) => m.id === user);
      if (!m || r.ended !== null) continue;
      const next = set.size ? null : (m.disconnectedAt ?? this.now());
      if (next !== m.disconnectedAt) {
        m.disconnectedAt = next;
        r.revision++;
      }
    }
  }
  paused(r: Room) {
    return r.ended === null && r.members.some((m) => !this.connected(m.id));
  }
  finish(r: Room, status: 'expired' | 'abandoned' | 'finished') {
    r.status = status;
    r.ended = this.now();
    r.revision++;
  }
  sweep() {
    const t = this.now(),
      s = this.inventory.settings;
    for (const [id, r] of this.rooms) {
      if (r.ended !== null) {
        if (t - r.ended > s.retentionMs) this.rooms.delete(id);
        continue;
      }
      if (
        r.members.some((m) => m.disconnectedAt !== null && t - m.disconnectedAt >= s.reconnectMs)
      ) {
        this.finish(r, 'abandoned');
        continue;
      }
      if (t - r.touched > (r.state ? s.battleIdleMs : s.lobbyIdleMs)) this.finish(r, 'expired');
    }
    for (const [key, times] of this.limits) if (times.at(-1)! < t - 60000) this.limits.delete(key);
  }
  view(r: Room, user: string): LobbyView {
    const index = r.members.findIndex((m) => m.id === user);
    if (index < 0) throw new BattleError('Lobby access denied', 403);
    const self = `player-${index + 1}`;
    const battle = r.state && r.data ? publicBattle(r.state, r.data) : null;

    const deadlines = r.members
      .filter((m) => m.disconnectedAt !== null)
      .map((m) => m.disconnectedAt! + this.inventory.settings.reconnectMs);
    return {
      id: r.id,
      code: r.code,
      revision: r.revision,
      status: r.status,
      self,
      players: r.members.map((m, i) => ({
        slot: `player-${i + 1}`,
        name: m.name,
        ready: m.ready,
        connected: this.connected(m.id),
      })),
      selection: r.members[index]!.selection.map((id) => {
        if (!id) return null;
        try {
          return this.inventory.owned(user, id);
        } catch {
          return null;
        }
      }),
      paused: this.paused(r),
      reconnectDeadline: deadlines.length ? Math.min(...deadlines) : null,
      announcementUntil: r.announcementUntil ?? 0,
      battle,
    };
  }
  // All room mutations below are synchronous after authentication. No await may split a transition.
  // This is the single-process serialization boundary for ready/start and battle commands.
  command(user: string, event: string, input: unknown): Room | null {
    const base = envelope.parse(input);
    const r = this.get(base.roomId, user);
    this.sweep();
    if (r.ended !== null) {
      if (event === 'lobby:leave') return null;
      throw new BattleError('This lobby has ended');
    }
    if (r.requests.has(base.requestId)) throw new BattleError('Request already processed');
    if (base.revision !== r.revision) throw new BattleError('Lobby changed. Please try again.');
    const m = r.members.find((m) => m.id === user)!;
    if (event === 'lobby:leave') {
      envelope.strict().parse(input);
      if (r.state) throw new BattleError('A battle is in progress');
      if (r.members[0]!.id === user) this.finish(r, 'abandoned');
      else {
        r.members = r.members.filter((m) => m.id !== user);
        for (const p of r.members) {
          p.selection = Array(5).fill(null);
          p.ready = false;
        }
        r.status = 'waiting';
        r.revision++;
      }
      r.touched = this.now();
      return null;
    }
    if (this.paused(r)) throw new BattleError('Waiting for both players to reconnect');
    this.inventory.refresh();
    if (event === 'battle:command') {
      const value = envelope.extend({ command: z.unknown() }).strict().parse(input);
      if (!r.state || !r.data) throw new BattleError('Battle has not started');
      const c = z
        .object({
          kind: z.enum(['attack', 'answer']),
          commandId: z.string().uuid(),
          revision: z.number().int().nonnegative(),
          attackerId: z.string().optional(),
          attackId: z.string().optional(),
          targetId: z.string().optional(),
          questionId: z.string().optional(),
          answerIndex: z.number().int().min(0).max(3).optional(),
        })
        .strict()
        .parse(value.command);
      r.state = applyCommand(
        r.state,
        { ...c, playerId: `player-${r.members.indexOf(m) + 1}` } as Command,
        r.data,
        this.inventory.choose,
      );
      if (c.kind === 'attack') r.announcementUntil = this.now() + 3000;
      if (r.state.winner) this.finish(r, 'finished');
    } else {
      if (r.state || r.members.length !== 2)
        throw new BattleError('Waiting for an opponent or battle already started');
      if (event === 'lobby:select') {
        const v = envelope
          .extend({ selection: z.array(z.string().uuid().nullable()).length(5) })
          .strict()
          .parse(input);
        if (m.ready) throw new BattleError('Unready before editing your selection');
        this.inventory.resolve(
          user,
          v.selection.filter((x): x is string => x !== null),
          false,
        );
        m.selection = v.selection;
      } else if (event === 'lobby:unready') {
        envelope.strict().parse(input);
        m.ready = false;
      } else if (event === 'lobby:ready') {
        envelope.strict().parse(input);
        this.inventory.resolve(
          user,
          m.selection.filter((x): x is string => x !== null),
        );
        m.ready = true;
        if (r.members.every((m) => m.ready)) {
          try {
            const initialized = transaction(this.inventory.db, () => {
              const teams = r.members.map((p) =>
                this.inventory.resolve(
                  p.id,
                  p.selection.filter((x): x is string => x !== null),
                ),
              ) as Parameters<typeof createBattle>[1];
              const data = pin(this.inventory.store, teams.flat());
              const state = createBattle(randomUUID(), teams, this.inventory.config);
              return { data, state };
            });
            r.data = initialized.data;
            r.state = initialized.state;
            r.status = 'in-battle';
          } catch {
            for (const p of r.members) p.ready = false;
            r.status = 'selecting';
            r.revision++;
            throw new BattleError(
              'A selection is no longer valid. Review your cards and ready again.',
            );
          }
        }
      } else throw new BattleError('Unknown command', 400);
      if (!r.state) r.status = r.members.some((m) => m.ready) ? 'ready-to-start' : 'selecting';
    }
    r.requests.add(base.requestId);
    r.revision++;
    r.touched = this.now();
    return r;
  }
  details(user: string, roomId: string, id: string) {
    const r = this.get(roomId, user),
      slot = `player-${r.members.findIndex((m) => m.id === user) + 1}`;
    const unit = r.state?.teams.flat().find((u) => u.instanceId === id);
    if (!unit || !r.data) throw new BattleError('Card not found', 404);
    const v = cardView(unit.card, r.data);
    return r.state!.phase === 'SELECTING_ATTACK' &&
      r.state!.currentPlayer === slot &&
      unit.playerId === slot
      ? v
      : { ...v, summary: undefined, url: undefined };
  }
}
