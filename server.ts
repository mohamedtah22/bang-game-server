import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { routeMessage } from "./routes/joinandcreateroutes";
import { handleSocketClosed } from "./controllers/startandjoincontroller";

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function safeSend(ws: WebSocket, payload: any) {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // ignore send errors
  }
}

const server = http.createServer((_req, res) => {
  res.writeHead(200);
  res.end("WS server running");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws: any) => {
  ws._id = makeId();
  console.log("WS CONNECTED", { id: ws._id });

  ws.on("message", (raw: WebSocket.RawData) => {
    let msg: any;

    try {
      msg = JSON.parse(raw.toString());
    } catch {
      safeSend(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    if (msg?.type === "ping") {
      safeSend(ws, { type: "pong", ts: msg.ts ?? Date.now(), serverNow: Date.now() });
      return;
    }

    try {
      routeMessage(ws, msg);
    } catch (err: any) {
      const message = String(err?.message ?? err ?? "Server error");
      safeSend(ws, { type: "error", message });
    } finally {
      console.log(`Received message from ${ws._id}:`, msg);
    }
  });

  ws.on("close", (code: number, reason: Buffer) => {
    console.log("WS CLOSED ON SERVER", {
      id: ws._id,
      code,
      reason: reason?.toString?.() || "",
    });

    try {
      handleSocketClosed(ws);
    } catch (err) {
      console.log("handleSocketClosed error", err);
    }
  });

  ws.on("error", (err: any) => {
    console.log("WS ERROR ON SERVER", {
      id: ws._id,
      error: String(err?.message ?? err),
    });
  });
});

const PORT = Number(process.env.PORT || 3000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`WS on 0.0.0.0:${PORT}`);
});