import type { PlayCardFn } from "./types";
import { broadcastCardPlayed, broadcastRoom } from "../engine/broadcast";
import { discard } from "../engine/runtime";
import { getPlayer } from "../engine/players";
import { promptDuel } from "../engine/turn";
import type { PendingBase } from "../engine/types";

export const playDuel: PlayCardFn = (room, me, payload, card) => {
  if (!payload.targetId) throw new Error("Missing targetId");
  const target = getPlayer(room, payload.targetId);
  if (!target || !target.isAlive) throw new Error("Bad target");
  if (target.id === me.id) throw new Error("Can't duel yourself");

  broadcastCardPlayed(room, { action: "play", playerId: me.id, cardKey: "duel", cardId: (card as any).id, targetId: target.id });

  discard(room, card);

  const pend: Extract<PendingBase, { kind: "duel" }> = {
    kind: "duel",
    initiatorId: me.id,
    targetId: target.id,
    responderId: target.id,
  };

  room.pending = pend;
  room.phase = "waiting";
  room.pendingEndsAt = Date.now() + 40_000; // RESPONSE_MS

  broadcastRoom(room, { type: "action_resolved", roomCode: room.code, kind: "duel_start", initiatorId: me.id, targetId: target.id });

  promptDuel(room, pend);
};

