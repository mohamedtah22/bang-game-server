import type { Player } from "../../models/player";
import type { GameRoom } from "./types";
import { CHAR } from "./types";
import { isChar } from "./utils";
import { equipmentHas } from "./runtime";

export function getPlayer(room: GameRoom, id: string): Player | undefined {
  return (room.players as any[]).find((p: Player) => p.id === id);
}

export function currentPlayer(room: GameRoom): Player {
  const players = (room.players as any[]) ?? [];
  const n = players.length;
  if (n <= 0) {
    return { id: "", name: "", isAlive: false, hp: 0, maxHp: 0, hand: [], equipment: [] } as any;
  }

  let i = Number((room as any).turnIndex ?? 0);
  if (!Number.isFinite(i)) i = 0;
  i = ((i % n) + n) % n;
  (room as any).turnIndex = i;

  return players[i] as Player;
}

export function isTurnEligible(p?: Player | null) {
  return !!p && p.isAlive && !(p as any).disconnected;
}

export function assertMyTurn(room: GameRoom, playerId: string) {
  const cur = currentPlayer(room);
  if (!cur || cur.id !== playerId) throw new Error("Not your turn");
  if (!cur.isAlive) throw new Error("You are dead");
  if ((cur as any).disconnected) throw new Error("You are disconnected");
}

/** ===== distance & range ===== */
export function nextAliveIndex(room: GameRoom, from: number) {
  const n = room.players.length;
  for (let step = 1; step <= n; step++) {
    const i = (from + step) % n;
    const p = (room.players as any[])[i] as Player;
    if (isTurnEligible(p)) return i;
  }
  return -1;
}

export function seatDistanceAlive(room: GameRoom, fromId: string, toId: string): number {
  if (fromId === toId) return 0;

  const arr = room.players as any[];
  const fromIdx = arr.findIndex((p: Player) => p.id === fromId);
  const toIdx = arr.findIndex((p: Player) => p.id === toId);
  if (fromIdx < 0 || toIdx < 0) return 999;

  // clockwise
  let stepsCW = 0;
  let cur = fromIdx;
  while (stepsCW < arr.length) {
    const nxt = nextAliveIndex(room, cur);
    if (nxt < 0) break;
    cur = nxt;
    stepsCW++;
    if ((arr[cur] as Player).id === toId) break;
  }

  // counter-clockwise
  let stepsCCW = 0;
  cur = fromIdx;
  while (stepsCCW < arr.length) {
    let found = -1;
    for (let k = 1; k <= arr.length; k++) {
      const j = (cur - k + arr.length) % arr.length;
      const p = arr[j] as Player;
      if (p?.isAlive) {
        found = j;
        break;
      }
    }
    if (found < 0) break;
    cur = found;
    stepsCCW++;
    if ((arr[cur] as Player).id === toId) break;
  }

  return Math.min(stepsCW || 999, stepsCCW || 999);
}

export function weaponRange(p: Player): number {
  (p as any).equipment ??= [];
  const w = p.equipment.find((c) => String((c as any)?.key ?? "").toLowerCase().replace(/[^a-z0-9]/g,"") === "weapon") as any;
  if (!w) return 1;

  if (typeof w.range === "number") return Math.max(1, Math.min(5, w.range));

  const wKey = String(w.weaponKey ?? w.weaponName ?? w.name ?? "").toLowerCase();

  if (wKey.includes("volcanic")) return 1;
  if (wKey.includes("schofield")) return 2;
  if (wKey.includes("remington")) return 3;
  if (wKey.includes("carabine")) return 4;
  if (wKey.includes("winchester")) return 5;

  return 1;
}

export function hasVolcanic(p: Player): boolean {
  (p as any).equipment ??= [];
  const w = p.equipment.find((c) => String((c as any)?.key ?? "").toLowerCase().replace(/[^a-z0-9]/g,"") === "weapon") as any;
  const wKey = String(w?.weaponKey ?? w?.weaponName ?? w?.name ?? "").toLowerCase();
  return wKey.includes("volcanic");
}

export function effectiveDistance(room: GameRoom, from: Player, to: Player): number {
  let d = seatDistanceAlive(room, from.id, to.id);

  if (equipmentHas(to, "mustang")) d += 1;
  if (isChar(to, CHAR.paul)) d += 1;

  if (equipmentHas(from, "scope")) d -= 1;
  if (isChar(from, CHAR.rose)) d -= 1;

  if (d < 1) d = 1;
  return d;
}

export function canShootBang(room: GameRoom, attacker: Player, target: Player): boolean {
  const d = effectiveDistance(room, attacker, target);
  const r = weaponRange(attacker);
  return d <= r;
}

export function maxBangsPerTurn(p: Player): number {
  if (isChar(p, CHAR.willy)) return 999; // Willy
  if (hasVolcanic(p)) return 999; // Volcanic
  return 1;
}

export function requiredMissedForBang(attacker: Player): number {
  return isChar(attacker, CHAR.slab) ? 2 : 1; // Slab requires 2 MISSED
}

