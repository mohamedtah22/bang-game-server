import WebSocket from "ws";
import { rooms, wsToRoom } from "./state";
import type { Room } from "../models/room";
import type { Player, Card } from "../models/player";

import type { GameRoom, PlayPayload } from "./engine/types";
import { TURN_MS, RESPONSE_MS, CHAR } from "./engine/types";

import { ensureRuntime, ensurePlayerRuntime, popCardFromHand, discard, drawCard, maybeSuzyDraw, aliveCount, discard as discardFn } from "./engine/runtime";
import { getPlayer, currentPlayer, assertMyTurn, nextAliveIndex, isTurnEligible } from "./engine/players";
import { cardKey, isChar } from "./engine/utils";
import { safeSend, broadcastRoom, broadcastGameState, broadcastMeStates, broadcastCardPlayed, broadcastPlayerPassed } from "./engine/broadcast";
import { isBangPlay, canRespondToBangLike, canRespondToIndiansOrDuel } from "./engine/rules";
import { applyDamage, killNow, checkGameOver } from "./engine/gameover";
import {
  startTurn,
  advanceTurn,
  resolvePendingTimeout,
  resolveDrawChoice,
  resolveJesseChoice,
  resolvePedroChoice,
  resolveLuckyChoice,
  openDiscardLimit,
  discardRandomFromHand,
  continueIndians,
  continueGatling,
  continueGeneralStore,
  promptDuel,
  finishStandardDraw,
  runTurnStart,
  continueAfterBarrelBang,
  openBangResponse,
} from "./engine/turn";

import { startBarrelDraw } from "./engine/drawcheck";
import { cardPlayRegistry } from "./cards";

/** ===== utilities ===== */
function getRoomByWs(ws: any): GameRoom | null {
  const info = wsToRoom.get(ws);
  if (!info) return null;

  const room = rooms.get(info.roomCode) as GameRoom | undefined;
  if (!room) return null;

  ensureRuntime(room);
  return room;
}

/** ================= handlers ================= */

export function handlePlayCard(ws: any, payload: PlayPayload) {
  const room = getRoomByWs(ws);
  if (!room) return safeSend(ws, { type: "error", message: "Not in a room" });
  if (!room.started || room.ended) return safeSend(ws, { type: "error", message: "Game not started" });

  const info = wsToRoom.get(ws)!;

  if (payload.roomCode && payload.roomCode !== room.code) {
    return safeSend(ws, { type: "error", message: "Wrong roomCode" });
  }

  const me = getPlayer(room, info.playerId);
  if (!me) return safeSend(ws, { type: "error", message: "Player not found" });

  let takenCard: Card | undefined;

  try {
    ensureRuntime(room);

    if (room.phase !== "main") throw new Error("Finish pending action first");
    assertMyTurn(room, me.id);

    if (!payload.cardId) throw new Error("Missing cardId");
    takenCard = popCardFromHand(me, payload.cardId);

    const k = cardKey(takenCard);

    // MISSED alone can't be played as a normal action, except Calamity Janet can play it as BANG
    if (k === "missed" && !isBangPlay(me, takenCard)) throw new Error("MISSED is a response card");

    // Dispatch to per-card module
    const fn = cardPlayRegistry[k];
    if (fn) {
      fn(room, me, payload, takenCard);
      takenCard = undefined;
      return;
    }

    // Special: Calamity can play MISSED as BANG (mapped under bang module),
    // so if key is missed we already threw. If you want it, you can change registry to route missed->bang for calamity.

    // fallback: discard unknown
    discard(room, takenCard);
    takenCard = undefined;

    maybeSuzyDraw(room, me);
    broadcastGameState(room);
    broadcastMeStates(room);
  } catch (e: any) {
    if (takenCard) me.hand.push(takenCard);
    safeSend(ws, { type: "error", message: e?.message || "Bad action" });
  }
}

/**
 * handleRespond
 */
