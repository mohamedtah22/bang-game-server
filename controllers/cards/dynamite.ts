import type { PlayCardFn } from "./types";
import { broadcastCardPlayed, broadcastGameState, broadcastMeStates } from "../engine/broadcast";
import { equipmentHas, maybeSuzyDraw } from "../engine/runtime";

export const playDynamite: PlayCardFn = (room, me, payload, card) => {
  if (payload.targetId && payload.targetId !== me.id) throw new Error("Dynamite is played on yourself");
  broadcastCardPlayed(room, {
    action: "play",
    playerId: me.id,
    cardKey: "dynamite",
    cardId: (card as any).id,
    targetId: me.id,
  });
  if (equipmentHas(me, "dynamite")) throw new Error("You already have Dynamite");
  me.equipment.push(card);
  maybeSuzyDraw(room, me);
  broadcastGameState(room);
  broadcastMeStates(room);
};

