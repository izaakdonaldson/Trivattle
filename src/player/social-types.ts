import type { Owned } from './types.js';
export type PublicPlayer = { id: string; name: string; friendCode: string };
export type Friendship = {
  id: string;
  player: PublicPlayer;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'REMOVED';
  incoming: boolean;
  revision: number;
};
export type FriendList = { items: Friendship[]; total: number; page: number; pageSize: number };
export type TradeState =
  'INVITED' | 'NEGOTIATING' | 'SETTLING' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';
export type TradeView = {
  id: string;
  state: TradeState;
  revision: number;
  offerRevision: number;
  expiresAt: number;
  completedAt: number | null;
  createdAt: number;
  serverTime: number;
  self: string;
  invitedBy: string;
  error: string | null;
  players: { player: PublicPlayer; connected: boolean; confirmed: boolean; cards: Owned[] }[];
};
export type TradeList = { items: TradeView[]; total: number; page: number; pageSize: number };
