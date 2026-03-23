import type { Player, Card } from "../../models/player";
import type { GameRoom } from "./types";
import { SUITS, RANKS } from "./types";
import { shuffle } from "./utils";
import { broadcastCardDiscarded, broadcastRoom } from "./broadcast";

export function ensurePlayerRuntime(p: any) {
  p.hand ??= [];
  p.equipment ??= [];
  p.isAlive = p.isAlive ?? true;

  // hp/maxHp defaults
  if (typeof p.maxHp !== "number") p.maxHp = 4;
  if (typeof p.hp !== "number") p.hp = p.maxHp;
  if (p.hp > p.maxHp) p.hp = p.maxHp;

  p.role = p.role ?? "outlaw";
  p.playcharacter = p.playcharacter ?? "";
}

export function ensureRuntime(room: GameRoom) {
  room.players ??= [];
  for (const p of room.players as any[]) ensurePlayerRuntime(p);

  room.deck ??= [];
  room.discard ??= [];
  room.turnIndex ??= 0;

  // clamp turnIndex (prevents crashes after end_turn / disconnects)
  const n = (room.players as any[]).length;
  let i = Number((room as any).turnIndex ?? 0);
  if (!Number.isFinite(i)) i = 0;
  if (n > 0) (room as any).turnIndex = ((i % n) + n) % n;

  room.phase ??= "main";
  room.pending ??= null;

  // unstick: waiting without pending should never persist
  if (room.phase === "waiting" && !room.pending) room.phase = "main";

  room.bangsUsedThisTurn ??= 0;
  room.ended ??= false;
}

/** Make sure suit/rank exist for Draw! mechanics */
export function ensureCardMeta(c: Card): Card {
  const suit = (c as any).suit ?? SUITS[Math.floor(Math.random() * SUITS.length)];
  const rank = (c as any).rank ?? RANKS[Math.floor(Math.random() * RANKS.length)];
  return { ...c, suit, rank } as any;
}

export function drawCard(room: GameRoom): Card {
  room.deck ??= [];
  room.discard ??= [];

  if (room.deck.length === 0) {
    if (room.discard.length === 0) throw new Error("No cards left (deck+discard empty)");
    room.deck = shuffle(room.discard.map(ensureCardMeta));
    room.discard = [];
  }

  const c = room.deck.pop();
  if (!c) throw new Error("No cards left");
  return ensureCardMeta(c);
}

export function discard(room: GameRoom, c: Card) {
  room.discard ??= [];
  room.discard.push(ensureCardMeta(c));
  broadcastCardDiscarded(room, c);
}

export function takeFromDiscard(room: GameRoom): Card {
  room.discard ??= [];
  const c = room.discard.pop();
  if (!c) throw new Error("Discard empty");
  return ensureCardMeta(c);
}

export function popCardFromHand(p: Player, cardId: string): Card {
  (p as any).hand ??= [];
  const idx = p.hand.findIndex((c) => String((c as any).id) === String(cardId));
  if (idx < 0) throw new Error("Card not in hand");
  const [c] = p.hand.splice(idx, 1);
  return ensureCardMeta(c);
}

export function equipmentHas(p: Player, key: string) {
  (p as any).equipment ??= [];
  return Array.isArray(p.equipment) && p.equipment.some((c) => String((c as any)?.key ?? "").toLowerCase().replace(/[^a-z0-9]/g,"") === key.toLowerCase().replace(/[^a-z0-9]/g,""));
}

export function takeEquipment(p: Player, key: string): Card | null {
  (p as any).equipment ??= [];
  const nk = key.toLowerCase().replace(/[^a-z0-9]/g,"");
  const idx = p.equipment.findIndex((c) => String((c as any)?.key ?? "").toLowerCase().replace(/[^a-z0-9]/g,"") === nk);
  if (idx < 0) return null;
  const [c] = p.equipment.splice(idx, 1);
  return c ? ensureCardMeta(c) : null;
}

export function replaceUniqueEquipment(room: GameRoom, p: Player, key: string, newCard: Card) {
  const old = takeEquipment(p, key);
  if (old) discard(room, old);
  (p as any).equipment ??= [];
  p.equipment.push(newCard);
}

/** ===== alive helpers ===== */
export function alivePlayers(room: GameRoom): Player[] {
  return (room.players as any[]).filter((p: Player) => p?.isAlive);
}

export function activeAlivePlayers(room: GameRoom): Player[] {
  return (room.players as any[]).filter((p: Player) => p?.isAlive && !(p as any)?.disconnected);
}

export function aliveCount(room: GameRoom): number {
  return activeAlivePlayers(room).length;
}

/** Suzy: when hand becomes empty, draw 1 */
export function maybeSuzyDraw(room: GameRoom, p: Player) {
  if (!p.isAlive) return;
  // CHAR constant is in types, but to avoid import cycle here we check string directly
  if (String((p as any).playcharacter ?? "").toLowerCase() !== "suzy_lafayette") return;
  if (p.hand.length !== 0) return;
  try {
    const drawn = drawCard(room);
    p.hand.push(drawn);
    broadcastRoom(room, {
      type: "passive_triggered",
      roomCode: room.code,
      kind: "suzy_draw",
      playerId: p.id,
      count: 1,
    });
  } catch {}
}

