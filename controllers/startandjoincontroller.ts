// controllers/room.ts
import { Player, Role, CharacterId, Card } from "../models/player";
import { rooms, wsToRoom } from "./state";
import { startTurn } from "./gameengine";
import { handlePlayerDisconnectDuringGame } from "./engine/turn";
import { checkGameOver } from "./engine/gameover";
import type { GameRoom } from "./engine/types";
import {
  broadcastGameState as emitGameState,
  broadcastMeStates as emitMeStates,
  broadcastRoom,
  safeSend,
} from "./engine/broadcast";

export const RECONNECT_GRACE_MS = 30_000;

function makeCode(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ2345678901";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function normalizeCode(code: string) {
  return String(code || "").replace(/[\u200E\u200F\u202A-\u202E]/g, "").toUpperCase().trim();
}

function ensureWsId(ws: any) {
  if (!ws._id) ws._id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return ws._id as string;
}

function normalizeClientSessionId(raw: any) {
  return String(raw ?? "").trim();
}

function markSocketSuperseded(ws: any) {
  if (!ws) return;
  ws._superseded = true;
  wsToRoom.delete(ws);
  try {
    ws.close(4000, "superseded");
  } catch {}
}

function findPlayerBySession(clientSessionId: string) {
  if (!clientSessionId) return null;
  for (const room of rooms.values() as any as GameRoom[]) {
    const player = ((room.players as any[]) ?? []).find(
      (p: Player) => String((p as any)?.clientSessionId ?? "") === clientSessionId
    ) as Player | undefined;
    if (player) return { room, player };
  }
  return null;
}

function bindSocketToPlayer(room: GameRoom, player: Player, ws: any) {
  const oldWs = (player as any).ws;
  if (oldWs && oldWs !== ws) {
    markSocketSuperseded(oldWs);
  }

  (player as any).ws = ws;
  wsToRoom.set(ws, { roomCode: room.code, playerId: player.id });
}

function uniqueName(room: GameRoom, base: string) {
  const raw = (base || "Player").trim() || "Player";
  const taken = new Set((room.players as any[]).map((p) => p.name));
  if (!taken.has(raw)) return raw;

  let i = 2;
  while (taken.has(`${raw}${i}`)) i++;
  return `${raw}${i}`;
}

function getRoomPlayer(room: GameRoom | undefined, playerId: string) {
  if (!room || !playerId) return null;
  return ((room.players as any[]) ?? []).find((p: Player) => p.id === playerId) as Player | null;
}

function clearReconnectTimer(player: any) {
  const t = player?.reconnectTimer;
  if (t) {
    try {
      clearTimeout(t);
    } catch {}
  }
  if (player) {
    player.reconnectTimer = undefined;
    player.reconnectDeadlineAt = undefined;
  }
}

function removeLobbyPlayer(room: GameRoom, playerId: string) {
  const idx = (room.players as any[]).findIndex((p: Player) => p.id === playerId);
  if (idx < 0) return;

  const leaving = (room.players as any[])[idx] as Player;

  broadcastRoom(room, {
    type: "player_left_lobby",
    roomCode: room.code,
    playerId: leaving.id,
    name: leaving.name,
  });

  (room.players as any[]).splice(idx, 1);

  if ((room.players as any[]).length < 4) room.ready = false;

  if ((room.players as any[]).length === 0) {
    rooms.delete(room.code);
    return;
  }

  if (room.hostId && room.hostId === leaving.id) {
    room.hostId = (room.players as any[])[0]?.id;
    const nextHost = (room.players as any[]).find((p: any) => p.id === room.hostId) as Player | undefined;
    broadcastRoom(room, {
      type: "host_changed",
      roomCode: room.code,
      hostId: room.hostId,
      hostName: nextHost?.name ?? "",
    });
  }

  emitRoomUpdate(room);
}

