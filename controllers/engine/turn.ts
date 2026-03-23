import type { Player, Card } from "../../models/player";
import type { GameRoom, PendingBase, ResumeAfterRevive } from "./types";
import { TURN_MS, RESPONSE_MS } from "./types";
import { ensureRuntime, drawCard, discard, takeFromDiscard, maybeSuzyDraw, aliveCount, alivePlayers, ensurePlayerRuntime, equipmentHas, takeEquipment } from "./runtime";
import { currentPlayer, getPlayer, nextAliveIndex, isTurnEligible } from "./players";
import { broadcastRoom, broadcastGameState, broadcastMeStates, safeSend, broadcastCardPlayed, broadcastPlayerPassed } from "./broadcast";
import { CHAR } from "./types";
import { isChar, cardKey } from "./utils";
import { canShootBang, effectiveDistance, weaponRange, maxBangsPerTurn, requiredMissedForBang } from "./players";
import { isHeartsOrDiamonds, isHearts, isDynamiteExplosionCard, startLuckyChoice, evalDrawSuccess, startBarrelDraw, barrelLikeCount, drawOneForCheck } from "./drawcheck";
import { checkGameOver, killNow, applyDamage } from "./gameover";
import { canRespondToBangLike, canRespondToIndiansOrDuel } from "./rules";

function pendingDeadlineFromTurn(room: GameRoom) {
  const turnEnd = Number((room as any)?.turnEndsAt ?? 0);
  if (turnEnd > Date.now()) return turnEnd;
  return Date.now() + RESPONSE_MS;
}

function countBangLikeResponses(player: Player): number {
  return (player.hand ?? []).filter((card) => canRespondToIndiansOrDuel(player, card)).length;
}

function countMissedLikeResponses(player: Player): number {
  return (player.hand ?? []).filter((card) => canRespondToBangLike(player, card)).length;
}

function hasNoHandCards(player: Player): boolean {
  return ((player.hand ?? []).length | 0) <= 0;
}

function resolveBangWithoutResponse(room: GameRoom, args: { attackerId: string; target: Player }) {
  room.pending = null as any;
  room.phase = "main" as any;
  room.pendingEndsAt = undefined;

  broadcastPlayerPassed(room, { playerId: args.target.id, context: "respond_to_bang_auto" });

  const opened = applyDamage(room, args.target, 1, args.attackerId);
  if (opened) return;

  broadcastRoom(room, {
    type: "action_resolved",
    roomCode: room.code,
    kind: "bang_hit",
    attackerId: args.attackerId,
    targetId: args.target.id,
    newHp: args.target.hp,
    isAlive: args.target.isAlive,
  });

  broadcastGameState(room);
  broadcastMeStates(room);
}

function resolveIndiansWithoutResponse(room: GameRoom, pend: Extract<PendingBase, { kind: "indians" }>, target: Player) {
  broadcastPlayerPassed(room, { playerId: target.id, context: "respond_to_indians_auto" });

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
    targetId: target.id,
  });

  const opened = applyDamage(room, target, 1, pend.attackerId, resume);
  if (opened) return;

  pend.idx++;
  continueIndians(room);
}

function resolveGatlingWithoutResponse(room: GameRoom, pend: Extract<PendingBase, { kind: "gatling" }>, target: Player) {
  broadcastPlayerPassed(room, { playerId: target.id, context: "respond_to_gatling_auto" });

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
    targetId: target.id,
  });

  const opened = applyDamage(room, target, 1, pend.attackerId, resume);
  if (opened) return;

  pend.idx++;
  continueGatling(room);
}

function resolveDuelWithoutResponse(room: GameRoom, pend: Extract<PendingBase, { kind: "duel" }>, responder: Player) {
  const opponentId = responder.id === pend.targetId ? pend.initiatorId : pend.targetId;

  room.pending = null as any;
  room.phase = "main" as any;
  room.pendingEndsAt = undefined;

  broadcastPlayerPassed(room, { playerId: responder.id, context: "respond_to_duel_auto" });

  const opened = applyDamage(room, responder, 1, opponentId);
  if (opened) return;

  broadcastRoom(room, {
    type: "action_resolved",
    roomCode: room.code,
    kind: "duel_lose",
    loserId: responder.id,
    winnerId: opponentId,
    newHp: responder.hp,
    isAlive: responder.isAlive,
  });

  broadcastGameState(room);
  broadcastMeStates(room);
}

