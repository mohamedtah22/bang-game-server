// routes/messageRouter.ts

import WebSocket from "ws";

import {
  handleCreate,
  handleJoin,
  handleLeave,
  handleReconnect,
  handleStart,
  handleChatMessage,
} from "../controllers/startandjoincontroller";

import {
  handlePlayCard,
  handleRespond,
  handleEndTurn,
  handleChooseDraw,
  handleChooseJesseTarget,
  handleChoosePedroSource,
  handleChooseGeneralStore,
  handleChooseLuckyDraw,
  handleChooseBarrel,
  handleSidHeal,
  handleDiscardToLimit,
} from "../controllers/gameengine";

import { wsToRoom } from "../controllers/state";

/** ---------- utils ---------- */

function safeSend(ws: any, obj: any) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  } catch {}
}

function normalizeCode(code: any) {
  return String(code || "").replace(/[\u200E\u200F\u202A-\u202E]/g, "").toUpperCase().trim();
}

/**
 * هل لازم roomCode؟
 * - create/join: لا (لأنه لسا مش داخل روم)
 * - leave: لا (السيرفر بعرف الروم من wsToRoom)
 * - باقي الرسائل: نعم
 */
function mustHaveRoomCode(type: string) {
  return !["create", "join", "leave", "reconnect"].includes(type);
}

/**
 * تأكد إن msg.roomCode يطابق الروم المرتبط بالـ ws
 */
function assertRoomMatches(ws: any, msg: any) {
  const info = wsToRoom.get(ws);
  if (!info) throw new Error("You are not in a room");

  const msgCode = normalizeCode(msg.roomCode);
  if (!msgCode) throw new Error("Missing roomCode");

  if (msgCode !== info.roomCode) {
    throw new Error("roomCode does not match your current room");
  }
}

/** ---------- router ---------- */

export function routeMessage(ws: any, msg: any) {
  if (!msg || typeof msg !== "object") {
    safeSend(ws, { type: "error", message: "Invalid message" });
    return;
  }

  if (typeof msg.type !== "string") {
    safeSend(ws, { type: "error", message: "Missing type" });
    return;
  }

  try {
    if (mustHaveRoomCode(msg.type)) {
      assertRoomMatches(ws, msg);
    }

    switch (msg.type) {
      /** ================== lobby ================== */

      case "create":
        return handleCreate(ws, msg);

      case "join":
        return handleJoin(ws, msg);

      case "reconnect":
        return handleReconnect(ws, msg);

      case "leave":
        return handleLeave(ws);

      case "start":
        return handleStart(ws);

      case "chat_message":
        return handleChatMessage(ws, msg);

      /** ================== game engine ================== */

      case "play_card":
        return handlePlayCard(ws, msg);

      case "respond":
        return handleRespond(ws, msg);

      case "end_turn":
        return handleEndTurn(ws, msg);

      /** ================== (choices/abilities) ================== */

      case "choose_draw":
        return handleChooseDraw(ws, msg);

      case "choose_jesse_target":
        return handleChooseJesseTarget(ws, msg);

      case "choose_pedro_source":
        return handleChoosePedroSource(ws, msg);

      case "choose_general_store":
        return handleChooseGeneralStore(ws, msg);

      case "choose_lucky_draw":
        return handleChooseLuckyDraw(ws, msg);

      case "choose_barrel":
        return handleChooseBarrel(ws, msg);

      case "sid_heal":
        return handleSidHeal(ws, msg);

      case "discard_to_limit":
        return handleDiscardToLimit(ws, msg);

      default:
        safeSend(ws, { type: "error", message: "Unknown type" });
        return;
    }
  } catch (e: any) {
    safeSend(ws, { type: "error", message: e?.message || "Server error" });
  }
}