function finalizeInGameDisconnect(room: GameRoom, player: any) {
  if (!room || !player) return;

  clearReconnectTimer(player);
  player.ws = undefined;
  player.disconnected = true;

  broadcastRoom(room, {
    type: "player_disconnected",
    roomCode: room.code,
    playerId: player.id,
    name: player.name,
  });

  try {
    checkGameOver(room as any);
    if (room.ended) return;

    const handled = handlePlayerDisconnectDuringGame(room as any, player.id);
    if (!handled && !room.ended) {
      emitGameState(room as any);
      emitMeStates(room as any);
    }
  } catch {}
}

function scheduleInGameDisconnect(room: GameRoom, player: any, graceMs = RECONNECT_GRACE_MS) {
  if (!room || !player) return;

  clearReconnectTimer(player);
  player.ws = undefined;
  player.disconnected = false;
  player.reconnectDeadlineAt = Date.now() + graceMs;

  broadcastRoom(room, {
    type: "player_connection_lost",
    roomCode: room.code,
    playerId: player.id,
    name: player.name,
    reconnectDeadlineAt: player.reconnectDeadlineAt,
    graceMs,
  });

  player.reconnectTimer = setTimeout(() => {
    const latestRoom = rooms.get(room.code) as GameRoom | undefined;
    const latestPlayer = getRoomPlayer(latestRoom, player.id) as any;
    if (!latestRoom || !latestPlayer) return;
    if (latestPlayer.ws || latestPlayer.disconnected) return;
    finalizeInGameDisconnect(latestRoom, latestPlayer);
  }, graceMs);
}

function leaveIfInRoom(ws: any) {
  const info = wsToRoom.get(ws);
  if (!info) return;

  const room = rooms.get(info.roomCode) as GameRoom | undefined;
  wsToRoom.delete(ws);
  if (!room) return;

  const player = getRoomPlayer(room, info.playerId) as any;
  if (!player) return;

  if (room.started) {
    finalizeInGameDisconnect(room, player);
    return;
  }

  removeLobbyPlayer(room, info.playerId);
}

export function handleSocketClosed(ws: any) {
  const info = wsToRoom.get(ws);
  if (!info) return;

  wsToRoom.delete(ws);

  const room = rooms.get(info.roomCode) as GameRoom | undefined;
  if (!room) return;

  const player = getRoomPlayer(room, info.playerId) as any;
  if (!player) return;

  // Ignore stale/old sockets after reconnect. Only the active socket may trigger disconnect flow.
  if (player.ws !== ws) return;

  player.ws = undefined;

  if (room.started && !room.ended) {
    scheduleInGameDisconnect(room, player, RECONNECT_GRACE_MS);
    return;
  }

  if (room.started) {
    clearReconnectTimer(player);
    return;
  }

  removeLobbyPlayer(room, info.playerId);
}

function emitRoomUpdate(room: GameRoom) {
  broadcastRoom(room, {
    type: "room_update",
    roomCode: room.code,
    playersCount: room.players.length,
    players: (room.players as any[]).map((p) => ({ id: p.id, name: p.name })),
    ready: room.ready,
    maxPlayers: room.maxPlayers,
    started: !!room.started,
    hostId: room.hostId,
  });

  if (room.ready && !room.started) {
    broadcastRoom(room, { type: "room_ready", roomCode: room.code });
  }
}

function shuffle<T>(arr: T[]) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function rolesFor(n: number): Role[] {
  if (n === 4) return ["sheriff", "outlaw", "outlaw", "renegade"];
  if (n === 5) return ["sheriff", "outlaw", "outlaw", "renegade", "deputy"];
  if (n === 6) return ["sheriff", "outlaw", "outlaw", "outlaw", "renegade", "deputy"];
  if (n === 7) return ["sheriff", "outlaw", "outlaw", "outlaw", "renegade", "deputy", "deputy"];
  throw new Error("Supported players: 4-7");
}

const CHARACTER_IDS: CharacterId[] = [
  "bart_cassidy",
  "black_jack",
  "calamity_janet",
  "el_gringo",
  "jesse_jones",
  "jourdonnais",
  "kit_carlson",
  "lucky_duke",
  "paul_regret",
  "pedro_ramirez",
  "rose_doolan",
  "sid_ketchum",
  "slab_the_killer",
  "suzy_lafayette",
  "vulture_sam",
  "willy_the_kid",
];

