import type { PlayCardFn } from "./types";
import { broadcastCardPlayed, broadcastGameState, broadcastMeStates, broadcastRoom } from "../engine/broadcast";
import { discard, takeEquipment, maybeSuzyDraw } from "../engine/runtime";
import { getPlayer, isTargetablePlayer } from "../engine/players";

export const playJail: PlayCardFn = (room, me, payload, card) => {
  if (!payload.targetId) throw new Error("Missing targetId");
  const target = getPlayer(room, payload.targetId);
  if (!isTargetablePlayer(target)) throw new Error("Target is unavailable");
  const targetPlayer = target as any;
  if (targetPlayer.id === me.id) throw new Error("Can't jail yourself");
  if (targetPlayer.role === "sheriff") throw new Error("Can't jail the Sheriff");

  broadcastCardPlayed(room, {
    action: "play",
    playerId: me.id,
    cardKey: "jail",
    cardId: (card as any).id,
    targetId: targetPlayer.id,
  });

  const old = takeEquipment(targetPlayer, "jail");
  if (old) discard(room, old);

  targetPlayer.equipment.push(card);

  broadcastRoom(room, {
    type: "action_resolved",
    roomCode: room.code,
    kind: "jail_set",
    fromPlayerId: me.id,
    targetId: targetPlayer.id,
  });

  maybeSuzyDraw(room, me);
  broadcastGameState(room);
  broadcastMeStates(room);
};

