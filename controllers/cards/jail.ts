import type { PlayCardFn } from "./types";
import { broadcastCardPlayed, broadcastGameState, broadcastMeStates, broadcastRoom } from "../engine/broadcast";
import { discard, takeEquipment, maybeSuzyDraw } from "../engine/runtime";
import { getPlayer } from "../engine/players";

export const playJail: PlayCardFn = (room, me, payload, card) => {
  if (!payload.targetId) throw new Error("Missing targetId");
  const target = getPlayer(room, payload.targetId);
  if (!target || !target.isAlive) throw new Error("Bad target");
  if (target.id === me.id) throw new Error("Can't jail yourself");
  if (target.role === "sheriff") throw new Error("Can't jail the Sheriff");

  broadcastCardPlayed(room, {
    action: "play",
    playerId: me.id,
    cardKey: "jail",
    cardId: (card as any).id,
    targetId: target.id,
  });

  const old = takeEquipment(target, "jail");
  if (old) discard(room, old);

  target.equipment.push(card);

  broadcastRoom(room, {
    type: "action_resolved",
    roomCode: room.code,
    kind: "jail_set",
    fromPlayerId: me.id,
    targetId: target.id,
  });

  maybeSuzyDraw(room, me);
  broadcastGameState(room);
  broadcastMeStates(room);
};

