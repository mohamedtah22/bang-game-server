// controllers/state.ts
import { Room } from "../models/room";

export const rooms = new Map<string, Room>();
export const wsToRoom = new Map<any, { roomCode: string; playerId: string }>();