/** ===== Draw Phase ===== */
export function startDrawPhase(room: GameRoom, player: Player) {
  if (isChar(player, CHAR.kit)) {
    const offered = [drawCard(room), drawCard(room), drawCard(room)];
    room.phase = "waiting";
    room.pending = { kind: "draw_choice", playerId: player.id, offered, pickCount: 2 };
    room.pendingEndsAt = pendingDeadlineFromTurn(room);

    safeSend((player as any).ws, {
      type: "action_required",
      roomCode: room.code,
      kind: "choose_draw",
      playerId: player.id,
      toPlayerId: player.id,
      pickCount: 2,
      offered,
      pendingEndsAt: room.pendingEndsAt,
    });

    broadcastGameState(room);
    broadcastMeStates(room);
    return;
  }

  if (isChar(player, CHAR.jesse)) {
    const eligible = (room.players as any[])
      .map((p: Player) => p)
      .filter((p) => p.isAlive && p.id !== player.id && p.hand.length > 0)
      .map((p) => p.id);

    if (eligible.length > 0) {
      room.phase = "waiting";
      room.pending = { kind: "jesse_choice", playerId: player.id, eligibleTargets: eligible };
      room.pendingEndsAt = pendingDeadlineFromTurn(room);

      safeSend((player as any).ws, {
        type: "action_required",
        roomCode: room.code,
        kind: "choose_jesse_target",
        playerId: player.id,
        toPlayerId: player.id,
        eligibleTargets: eligible,
        pendingEndsAt: room.pendingEndsAt,
      });

      broadcastGameState(room);
      broadcastMeStates(room);
      return;
    }
  }

  if (isChar(player, CHAR.pedro)) {
    const canUseDiscard = (room.discard?.length ?? 0) > 0;
    if (canUseDiscard) {
      room.phase = "waiting";
      room.pending = { kind: "pedro_choice", playerId: player.id, canUseDiscard: true };
      room.pendingEndsAt = pendingDeadlineFromTurn(room);

      safeSend((player as any).ws, {
        type: "action_required",
        roomCode: room.code,
        kind: "choose_pedro_source",
        playerId: player.id,
        toPlayerId: player.id,
        canUseDiscard: true,
        pendingEndsAt: room.pendingEndsAt,
      });

      broadcastGameState(room);
      broadcastMeStates(room);
      return;
    }
  }

  finishStandardDraw(room, player, undefined);
}

export function finishStandardDraw(room: GameRoom, player: Player, firstCard?: Card) {
  const c1 = firstCard ?? drawCard(room);
  player.hand.push(c1);

  const c2 = drawCard(room);
  player.hand.push(c2);

  if (isChar(player, CHAR.blackjack)) {
    broadcastRoom(room, {
      type: "passive_triggered",
      roomCode: room.code,
      kind: "blackjack_reveal",
      playerId: player.id,
      revealed: c2,
    });

    if (isHeartsOrDiamonds(c2)) {
      try {
        player.hand.push(drawCard(room));
        broadcastRoom(room, {
          type: "passive_triggered",
          roomCode: room.code,
          kind: "blackjack_bonus_draw",
          playerId: player.id,
        });
      } catch {}
    }
  }

  room.phase = "main";
  room.pending = null;
  room.pendingEndsAt = undefined;

  maybeSuzyDraw(room, player);

  broadcastGameState(room);
  broadcastMeStates(room);
}

/** ===== Multi-target effects: Indians / Gatling ===== */
export function buildOtherPlayersOrder(room: GameRoom, attackerId: string): string[] {
  const arr = room.players as any[];
  const attackerIdx = arr.findIndex((p: Player) => p.id === attackerId);
  const n = arr.length;

  const list: string[] = [];
  for (let step = 1; step <= n; step++) {
    const i = (attackerIdx + step) % n;
    const p = arr[i] as Player;
    if (isTurnEligible(p) && p.id !== attackerId) list.push(p.id);
  }
  return list;
}

/** General Store: order of alive players starting from a given player (clockwise, includes start) */
export function buildAliveOrderFrom(room: GameRoom, startId: string): string[] {
  const arr = room.players as any[];
  const startIdx = arr.findIndex((p: Player) => p.id === startId);
  if (startIdx < 0) return alivePlayers(room).map((p) => p.id);

  const order: string[] = [];
  let cur = startIdx;

  for (let step = 0; step < arr.length; step++) {
    const p = arr[cur] as Player;
    if (isTurnEligible(p)) order.push(p.id);

    const nxt = nextAliveIndex(room, cur);
    if (nxt < 0 || nxt === startIdx) break;
    cur = nxt;
  }

  return order;
}

export function continueGeneralStore(room: GameRoom) {
  const pend = room.pending;
  if (!pend || pend.kind !== "general_store") return;

  while (pend.idx < pend.order.length && pend.offered.length > 0) {
    const pickerId = pend.order[pend.idx];
    const picker = getPlayer(room, pickerId);

    if (!picker || !isTurnEligible(picker)) {
      pend.idx++;
      continue;
    }

    // ✅ last forced pick still needs a visible event
    if (pend.offered.length === 1) {
      const last = pend.offered.pop()!;
      picker.hand.push(last);

      broadcastRoom(room, {
        type: "general_store_pick",
        roomCode: room.code,
        ts: Date.now(),
        pickerId: picker.id,
        card: last,
        remaining: pend.offered,
        nextPickerId: pend.order[pend.idx + 1] ?? null,
      });

      maybeSuzyDraw(room, picker);
      pend.idx++;
      continue;
    }

    room.phase = "waiting";
    room.pendingEndsAt = Date.now() + RESPONSE_MS;

    // ✅ public update so UI for everyone stays synced
    broadcastRoom(room, {
      type: "general_store_update",
      roomCode: room.code,
      ts: Date.now(),
      idx: pend.idx,
      pickerId: picker.id,
      offered: pend.offered,
      pendingEndsAt: room.pendingEndsAt,
    });

    safeSend((picker as any).ws, {
      type: "action_required",
      roomCode: room.code,
      kind: "choose_general_store",
      playerId: picker.id,
      pickerId: picker.id,
      toPlayerId: picker.id,
      cards: pend.offered,
      pendingEndsAt: room.pendingEndsAt,
    });

    broadcastGameState(room);
    broadcastMeStates(room);
    return;
  }

  // safety: if anything left (shouldn't), discard them
  if (pend.offered.length > 0) {
    while (pend.offered.length) discard(room, pend.offered.pop()!);
  }

  room.phase = "main";
  room.pending = null;
  room.pendingEndsAt = undefined;

  broadcastRoom(room, { type: "action_resolved", roomCode: room.code, kind: "general_store_done" });
  broadcastGameState(room);
  broadcastMeStates(room);
}