export function handleRespond(ws: any, payload: { cardId?: string; cardIds?: string[]; roomCode?: string }) {
  const room = getRoomByWs(ws);
  if (!room) return safeSend(ws, { type: "error", message: "Not in a room" });
  if (!room.started || room.ended) return safeSend(ws, { type: "error", message: "Game not started" });

  if (payload.roomCode && payload.roomCode !== room.code) {
    return safeSend(ws, { type: "error", message: "Wrong roomCode" });
  }

  const info = wsToRoom.get(ws)!;
  const me = getPlayer(room, info.playerId);
  if (!me) return safeSend(ws, { type: "error", message: "Player not found" });

  let takenCard: Card | undefined;
  let takenCards: Card[] = [];

  try {
    ensureRuntime(room);

    if (room.phase !== "waiting" || !room.pending) throw new Error("No pending action");
    const pend = room.pending;

    const normalizedCardIds = Array.from(
      new Set(
        (Array.isArray(payload.cardIds) ? payload.cardIds : [])
          .map((x) => String(x ?? "").trim())
          .filter(Boolean)
      )
    );

    const isPass = !payload.cardId && normalizedCardIds.length === 0;

    // === BARREL CHOICE ===
    if (pend.kind === "barrel_choice") {
      throw new Error("This pending requires choose_barrel");
    }

    // === LUCKY CHOICE ===
    if (pend.kind === "lucky_choice") {
      if (pend.playerId !== me.id) throw new Error("Not your lucky choice");
      if (isPass) throw new Error("Must choose a card");
      resolveLuckyChoice(room, me, payload.cardId!);
      return;
    }

    // === REVIVE pending ===
    if (pend.kind === "revive") {
      if (pend.playerId !== me.id) throw new Error("Not your revive");
      if (!me.isAlive) throw new Error("You are dead");

      const resume = pend.resume ?? null;
      const attackerId = pend.attackerId;

      const continueAfterResume = () => {
        if (room.ended) return;

        if (resume && typeof resume === "object" && "kind" in resume) {
          if ((resume as any).kind === "indians") {
            room.pending = resume as any;
            continueIndians(room);
            return;
          }
          if ((resume as any).kind === "gatling") {
            room.pending = resume as any;
            continueGatling(room);
            return;
          }
          if ((resume as any).kind === "turn_start") {
            const tr = resume as any as { kind: "turn_start"; stage: "jail" | "draw"; playerId: string };
            const cur = currentPlayer(room);
            if (cur && cur.isAlive && cur.id === tr.playerId) {
              runTurnStart(room, cur, tr.stage === "jail" ? "jail" : "draw");
            }
            return;
          }
        }
      };

      const dieFinally = (kind: "revive_failed_died" | "revive_timeout_died") => {
        room.pending = null;
        room.phase = "main";
        room.pendingEndsAt = undefined;

        killNow(room, me, attackerId);

        broadcastRoom(room, {
          type: "action_resolved",
          roomCode: room.code,
          kind,
          playerId: me.id,
        });

        broadcastGameState(room);
        broadcastMeStates(room);

        if (room.ended) return;

        continueAfterResume();

        const cur = currentPlayer(room);
        if (cur && !cur.isAlive) {
          const nxt = nextAliveIndex(room, room.turnIndex ?? 0);
          if (nxt >= 0) {
            room.turnIndex = nxt;
            startTurn(room);
          } else {
            checkGameOver(room);
          }
        }
      };

      if (isPass) {
        dieFinally("revive_failed_died");
        return;
      }

      takenCard = popCardFromHand(me, payload.cardId!);
      if (cardKey(takenCard) !== "beer") {
        me.hand.push(takenCard);
        takenCard = undefined;
        throw new Error("Need BEER to revive");
      }

      // revive beer is allowed even when only two players remain
      discard(room, takenCard);
      takenCard = undefined;

      me.hp = Math.min(me.maxHp, me.hp + 1);
      maybeSuzyDraw(room, me);

      room.pending = null;
      room.phase = "main";
      room.pendingEndsAt = undefined;

      broadcastRoom(room, {
        type: "action_resolved",
        roomCode: room.code,
        kind: "revive_success",
        playerId: me.id,
        newHp: me.hp,
      });

      broadcastGameState(room);
      broadcastMeStates(room);

      continueAfterResume();
      return;
    }

    // === BANG pending ===
    if (pend.kind === "bang") {
      if (pend.targetId !== me.id) throw new Error("Not your response");
      if (!me.isAlive) throw new Error("You are dead");

      const requiredMissed = Number(pend.requiredMissed ?? 1);
      const missedSoFar = Number(pend.missedSoFar ?? 0);
      const remainingMissed = Math.max(0, requiredMissed - missedSoFar);

      if (isPass) {
        if (requiredMissed > 1 && missedSoFar > 0 && missedSoFar < requiredMissed) {
          throw new Error("You must finish all required Missed! cards for this BANG.");
        }

        broadcastPlayerPassed(room, { playerId: me.id, context: "respond_to_bang" });

        room.pending = null;
        room.phase = "main";
        room.pendingEndsAt = undefined;

        const opened = applyDamage(room, me, 1, pend.attackerId);
        if (opened) return;

        broadcastRoom(room, {
          type: "action_resolved",
          roomCode: room.code,
          kind: "bang_hit",
          attackerId: pend.attackerId,
          targetId: me.id,
          newHp: me.hp,
          isAlive: me.isAlive,
        });

        broadcastGameState(room);
        broadcastMeStates(room);
        return;
      }

      if (normalizedCardIds.length > 0) {
        if (remainingMissed <= 1) {
          throw new Error("Select one response card only");
        }
        if (normalizedCardIds.length !== remainingMissed) {
          throw new Error(`Need exactly ${remainingMissed} MISSED card(s) for this BANG.`);
        }

        for (const cid of normalizedCardIds) {
          const picked = popCardFromHand(me, cid);
          takenCards.push(picked);

          if (!canRespondToBangLike(me, picked)) {
            throw new Error("Need MISSED (or BANG if Calamity)");
          }
        }

        for (const picked of takenCards) {
          broadcastCardPlayed(room, {
            action: "respond",
            playerId: me.id,
            cardKey: cardKey(picked),
            usedCardKey: cardKey(picked),
            cardId: (picked as any).id,
            context: "respond_to_bang",
          });

          discard(room, picked);
        }
        takenCards = [];

        pend.missedSoFar += normalizedCardIds.length;
      } else {
        takenCard = popCardFromHand(me, payload.cardId!);
        if (!canRespondToBangLike(me, takenCard)) {
          me.hand.push(takenCard);
          takenCard = undefined;
          throw new Error("Need MISSED (or BANG if Calamity)");
        }

        broadcastCardPlayed(room, {
          action: "respond",
          playerId: me.id,
          cardKey: cardKey(takenCard),
          usedCardKey: cardKey(takenCard),
          cardId: (takenCard as any).id,
          context: "respond_to_bang",
        });

        discard(room, takenCard);
        takenCard = undefined;

        pend.missedSoFar += 1;
      }

      if (pend.missedSoFar < pend.requiredMissed) {
        room.pendingEndsAt = Date.now() + RESPONSE_MS;

        safeSend((me as any).ws, {
          type: "action_required",
          roomCode: room.code,
          kind: "respond_to_bang",
          toPlayerId: me.id,
          targetId: me.id,
          fromPlayerId: pend.attackerId,
          requiredMissed: pend.requiredMissed,
          missedSoFar: pend.missedSoFar,
          pendingEndsAt: room.pendingEndsAt,
        });

        broadcastRoom(room, {
          type: "action_resolved",
          roomCode: room.code,
          kind: "bang_partial_missed",
          attackerId: pend.attackerId,
          targetId: pend.targetId,
          remaining: pend.requiredMissed - pend.missedSoFar,
        });

        maybeSuzyDraw(room, me);
        broadcastGameState(room);
        broadcastMeStates(room);
        return;
      }

      room.pending = null;
      room.phase = "main";
      room.pendingEndsAt = undefined;

      broadcastRoom(room, {
        type: "action_resolved",
        roomCode: room.code,
        kind: "bang_missed",
        attackerId: pend.attackerId,
        targetId: pend.targetId,
      });

      maybeSuzyDraw(room, me);
      broadcastGameState(room);
      broadcastMeStates(room);
      return;
    }

    // === Indians pending ===
    if (pend.kind === "indians") {
      const targetId = pend.targets[pend.idx];
      if (me.id !== targetId) throw new Error("Not your response");

      if (isPass) {
        broadcastPlayerPassed(room, { playerId: me.id, context: "respond_to_indians" });

        const resume = {
          kind: "indians",
          attackerId: pend.attackerId,
          targets: pend.targets,
          idx: pend.idx + 1,
        } as any;

        broadcastRoom(room, {
          type: "action_resolved",
          roomCode: room.code,
          kind: "indians_hit",
          attackerId: pend.attackerId,
          targetId: me.id,
        });

        const opened = applyDamage(room, me, 1, pend.attackerId, resume);
        if (opened) return;

        pend.idx++;
        continueIndians(room);
        return;
      }

      takenCard = popCardFromHand(me, payload.cardId!);
      if (!canRespondToIndiansOrDuel(me, takenCard)) {
        me.hand.push(takenCard);
        takenCard = undefined;
        throw new Error("Need BANG (or MISSED if Calamity)");
      }

      broadcastCardPlayed(room, {
        action: "respond",
        playerId: me.id,
        cardKey: "bang",
        usedCardKey: cardKey(takenCard),
        cardId: (takenCard as any).id,
        context: "respond_to_indians",
      });

      discard(room, takenCard);
      takenCard = undefined;

      broadcastRoom(room, {
        type: "action_resolved",
        roomCode: room.code,
        kind: "indians_defended",
        attackerId: pend.attackerId,
        targetId: me.id,
      });

      maybeSuzyDraw(room, me);
      pend.idx++;
      continueIndians(room);
      return;
    }

    // === Gatling pending ===
    if (pend.kind === "gatling") {
      const targetId = pend.targets[pend.idx];
      if (me.id !== targetId) throw new Error("Not your response");

      if (isPass) {
        broadcastPlayerPassed(room, { playerId: me.id, context: "respond_to_gatling" });

        const resume = {
          kind: "gatling",
          attackerId: pend.attackerId,
          targets: pend.targets,
          idx: pend.idx + 1,
        } as any;

        broadcastRoom(room, {
          type: "action_resolved",
          roomCode: room.code,
          kind: "gatling_hit",
          attackerId: pend.attackerId,
          targetId: me.id,
        });

        const opened = applyDamage(room, me, 1, pend.attackerId, resume);
        if (opened) return;

        pend.idx++;
        continueGatling(room);
        return;
      }

      takenCard = popCardFromHand(me, payload.cardId!);
      if (!canRespondToBangLike(me, takenCard)) {
        me.hand.push(takenCard);
        takenCard = undefined;
        throw new Error("Need MISSED (or BANG if Calamity)");
      }

      broadcastCardPlayed(room, {
        action: "respond",
        playerId: me.id,
        cardKey: cardKey(takenCard),
        usedCardKey: cardKey(takenCard),
        cardId: (takenCard as any).id,
        context: "respond_to_gatling",
      });

      discard(room, takenCard);
      takenCard = undefined;

      broadcastRoom(room, {
        type: "action_resolved",
        roomCode: room.code,
        kind: "gatling_defended",
        attackerId: pend.attackerId,
        targetId: me.id,
      });

      maybeSuzyDraw(room, me);
      pend.idx++;
      continueGatling(room);
      return;
    }

    // === Duel pending ===
    if (pend.kind === "duel") {
      if (me.id !== pend.responderId) throw new Error("Not your response");

      const opponentId = me.id === pend.targetId ? pend.initiatorId : pend.targetId;

      if (isPass) {
        broadcastPlayerPassed(room, { playerId: me.id, context: "respond_to_duel" });

        room.pending = null;
        room.phase = "main";
        room.pendingEndsAt = undefined;

        const opened = applyDamage(room, me, 1, opponentId);
        if (opened) return;

        broadcastRoom(room, {
          type: "action_resolved",
          roomCode: room.code,
          kind: "duel_lose",
          loserId: me.id,
          winnerId: opponentId,
          newHp: me.hp,
          isAlive: me.isAlive,
        });

        broadcastGameState(room);
        broadcastMeStates(room);
        return;
      }

      takenCard = popCardFromHand(me, payload.cardId!);
      if (!canRespondToIndiansOrDuel(me, takenCard)) {
        me.hand.push(takenCard);
        takenCard = undefined;
        throw new Error("Need BANG (or MISSED if Calamity)");
      }

      broadcastCardPlayed(room, {
        action: "respond",
        playerId: me.id,
        cardKey: cardKey(takenCard),
        usedCardKey: cardKey(takenCard),
        cardId: (takenCard as any).id,
        context: "respond_to_duel",
        targetId: opponentId,
      });

      discard(room, takenCard);
      takenCard = undefined;

      maybeSuzyDraw(room, me);

      pend.responderId = opponentId;
      room.pendingEndsAt = Date.now() + RESPONSE_MS;

      broadcastRoom(room, {
        type: "action_resolved",
        roomCode: room.code,
        kind: "duel_continue",
        nextResponderId: pend.responderId,
      });

      promptDuel(room, pend);
      return;
    }

    throw new Error("This pending requires a specific handler");
  } catch (e: any) {
    if (takenCard) me.hand.push(takenCard);
    if (takenCards.length) {
      for (let i = takenCards.length - 1; i >= 0; i--) {
        me.hand.push(takenCards[i]);
      }
      takenCards = [];
    }
    safeSend(ws, { type: "error", message: e?.message || "Bad response" });
  }
}

