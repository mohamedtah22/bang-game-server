import type { Player, Card } from "../../models/player";
import type { GameRoom, LuckyDrawKind, LuckyResume } from "./types";
import { RESPONSE_MS, CHAR } from "./types";
import { isChar } from "./utils";
import { drawCard, discard, ensureCardMeta } from "./runtime";
import { safeSend, broadcastRoom, broadcastGameState, broadcastMeStates } from "./broadcast";
import { equipmentHas } from "./runtime";

function pendingDeadlineFromTurn(room: GameRoom) {
  const turnEnd = Number((room as any)?.turnEndsAt ?? 0);
  if (turnEnd > Date.now()) return turnEnd;
  return Date.now() + RESPONSE_MS;
}

/** ===== Draw! checks ===== */
export function rankNum(r: any): number | null {
  const s = String(r ?? "").toUpperCase();
  if (s === "A") return 1;
  if (s === "J") return 11;
  if (s === "Q") return 12;
  if (s === "K") return 13;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
export function isDynamiteExplosionCard(c: Card): boolean {
  const suit = String((c as any).suit ?? "").toLowerCase();
  const num = rankNum((c as any).rank);
  return suit === "spades" && num != null && num >= 2 && num <= 9;
}
export function isHearts(c: Card): boolean {
  return String((c as any).suit ?? "").toLowerCase() === "hearts";
}
export function isHeartsOrDiamonds(c: Card): boolean {
  const s = String((c as any).suit ?? "").toLowerCase();
  return s === "hearts" || s === "diamonds";
}

/** draw one card for non-lucky and discard it */
export function drawOneForCheck(room: GameRoom): Card {
  const c = drawCard(room);
  discard(room, c);
  return c;
}

/** Lucky Duke: draw 2 (both go to discard), then player chooses which one counts (pending lucky_choice) */
export function startLuckyChoice(room: GameRoom, player: Player, drawKind: LuckyDrawKind, resume: LuckyResume): "waiting" {
  const c1 = drawCard(room);
  const c2 = drawCard(room);
  discard(room, c1);
  discard(room, c2);
  const options = [ensureCardMeta(c1), ensureCardMeta(c2)];

  room.phase = "waiting";
  room.pending = { kind: "lucky_choice", playerId: player.id, drawKind, options, resume };
  room.pendingEndsAt = pendingDeadlineFromTurn(room);

  safeSend((player as any).ws, {
    type: "action_required",
    roomCode: room.code,
    kind: "choose_lucky_draw",
    playerId: player.id,
    toPlayerId: player.id,
    drawKind,
    options,
    pendingEndsAt: room.pendingEndsAt,
  });

  broadcastGameState(room);
  broadcastMeStates(room);
  return "waiting";
}

/** helper: evaluate success for a chosen card */
export function evalDrawSuccess(drawKind: LuckyDrawKind, chosen: Card): boolean {
  if (drawKind === "dynamite") return !isDynamiteExplosionCard(chosen); // success = safe
  if (drawKind === "jail") return isHearts(chosen); // success = freed
  if (drawKind === "barrel") return isHearts(chosen); // success = dodges one missed
  return false;
}

/** ===== Barrel / Jourdonnais Draw! ===== */
export function barrelLikeCount(defender: Player): number {
  let n = 0;
  if (isChar(defender, CHAR.jourd)) n += 1;
  if (equipmentHas(defender, "barrel")) n += 1;
  return n;
}

export function hasBarrelLike(defender: Player): boolean {
  return barrelLikeCount(defender) > 0;
}

/**
 * If defender is Lucky -> opens lucky_choice and returns "waiting"
 * Else returns { drew, chosen, success }
 */
export function startBarrelDraw(
  room: GameRoom,
  defender: Player,
  resume: LuckyResume
):
  | { kind: "done"; drawn: Card[]; chosen: Card; success: boolean }
  | { kind: "waiting" } {
  if (!hasBarrelLike(defender)) return { kind: "done", drawn: [], chosen: {} as any, success: false };

  const lucky = isChar(defender, CHAR.lucky);

  if (lucky) {
    startLuckyChoice(room, defender, "barrel", resume);
    return { kind: "waiting" };
  }

  const c = drawOneForCheck(room);
  const success = isHearts(c);

  broadcastRoom(room, {
    type: "draw_check",
    roomCode: room.code,
    kind: "barrel",
    playerId: defender.id,
    drawn: [c],
    chosen: c,
    success,
  });

  return { kind: "done", drawn: [c], chosen: c, success };
}

