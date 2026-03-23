import type { PlayCardFn } from "./types";
import { broadcastCardPlayed, broadcastGameState, broadcastMeStates } from "../engine/broadcast";
import { replaceUniqueEquipment, maybeSuzyDraw } from "../engine/runtime";

export const playScope: PlayCardFn = (room, me, payload, card) => {
  broadcastCardPlayed(room, { action: "play", playerId: me.id, cardKey: "scope", cardId: (card as any).id });
  replaceUniqueEquipment(room, me, "scope", card);
  maybeSuzyDraw(room, me);
  broadcastGameState(room);
  broadcastMeStates(room);
};

