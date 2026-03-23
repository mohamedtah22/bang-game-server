import type { PlayCardFn } from "./types";
import { broadcastCardPlayed, broadcastGameState, broadcastMeStates, broadcastRoom } from "../engine/broadcast";
import { discard, maybeSuzyDraw, aliveCount } from "../engine/runtime";

export const playBeer: PlayCardFn = (room, me, payload, card) => {
  if (me.hp >= me.maxHp) throw new Error("Already at full HP");

  if (aliveCount(room) <= 2) {
    broadcastCardPlayed(room, {
      action: "play",
      playerId: me.id,
      cardKey: "beer",
      cardId: (card as any).id,
      targetId: me.id,
    });
    discard(room, card);

    broadcastRoom(room, { type: "action_resolved", roomCode: room.code, kind: "beer_no_effect_two_left", playerId: me.id });
    maybeSuzyDraw(room, me);
    broadcastGameState(room);
    broadcastMeStates(room);
    return;
  }

  me.hp = Math.min(me.maxHp, me.hp + 1);
  broadcastCardPlayed(room, { action: "play", playerId: me.id, cardKey: "beer", cardId: (card as any).id, targetId: me.id });

  discard(room, card);

  maybeSuzyDraw(room, me);
  broadcastGameState(room);
  broadcastMeStates(room);
};