/** Kit Carlson choose 2 from 3 */
export function handleChooseDraw(ws: any, payload: { cardIds?: string[]; roomCode?: string }) {
  const room = getRoomByWs(ws);
  if (!room) return safeSend(ws, { type: "error", message: "Not in a room" });
  if (!room.started || room.ended) return safeSend(ws, { type: "error", message: "Game not started" });

  if (payload.roomCode && payload.roomCode !== room.code) {
    return safeSend(ws, { type: "error", message: "Wrong roomCode" });
  }

  const info = wsToRoom.get(ws)!;
  const me = getPlayer(room, info.playerId);
  if (!me) return safeSend(ws, { type: "error", message: "Player not found" });

  try {
    ensureRuntime(room);
    if (room.phase !== "waiting" || room.pending?.kind !== "draw_choice") throw new Error("No draw choice pending");
    resolveDrawChoice(room, me, payload.cardIds ?? []);
  } catch (e: any) {
    safeSend(ws, { type: "error", message: e?.message || "Bad choose_draw" });
  }
}

/** Jesse Jones choose target or skip */
export function handleChooseJesseTarget(ws: any, payload: { targetId?: string; roomCode?: string }) {
  const room = getRoomByWs(ws);
  if (!room) return safeSend(ws, { type: "error", message: "Not in a room" });
  if (!room.started || room.ended) return safeSend(ws, { type: "error", message: "Game not started" });

  if (payload.roomCode && payload.roomCode !== room.code) {
    return safeSend(ws, { type: "error", message: "Wrong roomCode" });
  }

  const info = wsToRoom.get(ws)!;
  const me = getPlayer(room, info.playerId);
  if (!me) return safeSend(ws, { type: "error", message: "Player not found" });

  try {
    ensureRuntime(room);
    if (room.phase !== "waiting" || room.pending?.kind !== "jesse_choice") throw new Error("No Jesse choice pending");
    resolveJesseChoice(room, me, payload.targetId);
  } catch (e: any) {
    safeSend(ws, { type: "error", message: e?.message || "Bad choose_jesse_target" });
  }
}

