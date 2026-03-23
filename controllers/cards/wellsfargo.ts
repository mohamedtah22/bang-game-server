import type { PlayCardFn } from "./types";
import { broadcastCardPlayed, broadcastGameState, broadcastMeStates } from "../engine/broadcast";
import { discard, drawCard, maybeSuzyDraw } from "../engine/runtime";

export const playWellsFargo: PlayCardFn = (room, me, payload, card) => {
  broadcastCardPlayed(room, { action: "play", playerId: me.id, cardKey: "wellsfargo", cardId: (card as any).id });

  discard(room, card);

  me.hand.push(drawCard(room));
  me.hand.push(drawCard(room));
  me.hand.push(drawCard(room));

  maybeSuzyDraw(room, me);
  broadcastGameState(room);
  broadcastMeStates(room);
};

