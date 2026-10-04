import { betterAuth } from 'better-auth';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { getMigrations } from 'better-auth/db/migration';
import type { IncomingHttpHeaders } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { BattleError } from '../battle/engine.js';
export function createAuth(db: DatabaseSync, baseURL: string, secret: string) {
  if (secret.length < 32) throw Error('BETTER_AUTH_SECRET must contain at least 32 characters');
  const auth = betterAuth({
    database: db,
    baseURL,
    secret,
    trustedOrigins: [new URL(baseURL).origin],
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    session: { cookieCache: { enabled: false } },
    rateLimit: { enabled: true },
    advanced: { ipAddress: { ipAddressHeaders: ['x-trivattle-client-ip'] } },
  });
  return {
    auth,
    handler: toNodeHandler(auth),
    async migrate() {
      const m = await getMigrations(auth.options);
      await m.runMigrations();
    },
    async session(headers: IncomingHttpHeaders) {
      const s = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
      if (!s) throw new BattleError('Please log in', 401);
      return s;
    },
  };
}
export type Auth = ReturnType<typeof createAuth>;