/** Pedro Ramirez choose "deck" or "discard" */
export function handleChoosePedroSource(ws: any, payload: { source?: "deck" | "discard"; roomCode?: string }) {
  const room = getRoomByWs(ws);
  if (!room) return safeSend(ws, { type: "error", message: "Not in a room" });
  if (!room.started || room.ended) return safeSend(ws, { type: "error", message: "Game not started" });

  if (payload.roomCode && payload.roomCode !== room.code) {
    return safeSend(ws, { type: "error", message: "Wrong roomCode" });
  }

  const info = wsToRoom.get(ws)!;
  const me = getPlayer(room, info.playerId);
  if (!me) return safeSend(ws, { type: "error", message: "Player not found" });

  try {
    ensureRuntime(room);
    if (room.phase !== "waiting" || room.pending?.kind !== "pedro_choice") throw new Error("No Pedro choice pending");
    resolvePedroChoice(room, me, payload.source === "discard" ? "discard" : "deck");
  } catch (e: any) {
    safeSend(ws, { type: "error", message: e?.message || "Bad choose_pedro_source" });
  }
}

/** General Store: pick one face-up card */
export function handleChooseGeneralStore(ws: any, payload: { cardId?: string; roomCode?: string }) {
  const room = getRoomByWs(ws);
  if (!room) return safeSend(ws, { type: "error", message: "Not in a room" });
  if (!room.started || room.ended) return safeSend(ws, { type: "error", message: "Game not started" });

  if (payload.roomCode && payload.roomCode !== room.code) {
    return safeSend(ws, { type: "error", message: "Wrong roomCode" });
  }

  const info = wsToRoom.get(ws)!;
  const me = getPlayer(room, info.playerId);
  if (!me) return safeSend(ws, { type: "error", message: "Player not found" });

  try {
    ensureRuntime(room);
    if (room.phase !== "waiting" || room.pending?.kind !== "general_store") throw new Error("No General Store pending");

    const pend = room.pending as any;
    const curPickerId = pend.order[pend.idx];
    if (me.id !== curPickerId) throw new Error("Not your turn to pick");

    if (!payload.cardId) throw new Error("Missing cardId");

    const ix = pend.offered.findIndex((c: any) => String(c?.id) === String(payload.cardId));
    if (ix < 0) throw new Error("Card not available");

    const [chosen] = pend.offered.splice(ix, 1);
    if (!chosen) throw new Error("Card not available");

    me.hand.push(chosen);

    broadcastRoom(room, {
  type: "general_store_pick",
  roomCode: room.code,
  ts: Date.now(),
  pickerId: me.id,
  card: chosen,
  remaining: pend.offered,
  nextPickerId: pend.order[pend.idx + 1] ?? null,
});

    maybeSuzyDraw(room, me);

    pend.idx++;
    continueGeneralStore(room);
  } catch (e: any) {
    safeSend(ws, { type: "error", message: e?.message || "Bad choose_general_store" });
  }
}

