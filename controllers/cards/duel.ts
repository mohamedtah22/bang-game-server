import type { PlayCardFn } from "./types";
import { broadcastCardPlayed, broadcastRoom } from "../engine/broadcast";
import { discard, maybeSuzyDraw } from "../engine/runtime";
import { getPlayer, isTargetablePlayer } from "../engine/players";
import { promptDuel } from "../engine/turn";
import type { PendingBase } from "../engine/types";

export const playDuel: PlayCardFn = (room, me, payload, card) => {
  if (!payload.targetId) throw new Error("Missing targetId");
  const target = getPlayer(room, payload.targetId);
  if (!isTargetablePlayer(target)) throw new Error("Target is unavailable");
  const targetPlayer = target as any;
  if (targetPlayer.id === me.id) throw new Error("Can't duel yourself");

  broadcastCardPlayed(room, {
    action: "play",
    playerId: me.id,
    cardKey: "duel",
    cardId: (card as any).id,
    targetId: targetPlayer.id,
  });

  discard(room, card);
  maybeSuzyDraw(room, me);

  const pend: Extract<PendingBase, { kind: "duel" }> = {
    kind: "duel",
    initiatorId: me.id,
    targetId: targetPlayer.id,
    responderId: targetPlayer.id,
  };

  room.pending = pend;
  room.phase = "waiting";
  room.pendingEndsAt = Date.now() + 40_000;

  broadcastRoom(room, {
    type: "action_resolved",
    roomCode: room.code,
    kind: "duel_start",
    initiatorId: me.id,
    targetId: targetPlayer.id,
  });

  promptDuel(room, pend);
};