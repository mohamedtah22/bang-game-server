import type { PlayCardFn } from "./types";
import { broadcastCardPlayed, broadcastGameState, broadcastMeStates, broadcastRoom } from "../engine/broadcast";
import { discard, maybeSuzyDraw } from "../engine/runtime";
import type { Player } from "../../models/player";

export const playSaloon: PlayCardFn = (room, me, payload, card) => {
  broadcastCardPlayed(room, { action: "play", playerId: me.id, cardKey: "saloon", cardId: (card as any).id });

  discard(room, card);
  maybeSuzyDraw(room, me);

  for (const p of room.players as any[]) {
    const pl = p as Player;
    if (!pl.isAlive) continue;
    pl.hp = Math.min(pl.maxHp, pl.hp + 1);
  }

  broadcastRoom(room, { type: "action_resolved", roomCode: room.code, kind: "saloon" });
  broadcastGameState(room);
  broadcastMeStates(room);
};