export function handleChooseBarrel(ws: any, payload: { useBarrel?: boolean; roomCode?: string }) {
  const room = getRoomByWs(ws);
  if (!room) return safeSend(ws, { type: "error", message: "Not in a room" });
  if (!room.started || room.ended) return safeSend(ws, { type: "error", message: "Game not started" });

  if (payload.roomCode && payload.roomCode !== room.code) {
    return safeSend(ws, { type: "error", message: "Wrong roomCode" });
  }

  const info = wsToRoom.get(ws)!;
  const me = getPlayer(room, info.playerId);
  if (!me) return safeSend(ws, { type: "error", message: "Player not found" });

  try {
    ensureRuntime(room);
    if (room.phase !== "waiting" || room.pending?.kind !== "barrel_choice") throw new Error("No barrel choice pending");

    const pend = room.pending as any;
    if (String(pend.targetId ?? "") !== me.id) throw new Error("Not your barrel choice");

    const useBarrel = payload.useBarrel !== false;

    if (!useBarrel) {
      openBangResponse(room, {
        attackerId: pend.attackerId,
        targetId: pend.targetId,
        requiredMissed: Number(pend.requiredMissed ?? 1),
        missedSoFar: Number(pend.missedSoFar ?? 0),
      });
      return;
    }

    const resume = {
      kind: "barrel_vs_bang" as const,
      attackerId: pend.attackerId,
      targetId: pend.targetId,
      requiredMissed: Number(pend.requiredMissed ?? 1),
      missedSoFar: Number(pend.missedSoFar ?? 0),
      barrelChecksRemaining: Math.max(0, Number(pend.barrelChecksRemaining ?? 0) - 1),
    };

    const res = startBarrelDraw(room, me, resume);
    if (res.kind === "waiting") return;

    continueAfterBarrelBang(
      room,
      {
        attackerId: pend.attackerId,
        targetId: pend.targetId,
        requiredMissed: Number(pend.requiredMissed ?? 1),
        missedSoFar: Number(pend.missedSoFar ?? 0),
        barrelChecksRemaining: Number(pend.barrelChecksRemaining ?? 0),
      },
      true,
      !!res.success
    );
  } catch (e: any) {
    safeSend(ws, { type: "error", message: e?.message || "Bad choose_barrel" });
  }
}

