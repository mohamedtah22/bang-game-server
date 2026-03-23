import type { Room } from "../../models/room";
import type { Player, Card } from "../../models/player";

export const TURN_MS = 120_000;
export const RESPONSE_MS = 40_000;

export type Phase = "main" | "waiting";

export const CHAR = {
  bart: "bart_cassidy",
  blackjack: "black_jack",
  calamity: "calamity_janet",
  elgringo: "el_gringo",
  jesse: "jesse_jones",
  jourd: "jourdonnais",
  kit: "kit_carlson",
  lucky: "lucky_duke",
  paul: "paul_regret",
  pedro: "pedro_ramirez",
  rose: "rose_doolan",
  sid: "sid_ketchum",
  slab: "slab_the_killer",
  suzy: "suzy_lafayette",
  vulture: "vulture_sam",
  willy: "willy_the_kid",
} as const;

type PendingVisibilityFields = {
  toPlayerId?: string;
  targetId?: string;
  ownerId?: string;
  forPlayerId?: string;
  pickerId?: string;
};

export type PendingBase =
  | ({
      kind: "bang";
      attackerId: string;
      targetId: string;
      requiredMissed: number;
      missedSoFar: number;
    } & PendingVisibilityFields)
  | ({
      kind: "indians";
      attackerId: string;
      targets: string[];
      idx: number;
      targetId?: string;
    } & PendingVisibilityFields)
  | ({
      kind: "gatling";
      attackerId: string;
      targets: string[];
      idx: number;
      targetId?: string;
    } & PendingVisibilityFields)
  | ({
      kind: "barrel_choice";
      source: "bang";
      attackerId: string;
      targetId: string;
      barrelChecksRemaining: number;
      requiredMissed?: number;
      missedSoFar?: number;
    } & PendingVisibilityFields)
  | ({
      kind: "duel";
      initiatorId: string;
      targetId: string;
      responderId: string;
    } & PendingVisibilityFields)
  | ({
      kind: "general_store";
      initiatorId: string;
      order: string[];
      idx: number;
      offered: Card[];
      pickerId?: string;
    } & PendingVisibilityFields)
  | ({
      kind: "draw_choice";
      playerId: string;
      offered: Card[];
      pickCount: number;
    } & PendingVisibilityFields)
  | ({
      kind: "jesse_choice";
      playerId: string;
      eligibleTargets: string[];
    } & PendingVisibilityFields)
  | ({
      kind: "pedro_choice";
      playerId: string;
      canUseDiscard: boolean;
    } & PendingVisibilityFields)
  | ({
      kind: "discard_limit";
      playerId: string;
      need: number;
      after: "end_turn_manual";
    } & PendingVisibilityFields);

export type TurnResume =
  | { kind: "turn_start"; stage: "jail" | "draw"; playerId: string }
  | null;

export type ResumeAfterRevive = PendingBase | TurnResume | null;

export type LuckyDrawKind = "barrel" | "jail" | "dynamite";

export type LuckyResume =
  | {
      kind: "turn_start_dynamite";
      playerId: string;
      dynCard: Card;
    }
  | {
      kind: "turn_start_jail";
      playerId: string;
      jailCard: Card;
    }
  | {
      kind: "barrel_vs_bang";
      attackerId: string;
      targetId: string;
      requiredMissed: number;
      missedSoFar: number;
      barrelChecksRemaining: number;
    }
  | {
      kind: "barrel_vs_gatling";
      attackerId: string;
      targetId: string;
      targets: string[];
      idx: number;
      barrelChecksRemaining: number;
    };

export type Pending =
  | PendingBase
  | ({
      kind: "revive";
      playerId: string;
      attackerId?: string;
      resume?: ResumeAfterRevive;
    } & PendingVisibilityFields)
  | ({
      kind: "lucky_choice";
      playerId: string;
      drawKind: LuckyDrawKind;
      options: Card[];
      resume: LuckyResume;
    } & PendingVisibilityFields)
  | null;

export type GamePlayer = Player & {
  disconnected?: boolean;
  reconnectDeadlineAt?: number;
  reconnectTimer?: any;
  ws?: any;
  role?: any;
  playcharacter?: any;
  maxHp?: number;
  hp?: number;
  hand?: Card[];
  equipment?: Card[];
};

export type GameRoom = Omit<Room, "players" | "phase" | "pending"> & {
  code: string;
  players: GamePlayer[];

  hostId?: string;

  started?: boolean;
  ended?: boolean;

  turnIndex?: number;

  deck?: Card[];
  discard?: Card[];

  phase?: Phase;
  pending?: Pending;

  bangsUsedThisTurn?: number;

  turnEndsAt?: number;
  pendingEndsAt?: number;
};

export type AnyPending = NonNullable<Pending>;

export function phaseOf(room: GameRoom): Phase {
  return (room.phase ?? "main") as Phase;
}

export function pendingIs<K extends AnyPending["kind"]>(
  room: GameRoom,
  kind: K
): room is GameRoom & { pending: Extract<AnyPending, { kind: K }> } {
  return !!room.pending && typeof room.pending === "object" && (room.pending as any).kind === kind;
}

export const SUITS = ["spades", "hearts", "diamonds", "clubs"] as const;
export const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;

export const PRIVATE_PENDING_KINDS = new Set([
  "bang",
  "indians",
  "gatling",
  "barrel_choice",
  "duel",
  "draw_choice",
  "jesse_choice",
  "pedro_choice",
  "general_store",
  "lucky_choice",
  "discard_limit",
  "revive",
]);

export type PlayPayload = {
  cardId?: string;
  roomCode?: string;

  targetId?: string;

  targetCardId?: string;

  targetHandIndex?: number;

  pickHand?: boolean;

  targetZone?: "hand" | "equipment";
};

export type PlayCardFn = (
  room: GameRoom,
  me: GamePlayer,
  payload: PlayPayload,
  card: Card
) => void;