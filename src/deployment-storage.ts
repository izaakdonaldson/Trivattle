import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, linkSync, rmSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { z } from 'zod';
import { playable } from './battle/catalogue.js';
import { cardSchema, questionSchema, sourceSchema, rarities } from './domain.js';
import type { Config } from './config.js';
import type { Catalogue } from './store.js';

export function verifyCatalogue(path: string, config: Config, weights: readonly number[]) {
  const bytes = readFileSync(path);
  const data = z
    .object({
      schemaVersion: z.literal(1),
      cards: z.record(z.string(), cardSchema),
      sources: z.record(z.string(), sourceSchema),
      questions: z.record(z.string(), questionSchema),
      published: z.record(z.string(), z.string()),
      quarantined: z.record(z.string(), z.string()).default({}),
    })
    .passthrough()
    .parse(JSON.parse(bytes.toString('utf8'))) as Catalogue;
  for (const [id, version] of Object.entries(data.published)) {
    if (
      !data.cards[version] ||
      data.cards[version]!.id !== id ||
      data.cards[version]!.versionId !== version
    )
      throw Error('Invalid published card reference');
  }
  const cards = playable({ data }, config);
  const expected = Object.values(data.published).filter((id) => !data.quarantined[id]).length;
  if (!cards.length || cards.length !== expected)
    throw Error('Published catalogue contains unplayable cards');
  const counts = Object.fromEntries(
    rarities.map((rarity) => [rarity, cards.filter((c) => c.rarity === rarity).length]),
  );
  if (rarities.some((rarity, i) => weights[i]! > 0 && !counts[rarity]))
    throw Error('Missing required rarity pool');
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    playable: cards.length,
    rarities: counts,
  };
}

/** Read the live database through SQLite, including committed WAL content. Never overwrite a backup. */
export async function backupDatabase(source: string, destination: string) {
  const target = resolve(destination);
  if (target === resolve(source)) throw Error('Backup destination must differ from source');
  const db = new DatabaseSync(source, { readOnly: true });
  const temporary = target + '.' + randomUUID() + '.tmp';
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    await backup(db, temporary);
    chmodSync(temporary, 0o600);
    // Hard-link publication fails if destination already exists, including symlinks.
    linkSync(temporary, target);
  } finally {
    db.close();
    rmSync(temporary, { force: true });
  }
}