export function continueIndians(room: GameRoom) {
  const pend = room.pending;
  if (!pend || pend.kind !== "indians") return;

  while (pend.idx < pend.targets.length) {
    const targetId = pend.targets[pend.idx];
    const target = getPlayer(room, targetId);
    if (!target || !isTurnEligible(target)) {
      pend.idx++;
      continue;
    }

    if (hasNoHandCards(target)) {
      resolveIndiansWithoutResponse(room, pend, target);
      return;
    }

    room.phase = "waiting";
    room.pendingEndsAt = Date.now() + RESPONSE_MS;

    safeSend((target as any).ws, {
      type: "action_required",
      roomCode: room.code,
      kind: "respond_to_indians",
      toPlayerId: target.id,
      targetId: target.id,
      fromPlayerId: pend.attackerId,
      pendingEndsAt: room.pendingEndsAt,
    });

    broadcastGameState(room);
    broadcastMeStates(room);
    return;
  }

  room.phase = "main";
  room.pending = null;
  room.pendingEndsAt = undefined;

  broadcastRoom(room, {
    type: "action_resolved",
    roomCode: room.code,
    kind: "indians_done",
    attackerId: pend.attackerId,
  });

  broadcastGameState(room);
  broadcastMeStates(room);
}

export function openBangResponse(room: GameRoom, args: { attackerId: string; targetId: string; requiredMissed: number; missedSoFar: number }) {
  const { attackerId, targetId, requiredMissed, missedSoFar } = args;
  const target = getPlayer(room, targetId);
  if (!target || !target.isAlive) {
    broadcastGameState(room);
    broadcastMeStates(room);
    return;
  }

  const remainingMissed = Math.max(0, Number(requiredMissed ?? 1) - Number(missedSoFar ?? 0));
  const barrelResponsesAvailable = barrelLikeCount(target);
  if (remainingMissed > 0 && barrelResponsesAvailable <= 0 && hasNoHandCards(target)) {
    resolveBangWithoutResponse(room, { attackerId, target });
    return;
  }

  room.phase = "waiting";
  room.pending = {
    kind: "bang",
    attackerId,
    targetId,
    requiredMissed,
    missedSoFar,
  } as any;
  room.pendingEndsAt = Date.now() + RESPONSE_MS;

  safeSend((target as any).ws, {
    type: "action_required",
    roomCode: room.code,
    kind: "respond_to_bang",
    toPlayerId: target.id,
    targetId: target.id,
    fromPlayerId: attackerId,
    requiredMissed,
    missedSoFar,
    pendingEndsAt: room.pendingEndsAt,
  });

  broadcastGameState(room);
  broadcastMeStates(room);
}

export function openBarrelChoice(room: GameRoom, args: {
  source: "bang";
  attackerId: string;
  targetId: string;
  barrelChecksRemaining: number;
  requiredMissed?: number;
  missedSoFar?: number;
}) {
  const target = getPlayer(room, args.targetId);
  if (!target || !target.isAlive) {
    broadcastGameState(room);
    broadcastMeStates(room);
    return;
  }

  room.phase = "waiting";
  room.pending = {
    kind: "barrel_choice",
    ...args,
    toPlayerId: target.id,
  } as any;
  room.pendingEndsAt = Date.now() + RESPONSE_MS;

  safeSend((target as any).ws, {
    type: "action_required",
    roomCode: room.code,
    kind: "choose_barrel",
    toPlayerId: target.id,
    targetId: target.id,
    fromPlayerId: args.attackerId,
    source: "bang",
    barrelChecksRemaining: args.barrelChecksRemaining,
    requiredMissed: args.requiredMissed,
    missedSoFar: args.missedSoFar ?? 0,
    pendingEndsAt: room.pendingEndsAt,
  });

  broadcastGameState(room);
  broadcastMeStates(room);
}

export function continueAfterBarrelBang(
  room: GameRoom,
  args: { attackerId: string; targetId: string; requiredMissed: number; missedSoFar: number; barrelChecksRemaining: number },
  usedBarrel: boolean,
  success: boolean
) {
  const { attackerId, targetId, requiredMissed } = args;
  const missedSoFar = Number(args.missedSoFar ?? 0) + (usedBarrel && success ? 1 : 0);
  const remainingChecks = Math.max(0, Number(args.barrelChecksRemaining ?? 0) - (usedBarrel ? 1 : 0));

  const target = getPlayer(room, targetId);
  if (!target || !target.isAlive) {
    broadcastGameState(room);
    broadcastMeStates(room);
    return;
  }

  const remainingMissed = requiredMissed - missedSoFar;
  if (remainingMissed <= 0) {
    room.phase = "main";
    room.pending = null;
    room.pendingEndsAt = undefined;

    broadcastRoom(room, {
      type: "action_resolved",
      roomCode: room.code,
      kind: "bang_dodged_barrel",
      attackerId,
      targetId,
    });

    broadcastGameState(room);
    broadcastMeStates(room);
    return;
  }

  if (remainingChecks > 0) {
    openBarrelChoice(room, {
      source: "bang",
      attackerId,
      targetId,
      requiredMissed,
      missedSoFar,
      barrelChecksRemaining: remainingChecks,
    });

    broadcastRoom(room, {
      type: "action_resolved",
      roomCode: room.code,
      kind: "bang_partial_missed",
      attackerId,
      targetId,
      remaining: remainingMissed,
    });
    return;
  }

  openBangResponse(room, {
    attackerId,
    targetId,
    requiredMissed,
    missedSoFar,
  });

  if (missedSoFar > 0) {
    broadcastRoom(room, {
      type: "action_resolved",
      roomCode: room.code,
      kind: "bang_partial_missed",
      attackerId,
      targetId,
      remaining: remainingMissed,
    });
  }
}