/** Lucky Duke choose draw card */
export function handleChooseLuckyDraw(ws: any, payload: { cardId?: string; roomCode?: string }) {
  const room = getRoomByWs(ws);
  if (!room) return safeSend(ws, { type: "error", message: "Not in a room" });
  if (!room.started || room.ended) return safeSend(ws, { type: "error", message: "Game not started" });

  if (payload.roomCode && payload.roomCode !== room.code) {
    return safeSend(ws, { type: "error", message: "Wrong roomCode" });
  }

  const info = wsToRoom.get(ws)!;
  const me = getPlayer(room, info.playerId);
  if (!me) return safeSend(ws, { type: "error", message: "Player not found" });

  try {
    ensureRuntime(room);
    if (room.phase !== "waiting" || room.pending?.kind !== "lucky_choice") throw new Error("No lucky_choice pending");
    if (!payload.cardId) throw new Error("Missing cardId");
    resolveLuckyChoice(room, me, payload.cardId);
  } catch (e: any) {
    safeSend(ws, { type: "error", message: e?.message || "Bad choose_lucky_draw" });
  }
}

/** Sid Ketchum: discard 2 cards -> heal 1 */
export function handleSidHeal(ws: any, payload: { cardIds?: string[]; roomCode?: string }) {
  const room = getRoomByWs(ws);
  if (!room) return safeSend(ws, { type: "error", message: "Not in a room" });
  if (!room.started || room.ended) return safeSend(ws, { type: "error", message: "Game not started" });

  if (payload.roomCode && payload.roomCode !== room.code) {
    return safeSend(ws, { type: "error", message: "Wrong roomCode" });
  }

  const info = wsToRoom.get(ws)!;
  const me = getPlayer(room, info.playerId);
  if (!me) return safeSend(ws, { type: "error", message: "Player not found" });

  try {
    ensureRuntime(room);
    if (!isChar(me, CHAR.sid)) throw new Error("Not Sid Ketchum");
    if (room.phase !== "main") throw new Error("Finish pending action first");
    if (!me.isAlive) throw new Error("You are dead");
    if (me.hp >= me.maxHp) throw new Error("Already at full HP");

    const ids = payload.cardIds ?? [];
    if (ids.length !== 2) throw new Error("Need exactly 2 cardIds");

    const c1 = popCardFromHand(me, ids[0]);
    const c2 = popCardFromHand(me, ids[1]);

    discard(room, c1);
    discard(room, c2);

    me.hp = Math.min(me.maxHp, me.hp + 1);

    maybeSuzyDraw(room, me);

    broadcastRoom(room, { type: "action_resolved", roomCode: room.code, kind: "sid_heal", playerId: me.id, newHp: me.hp });
    broadcastGameState(room);
    broadcastMeStates(room);
  } catch (e: any) {
    safeSend(ws, { type: "error", message: e?.message || "Bad sid_heal" });
  }
}

