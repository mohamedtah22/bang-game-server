import type { Player } from "./player";

export type Room = {
  code: string;
  players: Player[];
  ready: boolean;
  maxPlayers: number;

  // ✅ لازم
  phase?: "main" | "waiting";
  pending?: any;
  pendingEndsAt?: number;

  // ✅ لحساب عدد bang بالدور
  bangsUsedThisTurn?: number;
};