export function continueGatling(room: GameRoom) {
  const pend = room.pending;
  if (!pend || pend.kind !== "gatling") return;

  while (pend.idx < pend.targets.length) {
    const targetId = pend.targets[pend.idx];
    const target = getPlayer(room, targetId);
    if (!target || !isTurnEligible(target)) {
      pend.idx++;
      continue;
    }

    if (hasNoHandCards(target)) {
      resolveGatlingWithoutResponse(room, pend, target);
      return;
    }

    // IMPORTANT (Bang rules): Barrel/Jourdonnais do NOT help vs Gatling.
    room.phase = "waiting";
    room.pendingEndsAt = Date.now() + RESPONSE_MS;

    safeSend((target as any).ws, {
      type: "action_required",
      roomCode: room.code,
      kind: "respond_to_gatling",
      fromPlayerId: pend.attackerId,
      pendingEndsAt: room.pendingEndsAt,
    });

    broadcastGameState(room);
    broadcastMeStates(room);
    return;
  }

  room.phase = "main";
  room.pending = null;
  room.pendingEndsAt = undefined;

  broadcastRoom(room, {
    type: "action_resolved",
    roomCode: room.code,
    kind: "gatling_done",
    attackerId: pend.attackerId,
  });

  broadcastGameState(room);
  broadcastMeStates(room);
}

/** ===== Duel ===== */
export function promptDuel(room: GameRoom, pend: Extract<PendingBase, { kind: "duel" }>) {
  const responder = getPlayer(room, pend.responderId);
  if (!responder || !responder.isAlive) {
    room.phase = "main";
    room.pending = null;
    room.pendingEndsAt = undefined;
    broadcastGameState(room);
    broadcastMeStates(room);
    return;
  }

  if (hasNoHandCards(responder)) {
    resolveDuelWithoutResponse(room, pend, responder);
    return;
  }

  room.phase = "waiting";
  room.pendingEndsAt = Date.now() + RESPONSE_MS;

  safeSend((responder as any).ws, {
    type: "action_required",
    roomCode: room.code,
    kind: "respond_to_duel",
    toPlayerId: responder.id,
    responderId: responder.id,
    opponentId: pend.responderId === pend.targetId ? pend.initiatorId : pend.targetId,
    pendingEndsAt: room.pendingEndsAt,
  });

  broadcastGameState(room);
  broadcastMeStates(room);
}

/** ===== end turn helpers (discard to hp) ===== */
export function openDiscardLimit(room: GameRoom, player: Player, after: "end_turn_manual") {
  const need = Math.max(0, player.hand.length - player.hp);
  if (need <= 0) return false;

  room.phase = "waiting";
  room.pending = { kind: "discard_limit", playerId: player.id, need, after };
  room.pendingEndsAt = pendingDeadlineFromTurn(room);

  safeSend((player as any).ws, {
    type: "action_required",
    roomCode: room.code,
    kind: "discard_to_limit",
    playerId: player.id,
    toPlayerId: player.id,
    need,
    pendingEndsAt: room.pendingEndsAt,
  });

  broadcastGameState(room);
  broadcastMeStates(room);
  return true;
}

export function discardRandomFromHand(room: GameRoom, player: Player, count: number) {
  const discardedCards: Card[] = [];
  for (let i = 0; i < count; i++) {
    if (player.hand.length === 0) break;
    const j = Math.floor(Math.random() * player.hand.length);
    const [c] = player.hand.splice(j, 1);
    if (c) {
      discard(room, c);
      discardedCards.push(c);
    }
  }
  maybeSuzyDraw(room, player);
  return discardedCards;
}

/** ===== Turn-start: Dynamite then Jail ===== */
export function resolveDynamiteAtTurnStart(room: GameRoom, player: Player): "ok" | "waiting" {
  const dyn = takeEquipment(player, "dynamite");
  if (!dyn) return "ok";

  const lucky = isChar(player, CHAR.lucky);
  if (lucky) {
    return startLuckyChoice(room, player, "dynamite", {
      kind: "turn_start_dynamite",
      playerId: player.id,
      dynCard: dyn,
    });
  }

  const c = drawOneForCheck(room);
  const exploded = isDynamiteExplosionCard(c);

  broadcastRoom(room, {
    type: "draw_check",
    roomCode: room.code,
    kind: "dynamite",
    playerId: player.id,
    drawn: [c],
    chosen: c,
    exploded,
  });

  if (exploded) {
    discard(room, dyn);
    const opened = applyDamage(room, player, 3, undefined, { kind: "turn_start", stage: "jail", playerId: player.id });
    broadcastRoom(room, {
      type: "action_resolved",
      roomCode: room.code,
      kind: "dynamite_exploded",
      playerId: player.id,
      newHp: player.hp,
      isAlive: player.isAlive,
    });

    if (opened) return "waiting";
    return "ok";
  }

  // pass to next alive
  const idx = (room.players as any[]).findIndex((p: Player) => p.id === player.id);
  const nextIdx = nextAliveIndex(room, idx >= 0 ? idx : (room.turnIndex ?? 0));
  const nextP = nextIdx >= 0 ? ((room.players as any[])[nextIdx] as Player | undefined) : undefined;

  if (!nextP || nextP.id === player.id) {
    player.equipment.push(dyn);
    return "ok";
  }

  nextP.equipment.push(dyn);

  broadcastRoom(room, {
    type: "action_resolved",
    roomCode: room.code,
    kind: "dynamite_passed",
    fromPlayerId: player.id,
    toPlayerId: nextP.id,
  });

  return "ok";
}

