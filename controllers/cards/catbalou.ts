import type { PlayCardFn } from "./types";
import { broadcastCardPlayed, broadcastGameState, broadcastMeStates, broadcastRoom } from "../engine/broadcast";
import { discard, maybeSuzyDraw } from "../engine/runtime";
import { getPlayer } from "../engine/players";
import { normalizeMaybeId, normalizeMaybeIndex } from "../engine/utils";

export const playCatBalou: PlayCardFn = (room, me, payload, card) => {
  if (!payload.targetId) throw new Error("Missing targetId");
  const target = getPlayer(room, payload.targetId);
  if (!target || !target.isAlive) throw new Error("Bad target");

  broadcastCardPlayed(room, {
    action: "play",
    playerId: me.id,
    cardKey: "catbalou",
    cardId: (card as any).id,
    targetId: target.id,
  });

  discard(room, card);

  const chosenEquipId = normalizeMaybeId(payload.targetCardId);
  const wantsHand =
    payload.pickHand === true ||
    String(payload.targetZone ?? "").toLowerCase() === "hand" ||
    normalizeMaybeIndex(payload.targetHandIndex) !== null; // backward-compat trigger ONLY

  let removed: any = null;
  let fromZone: "hand" | "equipment" | "none" = "none";

  // 1) explicit equipment pick
  if (chosenEquipId) {
    const ix = target.equipment.findIndex((c) => String((c as any).id) === String(chosenEquipId));
    if (ix < 0) throw new Error("Card not available (equipment)");
    const [c] = target.equipment.splice(ix, 1);
    removed = c ?? null;
    fromZone = removed ? "equipment" : "none";
  }
  // 2) hand => RANDOM by server
  else if (wantsHand) {
    if (target.hand.length === 0) {
      // fallback: if no hand, try random equipment
      if (target.equipment.length === 0) removed = null;
      else {
        const j = Math.floor(Math.random() * target.equipment.length);
        const [c] = target.equipment.splice(j, 1);
        removed = c ?? null;
        fromZone = removed ? "equipment" : "none";
      }
    } else {
      const j = Math.floor(Math.random() * target.hand.length);
      const [c] = target.hand.splice(j, 1);
      removed = c ?? null;
      fromZone = removed ? "hand" : "none";
    }
  }
  // 3) no choice provided => old fallback behavior
  else {
    if (target.hand.length > 0) {
      const j = Math.floor(Math.random() * target.hand.length);
      const [c] = target.hand.splice(j, 1);
      removed = c ?? null;
      fromZone = removed ? "hand" : "none";
    } else if (target.equipment.length > 0) {
      const j = Math.floor(Math.random() * target.equipment.length);
      const [c] = target.equipment.splice(j, 1);
      removed = c ?? null;
      fromZone = removed ? "equipment" : "none";
    }
  }

  if (removed) discard(room, removed);

  maybeSuzyDraw(room, target);
  maybeSuzyDraw(room, me);

  broadcastRoom(room, {
    type: "catbalou_resolved",
    roomCode: room.code,
    ts: Date.now(),
    fromPlayerId: me.id,
    targetId: target.id,
    fromZone,
    // ✅ Cat Balou always reveals because the discarded card goes face-up to discard pile
    revealedCard: removed ? removed : null,
  });

  broadcastGameState(room);
  broadcastMeStates(room);
};