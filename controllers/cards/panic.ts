import type { PlayCardFn } from "./types";
import { broadcastCardPlayed, broadcastGameState, broadcastMeStates, broadcastRoom, safeSend } from "../engine/broadcast";
import { discard, maybeSuzyDraw, ensureCardMeta } from "../engine/runtime";
import { getPlayer, effectiveDistance } from "../engine/players";
import { normalizeMaybeId, normalizeMaybeIndex } from "../engine/utils";

export const playPanic: PlayCardFn = (room, me, payload, card) => {
  if (!payload.targetId) throw new Error("Missing targetId");
  const target = getPlayer(room, payload.targetId);
  if (!target || !target.isAlive) throw new Error("Bad target");
  if (target.id === me.id) throw new Error("Can't target yourself");

  const d = effectiveDistance(room, me, target);
  if (d > 1) throw new Error(`Panic out of range (distance ${d})`);

  broadcastCardPlayed(room, {
    action: "play",
    playerId: me.id,
    cardKey: "panic",
    cardId: (card as any).id,
    targetId: target.id,
  });

  discard(room, card);

  const chosenEquipId = normalizeMaybeId(payload.targetCardId);
  const wantsHand =
    payload.pickHand === true ||
    String(payload.targetZone ?? "").toLowerCase() === "hand" ||
    normalizeMaybeIndex(payload.targetHandIndex) !== null; // trigger فقط (نتجاهل قيمة الindex)

  let stolen: any = null;
  let fromZone: "hand" | "equipment" | "none" = "none";

  // 1) اختيار معدات/سلاح محدد (Public)
  if (chosenEquipId) {
    const ix = target.equipment.findIndex((c) => String((c as any).id) === String(chosenEquipId));
    if (ix < 0) throw new Error("Card not available (equipment)");
    const [c] = target.equipment.splice(ix, 1);
    stolen = c ?? null;
    fromZone = stolen ? "equipment" : "none";
  }
  // 2) اختيار هاند => RANDOM by server (Private reveal)
  else if (wantsHand) {
    if (target.hand.length === 0) {
      // fallback: إذا ما عنده هاند، خذ random من المعدات (اختياري)
      if (target.equipment.length > 0) {
        const j = Math.floor(Math.random() * target.equipment.length);
        const [c] = target.equipment.splice(j, 1);
        stolen = c ?? null;
        fromZone = stolen ? "equipment" : "none";
      }
    } else {
      const j = Math.floor(Math.random() * target.hand.length);
      const [c] = target.hand.splice(j, 1);
      stolen = c ?? null;
      fromZone = stolen ? "hand" : "none";
    }
  }
  // 3) fallback القديم
  else {
    if (target.hand.length > 0) {
      const j = Math.floor(Math.random() * target.hand.length);
      const [c] = target.hand.splice(j, 1);
      stolen = c ?? null;
      fromZone = stolen ? "hand" : "none";
    } else if (target.equipment.length > 0) {
      const j = Math.floor(Math.random() * target.equipment.length);
      const [c] = target.equipment.splice(j, 1);
      stolen = c ?? null;
      fromZone = stolen ? "equipment" : "none";
    }
  }

  if (stolen) {
    ensureCardMeta(stolen);
    me.hand.push(stolen);
  }

  maybeSuzyDraw(room, target);
  maybeSuzyDraw(room, me);

  broadcastRoom(room, {
    type: "action_resolved",
    roomCode: room.code,
    kind: "panic",
    fromPlayerId: me.id,
    targetId: target.id,
    success: !!stolen,
    fromZone,
  });

  // ✅ event عام للكل:
  // - equipment/weapon: reveal للكل
  // - hand: لا تكشف للكل
  broadcastRoom(room, {
    type: "panic_resolved",
    roomCode: room.code,
    ts: Date.now(),
    fromPlayerId: me.id,
    targetId: target.id,
    fromZone,
    revealedCard: fromZone === "equipment" && stolen ? ensureCardMeta(stolen) : null,
  });

  // ✅ event خاص للي لعب Panic فقط (عشان يقلب الورقة المقلوبة)
  if (fromZone === "hand" && stolen) {
    safeSend((me as any).ws, {
      type: "panic_private_reveal",
      roomCode: room.code,
      ts: Date.now(),
      fromPlayerId: me.id,
      targetId: target.id,
      revealedCard: ensureCardMeta(stolen),
    });
  }

  broadcastGameState(room);
  broadcastMeStates(room);
};