export function resolveJailAtTurnStart(room: GameRoom, player: Player): "ok" | "skip" | "waiting" {
  const jail = takeEquipment(player, "jail");
  if (!jail) return "ok";

  const lucky = isChar(player, CHAR.lucky);
  if (lucky) {
    return startLuckyChoice(room, player, "jail", {
      kind: "turn_start_jail",
      playerId: player.id,
      jailCard: jail,
    });
  }

  const c = drawOneForCheck(room);
  const freed = isHearts(c);

  discard(room, jail);

  broadcastRoom(room, {
    type: "draw_check",
    roomCode: room.code,
    kind: "jail",
    playerId: player.id,
    drawn: [c],
    chosen: c,
    freed,
  });

  if (freed) return "ok";

  broadcastRoom(room, {
    type: "action_resolved",
    roomCode: room.code,
    kind: "jail_skip_turn",
    playerId: player.id,
  });

  return "skip";
}

/** ===== TURN FLOW ===== */
export function runTurnStart(room: GameRoom, player: Player, stage: "dynamite" | "jail" | "draw") {
  if (!room.started || room.ended) return;

  if (stage === "dynamite") {
    const res = resolveDynamiteAtTurnStart(room, player);
    if (res === "waiting") return;
    if (room.ended) return;
    return runTurnStart(room, player, "jail");
  }

  if (stage === "jail") {
    const jailRes = resolveJailAtTurnStart(room, player);
    if (jailRes === "waiting") return;

    if (jailRes === "skip") {
      if (room.ended) return;
      const nxt = nextAliveIndex(room, room.turnIndex ?? 0);
      if (nxt < 0) {
        checkGameOver(room);
        return;
      }
      room.turnIndex = nxt;
      startTurn(room);
      return;
    }

    return runTurnStart(room, player, "draw");
  }

  // stage === "draw"
  startDrawPhase(room, player);
}

export function startTurn(room: GameRoom) {
  ensureRuntime(room);
  if (!room.started || room.ended) return;

  checkGameOver(room);
  if (room.ended) return;

  let cur = currentPlayer(room);
  if (!isTurnEligible(cur)) {
    const nxt = nextAliveIndex(room, room.turnIndex ?? 0);
    if (nxt < 0) {
      checkGameOver(room);
      return;
    }
    room.turnIndex = nxt;
    cur = currentPlayer(room);
  }

  const player = currentPlayer(room);
  if (!isTurnEligible(player)) {
    checkGameOver(room);
    return;
  }

  // reset turn state
  room.pending = null;
  room.pendingEndsAt = undefined;
  room.bangsUsedThisTurn = 0;
  room.phase = "main";
  room.turnPausedAt = undefined;

  const now = Date.now();
  room.turnEndsAt = now + TURN_MS;

  broadcastRoom(room, {
    type: "turn_started",
    roomCode: room.code,
    serverNow: now,
    turnPlayerId: player.id,
    turnEndsAt: room.turnEndsAt,
  });

  runTurnStart(room, player, "dynamite");
}

/** Advance only if no pending */
export function advanceTurn(room: GameRoom, reason: "manual" | "timeout" | "jail_skip" | "disconnect") {
  ensureRuntime(room);
  if (!room.started || room.ended) return;
  if (room.phase !== "main") return;

  const prev = currentPlayer(room);
  const nxt = nextAliveIndex(room, room.turnIndex ?? 0);
  if (nxt < 0) {
    checkGameOver(room);
    return;
  }

  const nextPlayer = ((room.players as any[])[nxt] as Player | undefined) ?? null;

  broadcastRoom(room, {
    type: "turn_ended",
    roomCode: room.code,
    serverNow: Date.now(),
    reason,
    prevPlayerId: prev?.id ?? null,
    nextPlayerId: nextPlayer?.id ?? null,
  });

  room.turnIndex = nxt;
  startTurn(room);
}


/** ================= RESOLVE HELPERS FOR CHOICES ================= */
export function resolveDrawChoice(room: GameRoom, player: Player, chosenIds: string[]) {
  if (!room.pending || room.pending.kind !== "draw_choice") throw new Error("No draw choice pending");
  const pend = room.pending;
  if (pend.playerId !== player.id) throw new Error("Not your draw choice");
  if (currentPlayer(room).id !== player.id) throw new Error("Not your turn");

  const uniq = Array.from(new Set(chosenIds));
  if (uniq.length !== pend.pickCount) throw new Error(`Pick exactly ${pend.pickCount} cards`);

  const byId = new Map(pend.offered.map((c) => [String((c as any).id), c]));
  const chosen: Card[] = [];
  for (const id of uniq) {
    const c = byId.get(String(id));
    if (!c) throw new Error("Bad cardId");
    chosen.push(c);
  }

  const remaining = pend.offered.filter((c) => !uniq.includes(String((c as any).id)));
  player.hand.push(...chosen);

  room.deck ??= [];
  for (let i = remaining.length - 1; i >= 0; i--) {
    room.deck.push(remaining[i]);
  }

  room.pending = null;
  room.phase = "main";
  room.pendingEndsAt = undefined;

  broadcastRoom(room, {
    type: "action_resolved",
    roomCode: room.code,
    kind: "draw_choice_done",
    playerId: player.id,
    picked: chosen.length,
    returned: remaining.length,
  });

  maybeSuzyDraw(room, player);
  broadcastGameState(room);
  broadcastMeStates(room);
}

