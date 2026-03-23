import type { PlayCardFn } from "./types";
import { broadcastCardPlayed, broadcastGameState, broadcastMeStates } from "../engine/broadcast";
import { replaceUniqueEquipment, maybeSuzyDraw } from "../engine/runtime";

export const playMustang: PlayCardFn = (room, me, payload, card) => {
  broadcastCardPlayed(room, { action: "play", playerId: me.id, cardKey: "mustang", cardId: (card as any).id });
  replaceUniqueEquipment(room, me, "mustang", card);
  maybeSuzyDraw(room, me);
  broadcastGameState(room);
  broadcastMeStates(room);
};

