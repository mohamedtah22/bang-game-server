import type { PlayCardFn } from "./types";
import { broadcastCardPlayed } from "../engine/broadcast";
import { discard, maybeSuzyDraw } from "../engine/runtime";
import { getPlayer } from "../engine/players";
import { CHAR } from "../engine/types";
import { isChar, cardKey } from "../engine/utils";
import {
  canShootBang,
  effectiveDistance,
  weaponRange,
  maxBangsPerTurn,
  requiredMissedForBang,
} from "../engine/players";
import { barrelLikeCount } from "../engine/drawcheck";
import { openBangResponse, openBarrelChoice } from "../engine/turn";

export const playBang: PlayCardFn = (room, me, payload, card) => {
  const k = cardKey(card);
  if (!payload.targetId) throw new Error("Missing targetId");
  const target = getPlayer(room, payload.targetId);
  if (!target || !target.isAlive) throw new Error("Bad target");
  if (target.id === me.id) throw new Error("Can't target yourself");

  const isBangLike = k === "bang" || (isChar(me, CHAR.calamity) && k === "missed");
  if (!isBangLike) throw new Error("Not a BANG card");

  if (!canShootBang(room, me, target)) {
    const d = effectiveDistance(room, me, target);
    const r = weaponRange(me);
    throw new Error(`Target out of range (distance ${d}, range ${r})`);
  }

  room.bangsUsedThisTurn ??= 0;
  const maxB = maxBangsPerTurn(me);
  if (room.bangsUsedThisTurn >= maxB) {
    throw new Error(`Only ${maxB >= 999 ? "many" : maxB} BANG per turn`);
  }
  room.bangsUsedThisTurn++;

  broadcastCardPlayed(room, {
    action: "play",
    playerId: me.id,
    cardKey: "bang",
    usedCardKey: k,
    cardId: (card as any).id,
    targetId: target.id,
  });

  discard(room, card);

  const need = requiredMissedForBang(me);
  const barrelChecksRemaining = barrelLikeCount(target);

  maybeSuzyDraw(room, me);

  if (barrelChecksRemaining > 0) {
    openBarrelChoice(room, {
      source: "bang",
      attackerId: me.id,
      targetId: target.id,
      requiredMissed: need,
      missedSoFar: 0,
      barrelChecksRemaining,
    });
    return;
  }

  openBangResponse(room, {
    attackerId: me.id,
    targetId: target.id,
    requiredMissed: need,
    missedSoFar: 0,
  });
};
