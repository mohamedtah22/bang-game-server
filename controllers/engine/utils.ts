import type { Card, Player } from "../../models/player";

export function normKey(k: any): string {
  return String(k ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
export function cardKey(c: Card): string {
  return normKey((c as any)?.key);
}

export function charId(p: Player): string {
  return String((p as any).playcharacter ?? "").toLowerCase();
}
export function isChar(p: Player, id: string) {
  return charId(p) === id;
}

/** Treat placeholder ids from UI as "not provided" */
export function normalizeMaybeId(v: any): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const t = s.toLowerCase();
  if (t === "empty" || t === "null" || t === "undefined" || t === "none") return null;
  return s;
}

/** Treat placeholder / invalid indexes as "not provided" */
export function normalizeMaybeIndex(v: any): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const t = s.toLowerCase();
  if (t === "empty" || t === "null" || t === "undefined" || t === "none") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i < 0) return null;
  return i;
}

export function shuffle<T>(arr: T[]) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

