import WebSocket from "ws";
import type { Player, Card } from "../../models/player";
import type { GameRoom } from "./types";
import { ensureCardMeta } from "./runtime";
import { PRIVATE_PENDING_KINDS } from "./types";
import { currentPlayer } from "./players";

export function safeSend(ws: any, obj: any) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch {}
}

export function broadcastRoom(room: GameRoom, obj: any) {
  for (const p of (room.players as any[]) || []) safeSend((p as any)?.ws, obj);
}

export function playerNameById(room: GameRoom, id?: string | null): string {
  if (!id) return "";
  const arr = ((room as any).players as any[]) || [];
  const p = arr.find((x: any) => String(x?.id) === String(id));
  return String(p?.name ?? "");
}

function pendingTargetId(pend: any): string | null {
  if (!pend || typeof pend !== "object") return null;
  const k = String((pend as any).kind ?? "").toLowerCase();

  if (k === "bang" || k === "barrel_choice") return String((pend as any).targetId ?? (pend as any).playerId ?? "") || null;
  if (k === "indians" || k === "gatling") {
    const targets = Array.isArray((pend as any).targets) ? (pend as any).targets : [];
    const idx = Number((pend as any).idx ?? -1);
    return String(targets[idx] ?? "") || null;
  }
  if (k === "duel") return String((pend as any).responderId ?? "") || null;
  if (
    k === "revive" ||
    k === "draw_choice" ||
    k === "jesse_choice" ||
    k === "pedro_choice" ||
    k === "discard_limit" ||
    k === "lucky_choice"
  ) {
    return String((pend as any).playerId ?? "") || null;
  }
  if (k === "general_store") {
    const order = Array.isArray((pend as any).order) ? (pend as any).order : [];
    const idx = Number((pend as any).idx ?? -1);
    return String(order[idx] ?? "") || null;
  }

  return null;
}

function isPersonalPendingKind(kind: string): boolean {
  return new Set([
    "bang",
    "indians",
    "gatling",
    "barrel_choice",
    "duel",
    "revive",
    "draw_choice",
    "jesse_choice",
    "pedro_choice",
    "discard_limit",
    "lucky_choice",
    "general_store",
  ]).has(kind);
}

function pendingOwnerId(pend: any): string | null {
  if (!pend || typeof pend !== "object") return null;
  const k = String((pend as any).kind ?? "").toLowerCase();
  if (k === "duel") return String((pend as any).responderId ?? "") || null;
  return pendingTargetId(pend);
}


function enrichPendingForClient(pend: any) {
  if (!pend || typeof pend !== "object") return pend;
  const k = String((pend as any).kind ?? "").toLowerCase();
  const targetId = pendingTargetId(pend);

  if (k === "general_store") {
    const order: string[] = (pend as any).order ?? [];
    const idx: number = (pend as any).idx ?? 0;
    return {
      kind: "general_store",
      initiatorId: (pend as any).initiatorId ?? null,
      order,
      idx,
      pickerId: order[idx] ?? null,
      targetId: targetId ?? null,
      toPlayerId: targetId ?? null,
      offered: ((pend as any).offered ?? []).map(ensureCardMeta),
    };
  }

  const next = { ...(pend as any) };
  if (targetId) {
    if (!("targetId" in next) || !next.targetId) next.targetId = targetId;
    if (!("toPlayerId" in next) || !next.toPlayerId) next.toPlayerId = targetId;
  }

  return next;
}

export function broadcastCardPlayed(
  room: GameRoom,
  evt: {
    playerId: string;
    cardKey: string;
    cardId?: string;
    targetId?: string;
    action?: "play" | "respond";
    context?: string;
    usedCardKey?: string;
    weaponKey?: string;
    weaponName?: string;
    card?: Card;
  }
) {
  broadcastRoom(room, {
    type: "card_played",
    roomCode: room.code,
    ts: Date.now(),
    ...evt,
    playerName: playerNameById(room, evt.playerId),
    targetName: evt.targetId ? playerNameById(room, evt.targetId) : undefined,
  });
}

export function broadcastCardDiscarded(room: GameRoom, card: Card) {
  broadcastRoom(room, {
    type: "card_discarded",
    roomCode: room.code,
    ts: Date.now(),
    card: ensureCardMeta(card),
  });
}

export function broadcastPlayerPassed(room: GameRoom, evt: { playerId: string; context?: string }) {
  broadcastRoom(room, {
    type: "player_passed",
    roomCode: room.code,
    ts: Date.now(),
    ...evt,
    playerName: playerNameById(room, evt.playerId),
  });
}

