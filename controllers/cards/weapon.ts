import type { PlayCardFn } from "./types";
import { broadcastCardPlayed, broadcastGameState, broadcastMeStates } from "../engine/broadcast";
import { replaceUniqueEquipment, maybeSuzyDraw, ensureCardMeta } from "../engine/runtime";

export const playWeapon: PlayCardFn = (room, me, payload, card) => {
  const weaponName = String((card as any).weaponKey ?? (card as any).weaponName ?? (card as any).name ?? "").trim();
  const weaponKey = weaponName || undefined;

  broadcastCardPlayed(room, {
    action: "play",
    playerId: me.id,
    cardKey: "weapon",
    cardId: (card as any).id,
    weaponKey,
    weaponName: weaponName || undefined,
    card: ensureCardMeta(card),
  });

  replaceUniqueEquipment(room, me, "weapon", card);
  maybeSuzyDraw(room, me);
  broadcastGameState(room);
  broadcastMeStates(room);
};
