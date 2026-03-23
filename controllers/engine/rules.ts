import type { Player, Card } from "../../models/player";
import { CHAR } from "./types";
import { isChar, cardKey } from "./utils";

/** Calamity Janet: MISSED can be used as BANG, and BANG as MISSED */
export function isBangPlay(p: Player, card: Card): boolean {
  const k = cardKey(card);
  return k === "bang" || (isChar(p, CHAR.calamity) && k === "missed");
}
export function canRespondToBangLike(p: Player, card: Card): boolean {
  const k = cardKey(card);
  if (k === "missed") return true;
  if (isChar(p, CHAR.calamity) && k === "bang") return true;
  return false;
}
export function canRespondToIndiansOrDuel(p: Player, card: Card): boolean {
  return isBangPlay(p, card);
}

