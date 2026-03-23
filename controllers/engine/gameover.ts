import type { Player } from "../../models/player";
import type { GameRoom, ResumeAfterRevive } from "./types";
import { activeAlivePlayers, maybeSuzyDraw, discard, drawCard, ensureCardMeta } from "./runtime";
import { broadcastRoom, broadcastGameState, broadcastMeStates, safeSend } from "./broadcast";
import { getPlayer } from "./players";
import { CHAR } from "./types";
import { isChar } from "./utils";

export function checkGameOver(room: GameRoom) {
  if (!room.started || room.ended) return;

  const activeAlive = activeAlivePlayers(room);
  const sheriff = (room.players as any[]).find((p: Player) => p.role === "sheriff") as Player | undefined;
  const sheriffActive = !!sheriff?.isAlive && !(sheriff as any)?.disconnected;

  const anyOutlawAlive = activeAlive.some((p) => p.role === "outlaw");
  const anyRenegadeAlive = activeAlive.some((p) => p.role === "renegade");

  let winner: "outlaws" | "renegade" | "sheriff" | null = null;

  if (!sheriffActive) {
    if (activeAlive.length === 1 && activeAlive[0].role === "renegade") winner = "renegade";
    else winner = "outlaws";
  } else {
    if (!anyOutlawAlive && !anyRenegadeAlive) winner = "sheriff";
  }

  if (!winner) return;

  room.ended = true;
  room.started = false;
  room.phase = "main" as any;
  room.pending = null as any;
  room.pendingEndsAt = undefined;

  const alivePlayerIds = activeAlive.map((p) => p.id);
  const winners = activeAlive
    .filter((p: Player) => {
      if (winner === "outlaws") return p.role === "outlaw";
      if (winner === "renegade") return p.role === "renegade";
      if (winner === "sheriff") return p.role === "sheriff" || p.role === "deputy";
      return false;
    })
    .map((p: Player) => p.id);

  broadcastRoom(room, {
    type: "game_over",
    roomCode: room.code,
    winner,
    alivePlayerIds,
    winners,
    players: (room.players as any[]).map((p: Player) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      isAlive: p.isAlive,
      disconnected: !!(p as any).disconnected,
    })),
  });

  broadcastGameState(room);
  broadcastMeStates(room);
}


function discardAllOfPlayer(room: GameRoom, p: Player) {
  const hand = p.hand.splice(0);
  const eq = p.equipment.splice(0);
  for (const c of hand) discard(room, c);
  for (const c of eq) discard(room, c);
  maybeSuzyDraw(room, p);
}

export function killNow(room: GameRoom, target: Player, attackerId?: string) {
  if (!target.isAlive) return;

  const attacker = attackerId ? getPlayer(room, attackerId) : undefined;
  target.isAlive = false;

  if (attacker && attacker.isAlive && attacker.id !== target.id) {
    if (target.role === "outlaw") {
      try {
        attacker.hand.push(drawCard(room), drawCard(room), drawCard(room));
      } catch {}
      broadcastRoom(room, {
        type: "passive_triggered",
        roomCode: room.code,
        kind: "kill_reward_outlaw",
        killerId: attacker.id,
        victimId: target.id,
      });
    }

    if (attacker.role === "sheriff" && target.role === "deputy") {
      discardAllOfPlayer(room, attacker);
      broadcastRoom(room, {
        type: "passive_triggered",
        roomCode: room.code,
        kind: "sheriff_killed_deputy_penalty",
        sheriffId: attacker.id,
        deputyId: target.id,
      });
    }
  }

  const vulture = (room.players as any[]).find(
    (p: Player) => p.isAlive && isChar(p as Player, CHAR.vulture) && (p as Player).id !== target.id
  ) as Player | undefined;

  const hand = target.hand.splice(0);
  const eq = target.equipment.splice(0);

  if (vulture) {
    vulture.hand.push(...hand, ...eq);
    broadcastRoom(room, {
      type: "passive_triggered",
      roomCode: room.code,
      kind: "vulture_loot",
      vultureId: vulture.id,
      victimId: target.id,
      cardsCount: hand.length + eq.length,
    });
  } else {
    for (const c of hand) discard(room, c);
    for (const c of eq) discard(room, c);
  }

  checkGameOver(room);

  maybeSuzyDraw(room, target);
  if (attacker) maybeSuzyDraw(room, attacker);
}

export function applyDamage(
  room: GameRoom,
  target: Player,
  amount: number,
  attackerId?: string,
  reviveResume?: ResumeAfterRevive
): boolean {
  const attacker = attackerId ? getPlayer(room, attackerId) : undefined;

  for (let i = 0; i < amount; i++) {
    if (!target.isAlive) break;

    target.hp -= 1;

    // ✅ El Gringo: steal random from attacker HAND each damage (private reveal للجرينو)
    if (attacker && attacker.id !== target.id && isChar(target, CHAR.elgringo) && attacker.hand.length > 0) {
      const j = Math.floor(Math.random() * attacker.hand.length);
      const [stolen] = attacker.hand.splice(j, 1);
      if (stolen) {
        ensureCardMeta(stolen);
        target.hand.push(stolen);

        // عام: فقط إنه صار steal (بدون كشف الكرت)
        broadcastRoom(room, {
          type: "passive_triggered",
          roomCode: room.code,
          kind: "elgringo_steal",
          gringoId: target.id,
          attackerId: attacker.id,
          fromZone: "hand",
          count: 1,
        });

        // خاص للجرينو: كشف الكرت عشان يقلبه بالـ UI
        safeSend((target as any).ws, {
          type: "private_reveal",
          roomCode: room.code,
          kind: "elgringo_steal",
          attackerId: attacker.id,
          revealedCard: ensureCardMeta(stolen),
        });

        maybeSuzyDraw(room, attacker);
      }
    }

    // ✅ Bart Cassidy: draw 1 each damage if still alive (private reveal لبارت)
    if (target.hp > 0 && isChar(target, CHAR.bart)) {
      try {
        const drawn = drawCard(room);
        ensureCardMeta(drawn);
        target.hand.push(drawn);

        broadcastRoom(room, {
          type: "passive_triggered",
          roomCode: room.code,
          kind: "bart_draw",
          playerId: target.id,
          count: 1,
        });

        safeSend((target as any).ws, {
          type: "private_reveal",
          roomCode: room.code,
          kind: "bart_draw",
          revealedCard: ensureCardMeta(drawn),
        });
      } catch {}
    }

    if (target.hp <= 0) {
      target.hp = 0;

      room.phase = "waiting";
      room.pending = {
        kind: "revive",
        playerId: target.id,
        attackerId,
        resume: reviveResume ?? null,
      };
      room.pendingEndsAt = Date.now() + 40_000;

      const reviveReason =
        reviveResume && typeof reviveResume === "object" && "kind" in reviveResume
          ? String((reviveResume as any).kind ?? "")
          : attackerId
          ? "attack"
          : "damage";

      safeSend((target as any).ws, {
        type: "action_required",
        roomCode: room.code,
        kind: "respond_to_revive",
        playerId: target.id,
        toPlayerId: target.id,
        attackerId: attackerId ?? null,
        reviveReason,
        pendingEndsAt: room.pendingEndsAt,
      });

      broadcastRoom(room, {
        type: "action_resolved",
        roomCode: room.code,
        kind: "player_dying",
        playerId: target.id,
        attackerId: attackerId ?? null,
      });

      broadcastGameState(room);
      broadcastMeStates(room);

      return true;
    }
  }

  maybeSuzyDraw(room, target);
  if (attacker) maybeSuzyDraw(room, attacker);
  return false;
}