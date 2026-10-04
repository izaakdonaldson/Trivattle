import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
export function openDatabase(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user'").get()) {
    transaction(db, () =>
      db.exec(readFileSync(new URL('../../migrations/000-auth.sql', import.meta.url), 'utf8')),
    );
  }
  return db;
}
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
export function migrate(db: DatabaseSync) {
  db.exec('CREATE TABLE IF NOT EXISTS app_migrations (version INTEGER PRIMARY KEY)');
  for (const [index, file] of [
    '001-player.sql',
    '002-pack-regen.sql',
    '003-friends.sql',
    '004-trades.sql',
  ].entries()) {
    const version = index + 1;
    if (db.prepare('SELECT version FROM app_migrations WHERE version=?').get(version)) continue;
    transaction(db, () => {
      db.exec(readFileSync(new URL('../../migrations/' + file, import.meta.url), 'utf8'));
      db.prepare('INSERT INTO app_migrations VALUES (?)').run(version);
    });
  }
}
