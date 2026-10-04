import type { CardView, BattleView } from '../battle/types.js';
export type Owned = {
  reservedTradeId?: string | null;
  battleCommitted?: boolean;
  id: string;
  versionId: string;
  acquiredAt: string;
  source: string;
  card: CardView | null;
  playable: boolean;
  quantity: number;
};
export type Collection = {
  cards: Owned[];
  total: number;
  copies: number;
  page: number;
  pageSize: number;
};
export type PackStatus = {
  packs: number;
  capacity: number;
  intervalMs: number;
  serverTime: number;
  nextPackAt: number | null;
};
export type PackInfo = PackStatus & {
  available: boolean;
  missing: string[];
  policy: string;
  odds: Record<string, number>;
};
export type Opening = { id: string; cards: Owned[]; packStatus?: PackStatus };
export type Me = {
  friendCode: string;
  id: string;
  name: string;
  packs: number;
  onboarded: boolean;
};
export type LobbyView = {
  id: string;
  code: string;
  revision: number;
  status:
    'waiting' | 'selecting' | 'ready-to-start' | 'in-battle' | 'finished' | 'abandoned' | 'expired';
  self: string;
  players: { slot: string; name: string; ready: boolean; connected: boolean }[];
  selection: (Owned | null)[];
  paused: boolean;
  reconnectDeadline: number | null;
  announcementUntil: number;
  battle: BattleView | null;
};
export type Reply = { ok: true; view: LobbyView | null } | { ok: false; error: string };