const CHARACTER_HP: Record<CharacterId, number> = {
  bart_cassidy: 4,
  black_jack: 4,
  calamity_janet: 4,
  el_gringo: 3,
  jesse_jones: 4,
  jourdonnais: 4,
  kit_carlson: 4,
  lucky_duke: 4,
  paul_regret: 3,
  pedro_ramirez: 4,
  rose_doolan: 4,
  sid_ketchum: 4,
  slab_the_killer: 4,
  suzy_lafayette: 4,
  vulture_sam: 4,
  willy_the_kid: 4,
};

const SUITS = ["spades", "hearts", "diamonds", "clubs"] as const;
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;

function buildDefaultDeck(): Card[] {
  let id = 0;
  let meta = 0;

  const mk = (key: string, extra: any = {}): Card => {
    const suit = SUITS[meta % SUITS.length];
    const rank = RANKS[Math.floor(meta / SUITS.length) % RANKS.length];
    meta++;

    return {
      id: `card_${Date.now()}_${id++}_${Math.random().toString(16).slice(2)}`,
      key,
      suit,
      rank,
      ...extra,
    } as any;
  };

  const deck: Card[] = [];
  const pushMany = (key: string, count: number, extra?: any) => {
    for (let i = 0; i < count; i++) deck.push(mk(key, extra));
  };

  pushMany("bang", 25);
  pushMany("missed", 12);
  pushMany("beer", 6);
  pushMany("stagecoach", 2);
  pushMany("wellsfargo", 1);
  pushMany("saloon", 1);
  pushMany("panic", 4);
  pushMany("catbalou", 4);
  pushMany("indians", 2);
  pushMany("gatling", 1);
  pushMany("duel", 3);
  pushMany("general_store", 2);

  pushMany("barrel", 2);
  pushMany("mustang", 2);
  pushMany("scope", 1);
  pushMany("jail", 3);
  pushMany("dynamite", 1);

  pushMany("weapon", 2, { weaponName: "volcanic", range: 1 });
  pushMany("weapon", 3, { weaponName: "schofield", range: 2 });
  pushMany("weapon", 2, { weaponName: "remington", range: 3 });
  pushMany("weapon", 2, { weaponName: "carabine", range: 4 });
  pushMany("weapon", 1, { weaponName: "winchester", range: 5 });

  return deck;
}

function initDeckAndDeal(room: GameRoom) {
  room.discard = [];
  room.deck = shuffle(buildDefaultDeck());

  for (const pAny of room.players as any[]) {
    const p = pAny as Player;
    p.hand = [];
    p.equipment = [];

    for (let i = 0; i < p.maxHp; i++) {
      const c = room.deck.pop();
      if (!c) throw new Error("Deck is empty during initial deal");
      p.hand.push(c as any);
    }
  }
}

export function handleCreate(ws: any, payload: { name?: string; clientSessionId?: string }) {
  const playerId = ensureWsId(ws);
  const clientSessionId = normalizeClientSessionId(payload.clientSessionId);

  const existingSession = findPlayerBySession(clientSessionId);
  if (existingSession) {
    if (!existingSession.room.started) {
      removeLobbyPlayer(existingSession.room, existingSession.player.id);
    } else {
      markSocketSuperseded((existingSession.player as any).ws);
    }
  }

  leaveIfInRoom(ws);

  const name = (payload.name || "Host").trim() || "Host";
  let code = makeCode();
  while (rooms.has(code)) code = makeCode();

  const room: GameRoom = {
    code,
    hostId: playerId,
    started: false,
    players: [
      {
        id: playerId,
        name,
        clientSessionId,
        ws,
        role: "outlaw",
        playcharacter: "bart_cassidy",
        hp: 0,
        maxHp: 0,
        hand: [],
        equipment: [],
        isAlive: true,
      } as Player,
    ],
    ready: false,
    maxPlayers: 7,
  };

  rooms.set(code, room);
  wsToRoom.set(ws, { roomCode: code, playerId });

  safeSend(ws, { type: "created", roomCode: code, playerId, hostId: room.hostId, players: room.players.map((p: any) => ({ id: p.id, name: p.name })), ready: room.ready, maxPlayers: room.maxPlayers });
  emitRoomUpdate(room);
}

