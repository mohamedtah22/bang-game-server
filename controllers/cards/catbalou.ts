import type { PlayCardFn } from "./types";
import { broadcastCardPlayed, broadcastGameState, broadcastMeStates, broadcastRoom } from "../engine/broadcast";
import { discard, maybeSuzyDraw } from "../engine/runtime";
import { getPlayer, isTargetablePlayer } from "../engine/players";
import { normalizeMaybeId, normalizeMaybeIndex } from "../engine/utils";

export const playCatBalou: PlayCardFn = (room, me, payload, card) => {
  if (!payload.targetId) throw new Error("Missing targetId");
  const target = getPlayer(room, payload.targetId);
  if (!isTargetablePlayer(target)) throw new Error("Target is unavailable");
  const targetPlayer = target as any;

  broadcastCardPlayed(room, {
    action: "play",
    playerId: me.id,
    cardKey: "catbalou",
    cardId: (card as any).id,
    targetId: targetPlayer.id,
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
    const ix = targetPlayer.equipment.findIndex((c: any) => String((c as any).id) === String(chosenEquipId));
    if (ix < 0) throw new Error("Card not available (equipment)");
    const [c] = targetPlayer.equipment.splice(ix, 1);
    removed = c ?? null;
    fromZone = removed ? "equipment" : "none";
  }
  // 2) hand => RANDOM by server
  else if (wantsHand) {
    if (targetPlayer.hand.length === 0) {
      // fallback: if no hand, try random equipment
      if (targetPlayer.equipment.length === 0) removed = null;
      else {
        const j = Math.floor(Math.random() * targetPlayer.equipment.length);
        const [c] = targetPlayer.equipment.splice(j, 1);
        removed = c ?? null;
        fromZone = removed ? "equipment" : "none";
      }
    } else {
      const j = Math.floor(Math.random() * targetPlayer.hand.length);
      const [c] = targetPlayer.hand.splice(j, 1);
      removed = c ?? null;
      fromZone = removed ? "hand" : "none";
    }
  }
  // 3) no choice provided => old fallback behavior
  else {
    if (targetPlayer.hand.length > 0) {
      const j = Math.floor(Math.random() * targetPlayer.hand.length);
      const [c] = targetPlayer.hand.splice(j, 1);
      removed = c ?? null;
      fromZone = removed ? "hand" : "none";
    } else if (targetPlayer.equipment.length > 0) {
      const j = Math.floor(Math.random() * targetPlayer.equipment.length);
      const [c] = targetPlayer.equipment.splice(j, 1);
      removed = c ?? null;
      fromZone = removed ? "equipment" : "none";
    }
  }

  if (removed) discard(room, removed);

  maybeSuzyDraw(room, targetPlayer);
  maybeSuzyDraw(room, me);

  broadcastRoom(room, {
    type: "catbalou_resolved",
    roomCode: room.code,
    ts: Date.now(),
    fromPlayerId: me.id,
    targetId: targetPlayer.id,
    fromZone,
    // ✅ Cat Balou always reveals because the discarded card goes face-up to discard pile
    revealedCard: removed ? removed : null,
  });

  broadcastGameState(room);
  broadcastMeStates(room);
};