/** Jesse: choose target to steal first draw from (or skip) */
export function resolveJesseChoice(room: GameRoom, player: Player, targetId?: string) {
  if (!room.pending || room.pending.kind !== "jesse_choice") throw new Error("No Jesse choice pending");
  const pend = room.pending;
  if (pend.playerId !== player.id) throw new Error("Not your Jesse choice");

  room.pending = null;
  room.phase = "main";
  room.pendingEndsAt = undefined;

  let first: Card | undefined;

  if (targetId && pend.eligibleTargets.includes(targetId)) {
    const t = getPlayer(room, targetId);
    if (t && t.isAlive && t.hand.length > 0) {
      const j = Math.floor(Math.random() * t.hand.length);
      const [stolen] = t.hand.splice(j, 1);
      if (stolen) first = stolen;
      maybeSuzyDraw(room, t);
    }
  }

  broadcastRoom(room, {
    type: "action_resolved",
    roomCode: room.code,
    kind: "jesse_draw_choice",
    playerId: player.id,
    targetId: targetId ?? null,
    fromTarget: !!first,
  });


  finishStandardDraw(room, player, first);
}

/** Pedro: choose deck vs discard for first draw */
export function resolvePedroChoice(room: GameRoom, player: Player, source: "deck" | "discard") {
  if (!room.pending || room.pending.kind !== "pedro_choice") throw new Error("No Pedro choice pending");
  const pend = room.pending;
  if (pend.playerId !== player.id) throw new Error("Not your Pedro choice");

  room.pending = null;
  room.phase = "main";
  room.pendingEndsAt = undefined;

  let first: Card | undefined;

  if (source === "discard" && pend.canUseDiscard) {
    try {
      first = takeFromDiscard(room);
    } catch {
      first = undefined;
    }
  }

  broadcastRoom(room, {
    type: "action_resolved",
    roomCode: room.code,
    kind: "pedro_draw_choice",
    playerId: player.id,
    source,
    fromDiscard: !!first && source === "discard",
    ...(first ? { card: first } : {}),
  });

  finishStandardDraw(room, player, first);
}

/** Lucky Duke chooses which card counts for a Draw! */
export function resolveLuckyChoice(room: GameRoom, player: Player, chosenCardId: string) {
  if (!room.pending || room.pending.kind !== "lucky_choice") throw new Error("No lucky_choice pending");
  const pend = room.pending;
  if (pend.playerId !== player.id) throw new Error("Not your lucky choice");

  const chosen = pend.options.find((c) => String((c as any).id) === String(chosenCardId));
  if (!chosen) throw new Error("Bad cardId");

  const success = evalDrawSuccess(pend.drawKind, chosen);

  // broadcast draw reveal + chosen
  broadcastRoom(room, {
    type: "draw_check",
    roomCode: room.code,
    kind: pend.drawKind,
    playerId: player.id,
    drawn: pend.options,
    chosen,
    success,
    exploded: pend.drawKind === "dynamite" ? !success : undefined,
    freed: pend.drawKind === "jail" ? success : undefined,
  });

  // clear pending
  room.pending = null;
  room.pendingEndsAt = undefined;
  room.phase = "main";

  // resume action
  const resume = pend.resume;

  if (resume.kind === "turn_start_dynamite") {
    const dyn = resume.dynCard;

    if (!success) {
      // exploded
      discard(room, dyn);
      const opened = applyDamage(room, player, 3, undefined, { kind: "turn_start", stage: "jail", playerId: player.id });

      broadcastRoom(room, {
        type: "action_resolved",
        roomCode: room.code,
        kind: "dynamite_exploded",
        playerId: player.id,
        newHp: player.hp,
        isAlive: player.isAlive,
      });

      broadcastGameState(room);
      broadcastMeStates(room);

      if (opened) return;
      if (room.ended) return;

      return runTurnStart(room, player, "jail");
    }

    // safe => pass dynamite
    const idx = (room.players as any[]).findIndex((p: Player) => p.id === player.id);
    const nextIdx = nextAliveIndex(room, idx >= 0 ? idx : (room.turnIndex ?? 0));
    const nextP = nextIdx >= 0 ? ((room.players as any[])[nextIdx] as Player | undefined) : undefined;

    if (!nextP || nextP.id === player.id) player.equipment.push(dyn);
    else nextP.equipment.push(dyn);

    broadcastRoom(room, {
      type: "action_resolved",
      roomCode: room.code,
      kind: "dynamite_passed",
      fromPlayerId: player.id,
      toPlayerId: nextP?.id ?? player.id,
    });

    broadcastGameState(room);
    broadcastMeStates(room);

    return runTurnStart(room, player, "jail");
  }

  if (resume.kind === "turn_start_jail") {
    const jail = resume.jailCard;
    discard(room, jail);

    if (success) {
      broadcastRoom(room, {
        type: "action_resolved",
        roomCode: room.code,
        kind: "jail_freed",
        playerId: player.id,
      });
      broadcastGameState(room);
      broadcastMeStates(room);
      return runTurnStart(room, player, "draw");
    }

    broadcastRoom(room, {
      type: "action_resolved",
      roomCode: room.code,
      kind: "jail_skip_turn",
      playerId: player.id,
    });

    broadcastGameState(room);
    broadcastMeStates(room);

    // skip turn
    const nxt = nextAliveIndex(room, room.turnIndex ?? 0);
    if (nxt < 0) {
      checkGameOver(room);
      return;
    }
    room.turnIndex = nxt;
    startTurn(room);
    return;
  }

  if (resume.kind === "barrel_vs_bang") {
    continueAfterBarrelBang(
      room,
      {
        attackerId: resume.attackerId,
        targetId: resume.targetId,
        requiredMissed: resume.requiredMissed,
        missedSoFar: resume.missedSoFar,
        barrelChecksRemaining: resume.barrelChecksRemaining + 1,
      },
      true,
      !!success
    );
    return;
  }

  if (resume.kind === "barrel_vs_gatling") {
    const attackerId = resume.attackerId;
    const targetId = resume.targetId;

    const target = getPlayer(room, targetId);

    if (!target || !target.isAlive) {
      room.phase = "main";
      room.pending = {
        kind: "gatling",
        attackerId,
        targets: resume.targets,
        idx: resume.idx + 1,
      };
      room.pendingEndsAt = undefined;
      continueGatling(room);
      return;
    }

    if (success) {
      room.phase = "main";
      room.pending = {
        kind: "gatling",
        attackerId,
        targets: resume.targets,
        idx: resume.idx + 1,
      };
      room.pendingEndsAt = undefined;

      broadcastRoom(room, {
        type: "action_resolved",
        roomCode: room.code,
        kind: "gatling_defended_barrel",
        attackerId,
        targetId,
      });

      continueGatling(room);
      return;
    }

    if (resume.barrelChecksRemaining > 0) {
      const nextRes = startBarrelDraw(room, target, {
        kind: "barrel_vs_gatling",
        attackerId,
        targetId,
        targets: resume.targets,
        idx: resume.idx,
        barrelChecksRemaining: resume.barrelChecksRemaining - 1,
      });

      if (nextRes.kind === "waiting") return;

      if (nextRes.success) {
        room.phase = "main";
        room.pending = {
          kind: "gatling",
          attackerId,
          targets: resume.targets,
          idx: resume.idx + 1,
        };
        room.pendingEndsAt = undefined;

        broadcastRoom(room, {
          type: "action_resolved",
          roomCode: room.code,
          kind: "gatling_defended_barrel",
          attackerId,
          targetId,
        });

        continueGatling(room);
        return;
      }
    }

    room.phase = "waiting";
    room.pending = {
      kind: "gatling",
      attackerId,
      targets: resume.targets,
      idx: resume.idx,
    };
    room.pendingEndsAt = Date.now() + RESPONSE_MS;

    safeSend((target as any).ws, {
      type: "action_required",
      roomCode: room.code,
      kind: "respond_to_gatling",
      toPlayerId: targetId,
      targetId,
      fromPlayerId: attackerId,
      pendingEndsAt: room.pendingEndsAt,
    });

    broadcastGameState(room);
    broadcastMeStates(room);
    return;
  }

  broadcastGameState(room);
  broadcastMeStates(room);
}

