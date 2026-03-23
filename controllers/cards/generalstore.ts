import type { PlayCardFn } from "./types";
import { broadcastCardPlayed, broadcastRoom } from "../engine/broadcast";
import { discard, maybeSuzyDraw, drawCard } from "../engine/runtime";
import { buildAliveOrderFrom, continueGeneralStore } from "../engine/turn";

export const playGeneralStore: PlayCardFn = (room, me, payload, card) => {
  broadcastCardPlayed(room, {
    action: "play",
    playerId: me.id,
    cardKey: "general_store",
    cardId: (card as any).id,
  });

  discard(room, card);

  const order = buildAliveOrderFrom(room, me.id);
  const offered: any[] = [];
  for (let i = 0; i < order.length; i++) offered.push(drawCard(room));

  room.pending = { kind: "general_store", initiatorId: me.id, order, idx: 0, offered };

  // ✅ public: everyone sees the offered cards
  broadcastRoom(room, {
    type: "general_store_open",
    roomCode: room.code,
    ts: Date.now(),
    initiatorId: me.id,
    order,
    idx: 0,
    pickerId: order[0] ?? null,
    offered,
  });

  maybeSuzyDraw(room, me);
  continueGeneralStore(room);
};