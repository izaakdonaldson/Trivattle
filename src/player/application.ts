import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { z } from 'zod';
import { openDatabase, migrate } from './database.js';
import { createAuth } from './auth.js';
import { Inventory } from './inventory.js';
import { playerConfig, type PlayerConfig } from './config.js';
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
  let io: Server | undefined;
  const origin = new URL(options.baseURL).origin;
  async function emitViews() {
    if (!io) return;
    for (const socket of io.sockets.sockets.values()) {
      try {
        await auth.session(socket.request.headers);
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
      rooms.presence(socket.data.userId, socket.id, true);
      void emitViews();
      socket.on('disconnect', () => {
        rooms.presence(socket.data.userId, socket.id, false);
        void emitViews();
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
            let view;
            if (event === 'lobby:subscribe') {
              const { roomId } = z.object({ roomId: z.string().uuid() }).strict().parse(input);
              rooms.sweep();
              socket.data.roomId = roomId;
              view = rooms.view(rooms.get(roomId, socket.data.userId), socket.data.userId);
            } else {
              const r = rooms.command(socket.data.userId, event, input);
              view = r ? rooms.view(r, socket.data.userId) : null;
              if (event === 'lobby:leave') socket.data.roomId = undefined;
            }
            ack({ ok: true, view });
          } catch (e) {
            ack({ ok: false, error: errorMessage(e) });
          }
          await emitViews();
        });
    });
    const timer = setInterval(() => {
      rooms.sweep();
      void emitViews();
    }, 1000);
    timer.unref();
    server.on('close', () => {
      clearInterval(timer);
      db.close();
    });
  }
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost'),
      p = url.pathname;
    if (
      !p.startsWith('/api/auth/') &&
      !p.startsWith('/api/me') &&
      !p.startsWith('/api/lobbies') &&
      p !== '/api/catalogue'
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
      const me = () => ({
        id: user.id,
        name: user.name,
        packs: inventory.balance(user.id),
        onboarded: inventory.onboarded(user.id),
      });
      if (p === '/api/me' && req.method === 'GET') json(200, me());
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
        z.object({})
          .strict()
          .parse(await readBody(req));
        json(200, inventory.open(user.id, String(req.headers['idempotency-key'] ?? '')));
      } else if (p === '/api/me/pack-openings' && req.method === 'GET')
        json(200, inventory.history(user.id));
      else if (p.startsWith('/api/me/pack-openings/') && req.method === 'GET')
        json(200, inventory.opening(user.id, p.slice('/api/me/pack-openings/'.length)));
      else if (p === '/api/lobbies/current' && req.method === 'GET') {
        rooms.sweep();
        const r = rooms.active(user.id);
        json(200, r ? rooms.view(r, user.id) : null);
      } else if (p === '/api/lobbies' && req.method === 'POST') {
        z.object({})
          .strict()
          .parse(await readBody(req));
        json(201, rooms.view(rooms.create(user), user.id));
        await emitViews();
      } else if (p === '/api/lobbies/join' && req.method === 'POST') {
        const v = z
          .object({ code: z.string().trim().toUpperCase() })
          .strict()
          .parse(await readBody(req));
        json(200, rooms.view(rooms.join(user, v.code), user.id));
        await emitViews();
      } else if (p.startsWith('/api/lobbies/') && req.method === 'GET') {
        rooms.sweep();
        const parts = p.split('/');
        if (parts[4] === 'cards' && parts[5])
          json(200, rooms.details(user.id, parts[3]!, decodeURIComponent(parts[5])));
        else if (parts.length === 4) json(200, rooms.view(rooms.get(parts[3]!, user.id), user.id));
        else throw new BattleError('Not found', 404);
      } else throw new BattleError('Endpoint not found', 404);
    } catch (e) {
      if (!res.headersSent)
        json(e instanceof BattleError ? e.status : e instanceof z.ZodError ? 400 : 500, {
          error: errorMessage(e),
        });
    }
    return true;
  }
  return {
    handle,
    attach,
    auth,
    inventory,
    rooms,
    db,
    disconnect: () => io?.disconnectSockets(true),
    close: () => io?.close(),
  };
}
export type Application = Awaited<ReturnType<typeof createApplication>>;