/** Discard down to HP (when requested) */
export function handleDiscardToLimit(ws: any, payload: { cardIds?: string[]; roomCode?: string }) {
  const room = getRoomByWs(ws);
  if (!room) return safeSend(ws, { type: "error", message: "Not in a room" });
  if (!room.started || room.ended) return safeSend(ws, { type: "error", message: "Game not started" });

  if (payload.roomCode && payload.roomCode !== room.code) {
    return safeSend(ws, { type: "error", message: "Wrong roomCode" });
  }

  const info = wsToRoom.get(ws)!;
  const me = getPlayer(room, info.playerId);
  if (!me) return safeSend(ws, { type: "error", message: "Player not found" });

  try {
    ensureRuntime(room);
    if (room.phase !== "waiting" || room.pending?.kind !== "discard_limit") throw new Error("No discard_limit pending");
    const pend = room.pending as any;
    if (pend.playerId !== me.id) throw new Error("Not your discard_limit");

    const ids = Array.from(new Set(payload.cardIds ?? []));
    if (ids.length !== pend.need) throw new Error(`Need exactly ${pend.need} cards`);

    const discardedCards: any[] = [];
    for (const id of ids) {
      const c = popCardFromHand(me, id);
      discard(room, c);
      discardedCards.push(c);
    }

    room.pending = null;
    room.phase = "main";
    room.pendingEndsAt = undefined;

    maybeSuzyDraw(room, me);

    broadcastRoom(room, { type: "action_resolved", roomCode: room.code, kind: "discard_limit_done", playerId: me.id, discardedCards });

    broadcastGameState(room);
    broadcastMeStates(room);

    if (pend.after === "end_turn_manual") {
      advanceTurn(room, "manual");
    }
  } catch (e: any) {
    safeSend(ws, { type: "error", message: e?.message || "Bad discard_to_limit" });
  }
}