export function broadcastGameState(room: GameRoom) {
  const turnPlayerId = currentPlayer(room)?.id ?? null;

  let pendingPublic: any = room.pending ?? null;

  if (room.pending && typeof room.pending === "object") {
    const k = (room.pending as any).kind;

    // ✅ General Store public (الكل يشوف الأوراق)
    if (k === "general_store") {
      pendingPublic = enrichPendingForClient(room.pending);
    }
    // ✅ باقي الـ private pendings تنخبي
    else if (PRIVATE_PENDING_KINDS.has(k)) {
      const ownerId = pendingOwnerId(room.pending);
      pendingPublic = {
        kind: "private",
        playerId: ownerId,
        toPlayerId: ownerId,
        privateKind: k,
      };

      if (k === "draw_choice") {
        pendingPublic.pickCount = (room.pending as any).pickCount ?? 0;
      }
    } else {
      pendingPublic = enrichPendingForClient(room.pending);
    }
  }

  broadcastRoom(room, {
    type: "game_state",
    roomCode: room.code,
    serverNow: Date.now(),
    turnPlayerId,
    phase: room.phase,
    pending: pendingPublic,
    turnEndsAt: room.turnEndsAt ?? 0,
    pendingEndsAt: room.pendingEndsAt ?? 0,
    ended: !!room.ended,
    discardTop: room.discard?.length ? ensureCardMeta(room.discard[room.discard.length - 1]) : null,
    discardCount: room.discard?.length ?? 0,
    deckCount: room.deck?.length ?? 0,
    players: (room.players as any[]).map((p: Player) => ({
      id: p.id,
      name: p.name,

      // ✅ إخفاء الأدوار إلا sheriff أو ميت أو نهاية اللعبة
      role: p.role === "sheriff" || !p.isAlive || room.ended ? p.role : "unknown",

      playcharacter: p.playcharacter,
      hp: p.hp,
      maxHp: p.maxHp,
      isAlive: p.isAlive,
      equipment: (p.equipment ?? []).map(ensureCardMeta),
      handCount: (p.hand ?? []).length,
      disconnected: !!(p as any).disconnected,
      connectionLost: !(p as any)?.ws && !(p as any)?.disconnected && Number((p as any)?.reconnectDeadlineAt ?? 0) > Date.now(),
    })),
  });
}

export function broadcastMeStates(room: GameRoom) {
  const turnPlayerId = currentPlayer(room)?.id ?? null;

  for (const p of room.players as any[]) {
    const me = p as Player;
    let privatePending: any = room.pending ?? null;

    if (room.pending && typeof room.pending === "object") {
      const k = String((room.pending as any).kind ?? "").toLowerCase();
      const ownerId = pendingOwnerId(room.pending);

      if (k === "general_store") {
        privatePending = enrichPendingForClient(room.pending);
      } else if (PRIVATE_PENDING_KINDS.has(k)) {
        privatePending = ownerId === me.id ? enrichPendingForClient(room.pending) : null;
      } else if (isPersonalPendingKind(k)) {
        privatePending = ownerId === me.id ? enrichPendingForClient(room.pending) : null;
      } else {
        privatePending = enrichPendingForClient(room.pending);
      }
    }

    safeSend((me as any).ws, {
      type: "me_state",
      roomCode: room.code,
      serverNow: Date.now(),
      turnPlayerId,
      phase: room.phase ?? "main",
      pending: privatePending,
      turnEndsAt: room.turnEndsAt ?? 0,
      pendingEndsAt: room.pendingEndsAt ?? 0,
      ended: !!room.ended,
      discardTop: room.discard?.length ? ensureCardMeta(room.discard[room.discard.length - 1]) : null,
      discardCount: room.discard?.length ?? 0,
      deckCount: room.deck?.length ?? 0,
      me: {
        id: me.id,
        name: me.name,
        role: me.role,
        playcharacter: me.playcharacter,
        hp: me.hp,
        maxHp: me.maxHp,
        isAlive: me.isAlive,
        disconnected: !!(me as any).disconnected,
        connectionLost: !(me as any)?.ws && !(me as any)?.disconnected && Number((me as any)?.reconnectDeadlineAt ?? 0) > Date.now(),
        equipment: (me.equipment ?? []).map(ensureCardMeta),
        hand: (me.hand ?? []).map(ensureCardMeta),
      },
    });
  }
}
