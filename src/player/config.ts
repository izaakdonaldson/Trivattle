import { z } from 'zod';
export const playerConfigSchema = z.object({
  starterPacks: z.number().int().min(0).default(3),
  weights: z
    .tuple([z.number(), z.number(), z.number(), z.number(), z.number()])
    .refine(
      (a) =>
        a.every((x) => Number.isSafeInteger(x) && x >= 0) &&
        a.reduce((s, x) => s + x, 0) > 0 &&
        a.reduce((s, x) => s + x, 0) < 2 ** 48,
    )
    .default([55, 28, 12, 4, 1]),
  emptyPool: z.enum(['reject', 'renormalize']).default('reject'),
  reconnectMs: z.number().int().positive().default(120000),
  lobbyIdleMs: z.number().int().positive().default(1800000),
  battleIdleMs: z.number().int().positive().default(7200000),
  retentionMs: z.number().int().positive().default(600000),
});
export type PlayerConfig = z.infer<typeof playerConfigSchema>;
export function playerConfig() {
  return playerConfigSchema.parse({
    starterPacks: process.env.STARTER_PACKS ? Number(process.env.STARTER_PACKS) : undefined,
    weights: process.env.PACK_WEIGHTS ? JSON.parse(process.env.PACK_WEIGHTS) : undefined,
    emptyPool: process.env.PACK_EMPTY_POOL,
    reconnectMs: process.env.RECONNECT_MS ? Number(process.env.RECONNECT_MS) : undefined,
    lobbyIdleMs: process.env.LOBBY_IDLE_MS ? Number(process.env.LOBBY_IDLE_MS) : undefined,
    battleIdleMs: process.env.BATTLE_IDLE_MS ? Number(process.env.BATTLE_IDLE_MS) : undefined,
  });
}