export function isPendingWaitingOnPlayer(room: GameRoom, playerId: string) {
  const pend = room.pending as any;
  if (!pend || !playerId) return false;

  switch (pend.kind) {
    case "bang":
      return pend.targetId === playerId;
    case "indians":
    case "gatling":
      return pend.targets?.[pend.idx] === playerId;
    case "duel":
      return pend.responderId === playerId;
    case "general_store":
      return pend.order?.[pend.idx] === playerId;
    case "draw_choice":
    case "jesse_choice":
    case "pedro_choice":
    case "discard_limit":
    case "revive":
    case "lucky_choice":
      return pend.playerId === playerId;
    default:
      return false;
  }
}

export function handlePlayerDisconnectDuringGame(room: GameRoom, playerId: string) {
  ensureRuntime(room);
  if (!room.started || room.ended || !playerId) return false;

  if (room.phase === "waiting" && isPendingWaitingOnPlayer(room, playerId)) {
    resolvePendingTimeout(room);
    return true;
  }

  if (room.phase === "main") {
    const cur = currentPlayer(room);
    if (cur?.id === playerId) {
      advanceTurn(room, "disconnect");
      return true;
    }
  }

  return false;
}

/** ===== MAIN TIMER LOOP ===== */
export function resolvePendingTimeout(room: GameRoom) {
  if (!room.pending) return;

  const pend = room.pending;

  // Lucky choice timeout: auto choose first
  if (pend.kind === "lucky_choice") {
    const p = getPlayer(room, pend.playerId);
    const chosen = pend.options[0];
    if (!p || !p.isAlive) {
      room.pending = null;
      room.phase = "main";
      room.pendingEndsAt = undefined;
      broadcastGameState(room);
      broadcastMeStates(room);
      return;
    }
    resolveLuckyChoice(room, p, (chosen as any).id);
    return;
  }

  // revive timeout: die
  if (pend.kind === "revive") {
    const dying = getPlayer(room, pend.playerId);
    const resume = pend.resume ?? null;
    const attackerId = pend.attackerId;

    room.pending = null;
    room.phase = "main";
    room.pendingEndsAt = undefined;

    if (dying && dying.isAlive) {
      killNow(room, dying, attackerId);
      broadcastRoom(room, {
        type: "action_resolved",
        roomCode: room.code,
        kind: "revive_timeout_died",
        playerId: dying.id,
      });
    }

    broadcastGameState(room);
    broadcastMeStates(room);

    if (room.ended) return;

    // resume chain / flow
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
        } else if (cur && !cur.isAlive) {
          const nxt = nextAliveIndex(room, room.turnIndex ?? 0);
          if (nxt >= 0) {
            room.turnIndex = nxt;
            startTurn(room);
          } else {
            checkGameOver(room);
          }
        }
        return;
      }
    }

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

    return;
  }

  // Kit draw_choice timeout: auto pick first 2
  if (pend.kind === "draw_choice") {
    const p = getPlayer(room, pend.playerId);
    if (p && p.isAlive) {
      const autoPick = pend.offered.slice(0, pend.pickCount).map((c) => (c as any).id);
      resolveDrawChoice(room, p, autoPick);
    } else {
      for (const c of pend.offered) discard(room, c);
      room.pending = null;
      room.phase = "main";
      room.pendingEndsAt = undefined;
      broadcastGameState(room);
      broadcastMeStates(room);
    }
    return;
  }

  // Jesse choice timeout: skip
  if (pend.kind === "jesse_choice") {
    const p = getPlayer(room, pend.playerId);
    room.pending = null;
    room.phase = "main";
    room.pendingEndsAt = undefined;
    if (p && p.isAlive) finishStandardDraw(room, p, undefined);
    return;
  }

  // Pedro choice timeout: default deck
  if (pend.kind === "pedro_choice") {
    const p = getPlayer(room, pend.playerId);
    room.pending = null;
    room.phase = "main";
    room.pendingEndsAt = undefined;
    if (p && p.isAlive) finishStandardDraw(room, p, undefined);
    return;
  }

  // General Store timeout: auto pick random
  if (pend.kind === "general_store") {
    const pickerId = pend.order[pend.idx];
    const p = pickerId ? getPlayer(room, pickerId) : undefined;

    if (p && p.isAlive && pend.offered.length > 0) {
      const j = Math.floor(Math.random() * pend.offered.length);
      const [chosen] = pend.offered.splice(j, 1);
      if (chosen) {
        p.hand.push(chosen);
        broadcastCardPlayed(room, {
          action: "respond",
          playerId: p.id,
          cardKey: cardKey(chosen),
          cardId: (chosen as any).id,
          context: "general_store_pick_timeout",
        });
        maybeSuzyDraw(room, p);
      }
    }

    pend.idx++;
    continueGeneralStore(room);
    return;
  }

  // discard_limit timeout: discard random then end turn
  if (pend.kind === "discard_limit") {
    const p = getPlayer(room, pend.playerId);
    const discardedCards = p && p.isAlive ? discardRandomFromHand(room, p, pend.need) : [];

    room.pending = null;
    room.phase = "main";
    room.pendingEndsAt = undefined;

    broadcastRoom(room, {
      type: "action_resolved",
      roomCode: room.code,
      kind: "discard_limit_done",
      playerId: pend.playerId,
      discardedCards,
    });

    broadcastGameState(room);
    broadcastMeStates(room);

    if (pend.after === "end_turn_manual") {
      advanceTurn(room, "manual");
    }
    return;
  }

  // action-response timeouts
  if (pend.kind === "bang") {
    const target = getPlayer(room, pend.targetId);

    room.pending = null;
    room.phase = "main";
    room.pendingEndsAt = undefined;

    const opened = target && target.isAlive ? applyDamage(room, target, 1, pend.attackerId) : false;
    if (opened) return;

    broadcastRoom(room, {
      type: "action_resolved",
      roomCode: room.code,
      kind: "bang_timeout_hit",
      attackerId: pend.attackerId,
      targetId: pend.targetId,
    });

    if (target) maybeSuzyDraw(room, target);
    broadcastGameState(room);
    broadcastMeStates(room);
    return;
  }

  if (pend.kind === "indians") {
    const targetId = pend.targets[pend.idx];
    const target = getPlayer(room, targetId);

    if (target && target.isAlive) {
      const resume: PendingBase = {
        kind: "indians",
        attackerId: pend.attackerId,
        targets: pend.targets,
        idx: pend.idx + 1,
      };
      broadcastRoom(room, {
        type: "action_resolved",
        roomCode: room.code,
        kind: "indians_hit",
        attackerId: pend.attackerId,
        targetId,
      });

      const opened = applyDamage(room, target, 1, pend.attackerId, resume);
      if (opened) return;
    }

    pend.idx++;
    continueIndians(room);
    return;
  }

  if (pend.kind === "gatling") {
    const targetId = pend.targets[pend.idx];
    const target = getPlayer(room, targetId);

    if (target && target.isAlive) {
      const resume: PendingBase = {
        kind: "gatling",
        attackerId: pend.attackerId,
        targets: pend.targets,
        idx: pend.idx + 1,
      };
      broadcastRoom(room, {
        type: "action_resolved",
        roomCode: room.code,
        kind: "gatling_hit",
        attackerId: pend.attackerId,
        targetId,
      });
      const opened = applyDamage(room, target, 1, pend.attackerId, resume);
      if (opened) return;
    }

    pend.idx++;
    continueGatling(room);
    return;
  }

  if (pend.kind === "duel") {
    const loser = getPlayer(room, pend.responderId);
    const winnerId = pend.responderId === pend.targetId ? pend.initiatorId : pend.targetId;

    room.pending = null;
    room.phase = "main";
    room.pendingEndsAt = undefined;

    const opened = loser && loser.isAlive ? applyDamage(room, loser, 1, winnerId) : false;
    if (opened) return;

    broadcastRoom(room, {
      type: "action_resolved",
      roomCode: room.code,
      kind: "duel_timeout_lose",
      loserId: pend.responderId,
    });

    broadcastGameState(room);
    broadcastMeStates(room);
    return;
  }
}

