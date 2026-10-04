import { readFileSync } from 'node:fs';
import { z } from 'zod';
// Presentation-era match pacing is separate from generation/balance hashes.
export const battlePacing = z
  .object({ hpMultiplier: z.number().positive().max(1) })
  .parse(JSON.parse(readFileSync(new URL('../../config/battle.json', import.meta.url), 'utf8')));
