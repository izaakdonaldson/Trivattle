import { createServer, type IncomingMessage } from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CatalogueStore, type Catalogue } from '../store.js';
import { loadConfig, type Config } from '../config.js';
import { playable, pin, cardView } from './catalogue.js';
import {
  applyCommand,
  createBattle,
  publicBattle,
  BattleError,
  type BattleState,
} from './engine.js';
const setupSchema = z.union([
  z.object({ quickStart: z.literal(true) }).strict(),
  z
    .object({ teams: z.tuple([z.array(z.string()).length(5), z.array(z.string()).length(5)]) })
    .strict(),
]);
async function body(req: IncomingMessage) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 16384) throw new BattleError('Request too large', 413);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BattleError('Invalid JSON', 400);
  }
}
export function battleServer(
  options: {
    store?: CatalogueStore;
    config?: Config;
    choose?: (n: number) => number;
    now?: () => number;
    webRoot?: string;
  } = {},
) {
  const store =
      options.store ?? new CatalogueStore(process.env.CARD_DATA_DIR ?? 'data/catalogue', true),
    config = options.config ?? loadConfig();
  const choose = options.choose ?? randomInt,
    now = options.now ?? Date.now;
  const matches = new Map<string, { state: BattleState; data: Catalogue; touched: number }>();
  let cards = playable(store, config);
  const stamp = () => {
    try {
      const stat = statSync(store.path);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return 'missing';
    }
  };
  let lastStamp = stamp();
  function refreshCards() {
    const nextStamp = stamp();
    if (nextStamp !== lastStamp) {
      store.refresh();
      cards = playable(store, config);
      lastStamp = nextStamp;
    }
  }
  const server = createServer(async (req, res) => {
    const json = (status: number, value: unknown) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      for (const [id, match] of matches) if (now() - match.touched > 7200000) matches.delete(id);
      if (url.pathname.startsWith('/api/')) {
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)
          throw new BattleError('Cross-origin request rejected', 403);
        if (url.pathname === '/api/cards' && req.method === 'GET') {
          refreshCards();
          const q = (url.searchParams.get('q') ?? '').toLowerCase();
          const filtered = cards
            .filter(
              (c) =>
                c.name.toLowerCase().includes(q) &&
                (!url.searchParams.get('type') || c.type === url.searchParams.get('type')) &&
                (!url.searchParams.get('rarity') || c.rarity === url.searchParams.get('rarity')),
            )
            .sort((a, b) => a.name.localeCompare(b.name));
          const page = Math.max(1, Math.floor(Number(url.searchParams.get('page')) || 1)),
            pageSize = 20;
          json(200, {
            cards: filtered
              .slice((page - 1) * pageSize, page * pageSize)
              .map((c) => cardView(c, store.data)),
            total: filtered.length,
            page,
            pageSize,
          });
          return;
        }
        if (url.pathname === '/api/battles' && req.method === 'POST') {
          const setup = setupSchema.parse(await body(req));
          refreshCards();
          let ids: [string[], string[]];
          if ('quickStart' in setup) {
            if (cards.length < 10)
              throw new BattleError(
                'Quick start needs ten published cards with complete validated trivia. Choose duplicate cards manually or finish catalogue generation.',
                422,
              );
            const pool = [...cards],
              selected = [];
            for (let i = 0; i < 10; i++)
              selected.push(pool.splice(choose(pool.length), 1)[0]!.versionId);
            ids = [selected.slice(0, 5), selected.slice(5)];
          } else ids = setup.teams;
          const teams = ids.map((team) =>
            team.map((id) => {
              const c = cards.find((c) => c.versionId === id || c.id === id);
              if (!c)
                throw new BattleError(
                  'A selected card is no longer playable. Refresh the catalogue.',
                  422,
                );
              return c;
            }),
          ) as Parameters<typeof createBattle>[1];
          const data = pin(store, teams.flat()),
            state = createBattle(randomUUID(), teams, config);
          matches.set(state.id, { state, data, touched: now() });
          json(201, publicBattle(state, data));
          return;
        }
        const details = /^\/api\/battles\/([^/]+)\/cards\/([^/]+)$/.exec(url.pathname);
        if (details && req.method === 'GET') {
          const match = matches.get(details[1]!);
          if (!match)
            throw new BattleError('Battle expired or server restarted. Start a new battle.', 404);
          const unit = match.state.teams
            .flat()
            .find((c) => c.instanceId === decodeURIComponent(details[2]!));
          if (!unit) throw new BattleError('Card not found', 404);
          const view = cardView(unit.card, match.data);
          const mayRead =
            match.state.phase === 'SELECTING_ATTACK' &&
            url.searchParams.get('playerId') === match.state.currentPlayer &&
            unit.playerId === match.state.currentPlayer;
          json(200, mayRead ? view : { ...view, summary: undefined, url: undefined });
          return;
        }
        const route = /^\/api\/battles\/([^/]+)(\/commands)?$/.exec(url.pathname);
        if (route) {
          const match = matches.get(route[1]!);
          if (!match)
            throw new BattleError('Battle expired or server restarted. Start a new battle.', 404);
          if (req.method === 'POST' && route[2]) {
            const input = await body(req);
            match.state = applyCommand(match.state, input, match.data, choose);
          } else if (req.method !== 'GET' || route[2])
            throw new BattleError('Method not allowed', 405);
          match.touched = now();
          json(200, publicBattle(match.state, match.data));
          return;
        }
        throw new BattleError('Endpoint not found', 404);
      }
      if (req.method !== 'GET') throw new BattleError('Method not allowed', 405);
      const path = decodeURIComponent(url.pathname);
      let file: string;
      if (['/images/type_icons.png', '/images/type_images.png'].includes(path))
        file = resolve('images', path.split('/').at(-1)!);
      else {
        const root = resolve(options.webRoot ?? 'dist/web');
        file = resolve(root, path === '/' ? 'index.html' : '.' + path);
        if (!file.startsWith(root + '/')) throw new BattleError('Not found', 404);
      }
      const content = await readFile(file).catch(() => {
        throw new BattleError('Not found. Build the frontend with npm run build.', 404);
      });
      res.writeHead(200, {
        'Content-Type':
          (
            {
              '.html': 'text/html',
              '.js': 'text/javascript',
              '.css': 'text/css',
              '.png': 'image/png',
              '.svg': 'image/svg+xml',
            } as Record<string, string>
          )[extname(file)] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(content);
    } catch (error) {
      json(error instanceof BattleError ? error.status : error instanceof z.ZodError ? 400 : 500, {
        error:
          error instanceof BattleError
            ? error.message
            : error instanceof z.ZodError
              ? 'Invalid request fields'
              : 'Unable to complete request',
      });
    }
  });
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3001);
  battleServer().listen(port, '127.0.0.1', () =>
    console.log(`Trivattle: http://localhost:${port}`),
  );
}