export function handleJoin(ws: any, payload: { roomCode?: string; name?: string; clientSessionId?: string }) {
  const playerId = ensureWsId(ws);
  const clientSessionId = normalizeClientSessionId(payload.clientSessionId);
  const code = normalizeCode(payload.roomCode || "");
  const currentInfo = wsToRoom.get(ws);
  if (currentInfo && currentInfo.playerId === playerId && normalizeCode(currentInfo.roomCode) === code) {
    const currentRoom = rooms.get(currentInfo.roomCode) as GameRoom | undefined;
    if (currentRoom && !currentRoom.started) {
      return safeSend(ws, {
        type: "joined",
        roomCode: currentRoom.code,
        playerId,
        hostId: currentRoom.hostId,
        players: currentRoom.players.map((p: any) => ({ id: p.id, name: p.name })),
        ready: currentRoom.ready,
        maxPlayers: currentRoom.maxPlayers,
      });
    }
  }

  leaveIfInRoom(ws);

  const room = rooms.get(code) as GameRoom | undefined;
  if (!room) return safeSend(ws, { type: "error", message: "Room not found" });
  if (room.started) return safeSend(ws, { type: "error", message: "Game already started" });
  if (room.players.length >= room.maxPlayers) return safeSend(ws, { type: "error", message: "Room is full" });

  const wanted = (payload.name || "Player").trim() || "Player";
  const name = uniqueName(room, wanted);
  let existing = (room.players as any[]).find((p) => p.id === playerId) as Player | undefined;

  if (!existing && clientSessionId) {
    existing = (room.players as any[]).find((p) => String((p as any)?.clientSessionId ?? "") === clientSessionId) as Player | undefined;
  }

  const existingSession = !existing && clientSessionId ? findPlayerBySession(clientSessionId) : null;
  if (existingSession && existingSession.room.code !== room.code) {
    if (!existingSession.room.started) {
      removeLobbyPlayer(existingSession.room, existingSession.player.id);
    } else {
      markSocketSuperseded((existingSession.player as any).ws);
    }
  }

  if (!existing) {
    room.players.push({
      id: playerId,
      name,
      clientSessionId,
      ws,
      role: "outlaw",
      playcharacter: "bart_cassidy",
      hp: 0,
      maxHp: 0,
      hand: [],
      equipment: [],
      isAlive: true,
    } as Player);
  } else {
    existing.clientSessionId = existing.clientSessionId || clientSessionId;
    bindSocketToPlayer(room, existing, ws);
    existing.name = name;
  }

  if (!existing) {
    wsToRoom.set(ws, { roomCode: code, playerId });
  }
  room.ready = room.players.length >= 4;
  safeSend(ws, { type: "joined", roomCode: code, playerId: existing?.id ?? playerId, hostId: room.hostId, players: room.players.map((p: any) => ({ id: p.id, name: p.name })), ready: room.ready, maxPlayers: room.maxPlayers });
  emitRoomUpdate(room);
}

