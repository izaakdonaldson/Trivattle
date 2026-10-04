import 'dotenv/config';
import { openDatabase, migrate } from '../src/player/database.js';
import { createAuth } from '../src/player/auth.js';
const db = openDatabase(process.env.PLAYER_DB ?? 'data/player/player.sqlite');
const auth = createAuth(
  db,
  process.env.BETTER_AUTH_URL ?? 'http://localhost:5173',
  process.env.BETTER_AUTH_SECRET ?? '',
);
await auth.migrate();
migrate(db);
db.close();
console.log('Database migrations complete.');
