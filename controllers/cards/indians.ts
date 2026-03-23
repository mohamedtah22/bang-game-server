import type { PlayCardFn } from "./types";
import { broadcastCardPlayed, broadcastRoom } from "../engine/broadcast";
import { discard, maybeSuzyDraw } from "../engine/runtime";
import { buildOtherPlayersOrder, continueIndians } from "../engine/turn";

export const playIndians: PlayCardFn = (room, me, payload, card) => {
  broadcastCardPlayed(room, { action: "play", playerId: me.id, cardKey: "indians", cardId: (card as any).id });

  discard(room, card);

  const targets = buildOtherPlayersOrder(room, me.id);

  room.pending = { kind: "indians", attackerId: me.id, targets, idx: 0 };
  room.phase = "waiting";
  room.pendingEndsAt = Date.now() + 40_000; // RESPONSE_MS

  broadcastRoom(room, { type: "action_resolved", roomCode: room.code, kind: "indians_start", attackerId: me.id });

  maybeSuzyDraw(room, me);
  continueIndians(room);
};

