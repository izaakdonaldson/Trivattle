import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { playerConfig } from '../src/player/config.js';
import { verifyCatalogue } from '../src/deployment-storage.js';
try {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) throw Error('Missing path');
  console.log(JSON.stringify(verifyCatalogue(path, loadConfig(), playerConfig().weights), null, 2));
} catch {
  console.error(
    'Catalogue verification failed. Supply one readable catalogue JSON path and check its schema, references, playable cards and rarity pools. No files were changed.',
  );
  process.exitCode = 1;
}
