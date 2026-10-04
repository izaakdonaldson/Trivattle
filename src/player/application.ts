import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { z } from 'zod';
import { openDatabase, migrate } from './database.js';
import { createAuth } from './auth.js';
import { Inventory } from './inventory.js';
import { playerConfig, type PlayerConfig } from './config.js';
import { Trades } from './trades.js';
import { Friends } from './friends.js';
import { Rooms } from '../multiplayer/rooms.js';
import { BattleError } from '../battle/engine.js';
import type { CatalogueStore } from '../store.js';
import type { Config } from '../config.js';
export async function readBody(req: IncomingMessage) {
  let text = '';
  for await (const c of req) {
    text += c;
    if (text.length > 16384) throw new BattleError('Request too large', 413);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BattleError('Invalid JSON', 400);
  }
}
export function errorMessage(e: unknown) {
  return e instanceof BattleError
    ? e.message
    : e instanceof z.ZodError
      ? 'Invalid request fields'
      : 'Unable to complete request';
}
export async function createApplication(options: {
  store: CatalogueStore;
  config: Config;
  refresh: () => void;
  dbPath: string;
  baseURL: string;
  secret: string;
  settings?: PlayerConfig;
  choose?: (n: number) => number;
  now?: () => number;
}) {
  const db = openDatabase(options.dbPath),
    auth = createAuth(db, options.baseURL, options.secret);
  await auth.migrate();
  migrate(db);
  const inventory = new Inventory(
    db,
    options.store,
    options.config,
    options.settings ?? playerConfig(),
    options.refresh,
    options.choose,
    options.now,
  );
  const rooms = new Rooms(inventory, options.now);
  const friends = new Friends(db, options.now);
  inventory.battleCommitted = (id) =>
    [...rooms.rooms.values()].some(
      (r) => r.ended === null && r.members.some((m) => m.selection.includes(id)),
    );
  const trades = new Trades(inventory, friends, (user) => rooms.connected(user), options.now);
  const notifications = new Map<string, Set<string>>();
  const notify = (user: string, event: string) => {
    const events = notifications.get(user) ?? new Set<string>();
    events.add(event);
    notifications.set(user, events);
  };
  function sweepRooms() {
    const active = [...rooms.rooms.values()].filter((r) => r.ended === null);
    rooms.sweep();
    for (const r of active)
      if (r.ended !== null) for (const member of r.members) notify(member.id, 'inventory:updated');
  }
  let io: Server | undefined;
  let closing = false;
  const origin = new URL(options.baseURL).origin;
  async function emitViews() {
    if (!io || closing) return;
    for (const user of friends.dirty) notify(user, 'friends:updated');
    friends.dirty.clear();
    for (const user of trades.dirty) {
      notify(user, 'trade:updated');
      notify(user, 'inventory:updated');
    }
    trades.dirty.clear();
    for (const user of trades.inventoryDirty) notify(user, 'inventory:updated');
    trades.inventoryDirty.clear();
    const outgoing = new Map(notifications);
    notifications.clear();
    for (const socket of io.sockets.sockets.values()) {
      try {
        await auth.session(socket.request.headers);
        for (const event of outgoing.get(socket.data.userId) ?? []) socket.emit(event);
        const room =
          rooms.active(socket.data.userId) ??
          [...rooms.rooms.values()].find(
            (r) =>
              r.members.some((m) => m.id === socket.data.userId) && r.id === socket.data.roomId,
          );
        if (room) {
          socket.data.roomId = room.id;
          socket.emit('lobby:update', rooms.view(room, socket.data.userId));
        }
      } catch {
        socket.disconnect(true);
      }
    }
  }
  function attach(server: HttpServer) {
    io = new Server(server, {
      maxHttpBufferSize: 16384,
      allowRequest: (req, cb) => cb(null, !req.headers.origin || req.headers.origin === origin),
    });
    io.use(async (socket, next) => {
      try {
        const s = await auth.session(socket.request.headers);
        socket.data.userId = s.user.id;
        socket.data.sessionId = s.session.id;
        next();
      } catch {
        next(new Error('Please log in'));
      }
    });
    io.on('connection', (socket) => {
      void auth
        .exclusive(() => {
          if (closing || !socket.connected) return;
          const wasConnected = rooms.connected(socket.data.userId);
          rooms.presence(socket.data.userId, socket.id, true);
          if (!wasConnected) trades.presence(socket.data.userId);
        })
        .then(emitViews)
        .catch(() => socket.disconnect(true));
      socket.on('disconnect', () => {
        void auth
          .exclusive(() => {
            if (closing) return;
            rooms.presence(socket.data.userId, socket.id, false);
            if (!rooms.connected(socket.data.userId)) trades.presence(socket.data.userId);
          })
          .then(emitViews)
          .catch(() => {});
      });
      for (const event of [
        'lobby:subscribe',
        'lobby:select',
        'lobby:ready',
        'lobby:unready',
        'lobby:leave',
        'battle:command',
      ])
        socket.on(event, async (input, ack) => {
          if (typeof ack !== 'function') return;
          try {
            await auth.session(socket.request.headers);
            const view = await auth.exclusive(() => {
              if (!trades.validSession(socket.data.userId, socket.data.sessionId))
                throw new BattleError('Please log in', 401);
              let view;
              if (event === 'lobby:subscribe') {
                const { roomId } = z.object({ roomId: z.string().uuid() }).strict().parse(input);
                sweepRooms();
                socket.data.roomId = roomId;
                view = rooms.view(rooms.get(roomId, socket.data.userId), socket.data.userId);
              } else {
                sweepRooms();
                trades.sweep();
                const members = rooms.active(socket.data.userId)?.members.map((m) => m.id) ?? [];
                const r = rooms.command(socket.data.userId, event, input);
                view = r ? rooms.view(r, socket.data.userId) : null;
                if (event === 'lobby:select' || event === 'lobby:leave' || r?.ended != null)
                  for (const member of members) notify(member, 'inventory:updated');
                if (event === 'lobby:leave') socket.data.roomId = undefined;
              }
              return view;
            });
            ack({ ok: true, view });
          } catch (e) {
            ack({ ok: false, error: errorMessage(e) });
          }
          await emitViews();
        });
    });
    let maintaining = false;
    const timer = setInterval(() => {
      if (maintaining || closing) return;
      maintaining = true;
      void auth
        .exclusive(() => {
          if (closing) return;
          sweepRooms();
          trades.sweep();
        })
        .then(emitViews)
        .catch((e) => {
          if (!closing) console.error('Player maintenance failed', e);
        })
        .finally(() => {
          maintaining = false;
        });
    }, 1000);
    timer.unref();
    server.on('close', () => {
      closing = true;
      clearInterval(timer);
      void auth.exclusive(() => db.close());
    });
  }
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost'),
      p = url.pathname;
    if (
      !p.startsWith('/api/auth/') &&
      !p.startsWith('/api/me') &&
      !p.startsWith('/api/lobbies') &&
      p !== '/api/catalogue' &&
      !p.startsWith('/api/friends') &&
      !p.startsWith('/api/players/') &&
      !p.startsWith('/api/trades')
    )
      return false;
    const json = (status: number, value: unknown) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.headers.origin && req.headers.origin !== origin)
        throw new BattleError('Cross-origin request rejected', 403);
      if (p.startsWith('/api/auth/')) {
        req.headers['x-trivattle-client-ip'] = req.socket.remoteAddress ?? 'unknown';
        await auth.handler(req, res);
        await emitViews();
        return true;
      }
      if (p === '/api/catalogue' && req.method === 'GET') {
        json(200, inventory.catalogue(url.searchParams));
        return true;
      }
      const s = await auth.session(req.headers),
        user = s.user;
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      await auth.exclusive(() => {
        if (!trades.validSession(user.id, s.session.id))
          throw new BattleError('Please log in', 401);
        const oldPacks = db
          .prepare('SELECT packs FROM inventory WHERE user_id=?')
          .get(user.id)?.packs;
        const me = () => ({
          id: user.id,
          name: user.name,
          friendCode: friends.profile(user.id).friendCode,
          packs: inventory.balance(user.id),
          onboarded: inventory.onboarded(user.id),
        });
        trades.sweep();
        sweepRooms();
        if (p === '/api/trades' && req.method === 'GET') {
          const page = z.coerce
            .number()
            .int()
            .min(1)
            .max(100000)
            .parse(url.searchParams.get('page') ?? 1);
          json(200, trades.list(user.id, url.searchParams.get('history') === 'true', page));
        } else if (p === '/api/trades' && req.method === 'POST') {
          friends.limited(user.id, 'trade-invite', 20);
          const v = z
            .object({ friendId: z.string().min(1).max(128), requestId: z.string().uuid() })
            .strict()
            .parse(body);
          json(200, trades.invite(user.id, v.friendId, v.requestId));
        } else if (/^\/api\/trades\/[^/]+$/.test(p)) {
          const id = z.string().uuid().parse(p.split('/')[3]);
          if (req.method === 'GET') json(200, trades.detail(user.id, id));
          else if (req.method === 'POST') {
            friends.limited(user.id, 'trade-command', 120);
            json(200, trades.command(user.id, s.session.id, id, body));
          } else throw new BattleError('Method not allowed', 405);
        } else if (p.startsWith('/api/players/by-code/') && req.method === 'GET') {
          friends.limited(user.id, 'lookup', 60);
          json(200, friends.lookup(decodeURIComponent(p.slice('/api/players/by-code/'.length))));
        } else if (p === '/api/friends' && req.method === 'GET') {
          const page = z.coerce
            .number()
            .int()
            .min(1)
            .max(100000)
            .parse(url.searchParams.get('page') ?? 1);
          json(200, friends.list(user.id, page));
        } else if (p === '/api/friends/requests' && req.method === 'POST') {
          friends.limited(user.id, 'friends');
          const v = z
            .object({ code: z.string().max(20) })
            .strict()
            .parse(body);
          json(200, friends.request(user.id, v.code));
        } else if (/^\/api\/friends\/[^/]+$/.test(p) && req.method === 'POST') {
          friends.limited(user.id, 'friends');
          const v = z
            .object({
              action: z.enum(['accept', 'decline', 'cancel', 'remove']),
              revision: z.number().int().nonnegative(),
            })
            .strict()
            .parse(body);
          json(
            200,
            friends.act(user.id, z.string().uuid().parse(p.split('/')[3]), v.action, v.revision),
          );
        } else if (p === '/api/me' && req.method === 'GET') json(200, me());
        else if (p === '/api/me/bootstrap' && req.method === 'POST') {
          inventory.bootstrap(user.id);
          json(200, me());
        } else if (p === '/api/me/collection' && req.method === 'GET')
          json(200, inventory.collection(user.id, url.searchParams));
        else if (p.startsWith('/api/me/collection/') && req.method === 'GET') {
          inventory.refresh();
          json(
            200,
            inventory.owned(user.id, decodeURIComponent(p.slice('/api/me/collection/'.length))),
          );
        } else if (p === '/api/me/packs' && req.method === 'GET')
          json(200, inventory.packInfo(user.id));
        else if (p === '/api/me/pack-openings' && req.method === 'POST') {
          z.object({}).strict().parse(body);
          const opening = inventory.open(user.id, String(req.headers['idempotency-key'] ?? ''));
          json(200, { ...opening, packStatus: inventory.packStatus(user.id) });
        } else if (p === '/api/me/pack-openings' && req.method === 'GET')
          json(200, inventory.history(user.id));
        else if (p.startsWith('/api/me/pack-openings/') && req.method === 'GET')
          json(200, inventory.opening(user.id, p.slice('/api/me/pack-openings/'.length)));
        else if (p === '/api/lobbies/current' && req.method === 'GET') {
          sweepRooms();
          const r = rooms.active(user.id);
          json(200, r ? rooms.view(r, user.id) : null);
        } else if (p === '/api/lobbies' && req.method === 'POST') {
          z.object({}).strict().parse(body);
          json(201, rooms.view(rooms.create(user), user.id));
        } else if (p === '/api/lobbies/join' && req.method === 'POST') {
          const v = z.object({ code: z.string().trim().toUpperCase() }).strict().parse(body);
          json(200, rooms.view(rooms.join(user, v.code), user.id));
        } else if (p.startsWith('/api/lobbies/') && req.method === 'GET') {
          sweepRooms();
          const parts = p.split('/');
          if (parts[4] === 'cards' && parts[5])
            json(200, rooms.details(user.id, parts[3]!, decodeURIComponent(parts[5])));
          else if (parts.length === 4)
            json(200, rooms.view(rooms.get(parts[3]!, user.id), user.id));
          else throw new BattleError('Not found', 404);
        } else throw new BattleError('Endpoint not found', 404);
        if (
          db.prepare('SELECT packs FROM inventory WHERE user_id=?').get(user.id)?.packs !== oldPacks
        )
          notify(user.id, 'inventory:updated');
      });
      if (
        notifications.size ||
        friends.dirty.size ||
        trades.dirty.size ||
        trades.inventoryDirty.size
      )
        await emitViews();
    } catch (e) {
      if (!res.headersSent)
        json(e instanceof BattleError ? e.status : e instanceof z.ZodError ? 400 : 500, {
          error: errorMessage(e),
        });
    }
    if (friends.dirty.size || trades.dirty.size || trades.inventoryDirty.size) await emitViews();
    return true;
  }
  return {
    handle,
    attach,
    auth,
    inventory,
    friends,
    trades,
    rooms,
    db,
    disconnect: () => io?.disconnectSockets(true),
    close: () => {
      closing = true;
      io?.close();
    },
  };
}
export type Application = Awaited<ReturnType<typeof createApplication>>;
