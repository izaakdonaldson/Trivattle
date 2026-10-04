import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { CatalogueStore } from '../src/store.js';
import { card, cfg, source, questions } from './helpers.js';
import { openDatabase, migrate } from '../src/player/database.js';
import { createAuth } from '../src/player/auth.js';
import { Inventory } from '../src/player/inventory.js';
import { playerConfigSchema } from '../src/player/config.js';
export async function playerFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'trivattle-player-'));
  const store = new CatalogueStore(join(dir, 'catalogue'));
  for (let i = 1; i <= 15; i++) {
    const c = card(
      i <= 5 ? 'common' : (['common', 'uncommon', 'rare', 'epic', 'legendary'] as const)[i % 5]!,
      i,
    );
    c.status = 'published';
    store.data.cards[c.versionId] = c;
    store.data.published[c.id] = c.versionId;
    const s = source(i);
    store.data.sources[c.sourceKey] = s;
    for (const q of questions(s)) store.data.questions[q.id] = q;
  }
  store.save();
  const path = join(dir, 'player.sqlite'),
    db = openDatabase(path);
  const auth = createAuth(db, 'http://localhost:3102', 'testing-secret-123456789012345678901234');
  await auth.migrate();
  migrate(db);
  const settings = playerConfigSchema.parse({});
  const inventory = new Inventory(
    db,
    store,
    cfg(),
    settings,
    () => {},
    () => 0,
  );
  let n = 0;
  const user = async () =>
    (
      await auth.auth.api.signUpEmail({
        body: { email: `player${++n}@example.com`, password: 'password123', name: `Player ${n}` },
      })
    ).user.id;
  return {
    dir,
    path,
    db,
    auth,
    inventory,
    store,
    settings,
    user,
    clean() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
