import 'dotenv/config';
import { backupDatabase } from '../src/deployment-storage.js';
try {
  const destination = process.argv[2];
  if (!destination || process.argv.length !== 3) throw Error('Missing destination');
  await backupDatabase(process.env.PLAYER_DB || 'data/player/player.sqlite', destination);
  console.log('Consistent SQLite backup complete. Download it with the matching catalogue.');
} catch {
  console.error(
    'Backup failed. Supply a new destination path; check source database, permissions, and available disk space. Existing backups are never overwritten.',
  );
  process.exitCode = 1;
}