export function handleReconnect(ws: any, payload: { roomCode?: string; playerId?: string; name?: string; clientSessionId?: string }) {
  const code = normalizeCode(payload.roomCode || "");
  const clientSessionId = normalizeClientSessionId(payload.clientSessionId);
  let playerId = String(payload.playerId ?? "").trim();
  if (!code || (!playerId && !clientSessionId)) return safeSend(ws, { type: "error", message: "Missing reconnect data" });

  const room = rooms.get(code) as GameRoom | undefined;
  if (!room) return safeSend(ws, { type: "error", message: "Room not found" });

  let player = getRoomPlayer(room, playerId) as any;
  if (!player && clientSessionId) {
    player = ((room.players as any[]) ?? []).find((p: Player) => String((p as any)?.clientSessionId ?? "") === clientSessionId) as any;
    if (player) playerId = player.id;
  }
  if (!player) return safeSend(ws, { type: "error", message: "Player not found in room" });

  clearReconnectTimer(player);
  player.clientSessionId = player.clientSessionId || clientSessionId;
  bindSocketToPlayer(room, player, ws);
  player.disconnected = false;
  player.reconnectDeadlineAt = undefined;

  const wantedName = String(payload.name ?? "").trim();
  if (wantedName) player.name = player.name || wantedName;

  safeSend(ws, { type: "reconnected", roomCode: code, playerId, reconnectGraceMs: RECONNECT_GRACE_MS, hostId: room.hostId, players: room.players.map((p: any) => ({ id: p.id, name: p.name })), ready: room.ready, maxPlayers: room.maxPlayers });

  if (!room.started) {
    emitRoomUpdate(room);
    return;
  }

  broadcastRoom(room, {
    type: "player_reconnected",
    roomCode: room.code,
    playerId: player.id,
    name: player.name,
  });
  emitGameState(room as any);
  emitMeStates(room as any);
}

export function handleLeave(ws: any) {
  leaveIfInRoom(ws);
}

export function handleDisconnect(ws: any) {
  leaveIfInRoom(ws);
}

export function handleStart(ws: any) {
  const info = wsToRoom.get(ws);
  if (!info) return;

  const room = rooms.get(info.roomCode) as GameRoom | undefined;
  if (!room) return;

  const n = room.players.length;
  if (n < 4) return safeSend(ws, { type: "error", message: "Not enough players to start the game" });
  if (n > 7) return safeSend(ws, { type: "error", message: "Too many players (max 7)" });
  if (room.started) return;
  if (room.hostId && info.playerId !== room.hostId) return safeSend(ws, { type: "error", message: "Only host can start" });

  room.started = true;

  const roles = shuffle(rolesFor(n));
  const chars = shuffle([...CHARACTER_IDS]).slice(0, n);
  for (let i = 0; i < n; i++) {
    const p = (room.players as any[])[i] as Player;
    p.role = roles[i];
    p.playcharacter = chars[i];
    const baseHp = CHARACTER_HP[p.playcharacter];
    p.maxHp = baseHp + (p.role === "sheriff" ? 1 : 0);
    p.hp = p.maxHp;
    p.isAlive = true;
    p.disconnected = false;
    clearReconnectTimer(p as any);
    p.equipment = [];
    p.hand = [];
  }

  room.turnIndex = (room.players as any[]).findIndex((p: Player) => p.role === "sheriff");
  if (room.turnIndex < 0) room.turnIndex = 0;

  room.phase = "main";
  room.pending = null;
  room.bangsUsedThisTurn = 0;

  try {
    initDeckAndDeal(room);
  } catch (e: any) {
    room.started = false;
    return safeSend(ws, { type: "error", message: e?.message || "Failed to init deck" });
  }

  broadcastRoom(room, { type: "started", roomCode: room.code });
  setTimeout(() => {
    try {
      startTurn(room as any);
    } catch (e: any) {
      broadcastRoom(room, { type: "error", message: e?.message || "Failed to start turn" });
    }
  }, 50);
}


export function handleChatMessage(ws: any, payload: { text?: string }) {
  const info = wsToRoom.get(ws);
  if (!info) return safeSend(ws, { type: "error", message: "You are not in a room" });

  const room = rooms.get(info.roomCode) as GameRoom | undefined;
  if (!room) return safeSend(ws, { type: "error", message: "Room not found" });

  const player = getRoomPlayer(room, info.playerId) as Player | null;
  if (!player) return safeSend(ws, { type: "error", message: "Player not found" });

  const textRaw = String(payload?.text ?? "").replace(/\s+/g, " ").trim();
  if (!textRaw) return safeSend(ws, { type: "error", message: "Empty message" });

  const textClean = textRaw.slice(0, 180);

  broadcastRoom(room as any, {
    type: "chat_message",
    roomCode: room.code,
    id: `chat_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    ts: Date.now(),
    playerId: player.id,
    name: player.name,
    text: textClean,
  });
}