export function handleEndTurn(ws: any, payload?: { roomCode?: string }) {
  const room = getRoomByWs(ws);
  if (!room) return safeSend(ws, { type: "error", message: "Not in a room" });
  if (!room.started || room.ended) return safeSend(ws, { type: "error", message: "Game not started" });

  if (payload?.roomCode && payload?.roomCode !== room.code) {
    return safeSend(ws, { type: "error", message: "Wrong roomCode" });
  }

  const info = wsToRoom.get(ws)!;

  try {
    ensureRuntime(room);

    if (room.phase !== "main") throw new Error("Can't end turn now");
    assertMyTurn(room, info.playerId);

    const me = getPlayer(room, info.playerId)!;

    if (openDiscardLimit(room, me, "end_turn_manual")) return;

    advanceTurn(room, "manual");
  } catch (e: any) {
    safeSend(ws, { type: "error", message: e?.message || "Can't end turn" });
  }
}

/** ===== startGame ===== */
export function startGame(room: GameRoom) {
  ensureRuntime(room);

  room.started = true;
  room.ended = false;

  const idxSheriff = (room.players as any[]).findIndex((p: Player) => p.role === "sheriff");
  room.turnIndex = idxSheriff >= 0 ? idxSheriff : 0;

  for (const p of room.players as any[]) {
    const pl = p as Player;
    ensurePlayerRuntime(pl);

    pl.isAlive = true;
    pl.hp = Math.min(pl.maxHp, pl.maxHp);

    pl.hand = pl.hand ?? [];
    pl.equipment = pl.equipment ?? [];

    const need = Math.max(0, pl.hp - pl.hand.length);
    for (let i = 0; i < need; i++) {
      try {
        pl.hand.push(drawCard(room));
      } catch {
        break;
      }
    }
  }

  broadcastRoom(room, { type: "game_started", roomCode: room.code, turnPlayerId: currentPlayer(room)?.id });
  broadcastGameState(room);
  broadcastMeStates(room);

  startTurn(room);
}

export { startTurn };

/** ===== MAIN TIMER LOOP (same behavior as before) ===== */
setInterval(() => {
  const now = Date.now();

  for (const r of rooms.values()) {
    const room = r as GameRoom;
    if (!room.started || room.ended) continue;

    try {
      ensureRuntime(room);

      if (room.phase === "waiting") {
        if (!room.turnPausedAt) {
          room.turnPausedAt = now;
        } else if (room.turnEndsAt) {
          room.turnEndsAt += now - room.turnPausedAt;
          room.turnPausedAt = now;
        }
      } else {
        room.turnPausedAt = undefined;
      }

      if (room.phase === "waiting" && room.pending && room.pendingEndsAt && now >= room.pendingEndsAt) {
        resolvePendingTimeout(room);
        continue;
      }

      if (room.phase === "main") {
        const cur = currentPlayer(room);
        if (!isTurnEligible(cur)) {
          advanceTurn(room, "disconnect");
          continue;
        }
      }

      if (room.phase === "main" && room.turnEndsAt && now >= room.turnEndsAt) {
        const p = currentPlayer(room);
        const handLen = Array.isArray((p as any)?.hand) ? (p as any).hand.length : 0;
        const hp = Number((p as any)?.hp ?? 0);

        const need = Math.max(0, handLen - hp);
        if (need > 0) discardRandomFromHand(room, p, need);
        advanceTurn(room, "timeout");
      }
    } catch (err) {
      // Never crash the whole server because of one room tick.
      // If we keep crashing here, the client can still continue via manual actions.
      console.error("[tick] room:", room.code, "error:", err);
      try {
        // best-effort recovery
        ensureRuntime(room);
      } catch {}
    }
  }
}, 500);

