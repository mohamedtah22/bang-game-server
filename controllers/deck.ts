// models/player.ts
import type WebSocket from "ws";

/** Roles in BANG! */
export type Role = "sheriff" | "deputy" | "outlaw" | "renegade";

/** 16 base characters */
export type CharacterId =
  | "bart_cassidy"
  | "black_jack"
  | "calamity_janet"
  | "el_gringo"
  | "jesse_jones"
  | "jourdonnais"
  | "kit_carlson"
  | "lucky_duke"
  | "paul_regret"
  | "pedro_ramirez"
  | "rose_doolan"
  | "sid_ketchum"
  | "slab_the_killer"
  | "suzy_lafayette"
  | "vulture_sam"
  | "willy_the_kid";

export type Suit = "spades" | "hearts" | "diamonds" | "clubs";
export type Rank =
  | "A"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "10"
  | "J"
  | "Q"
  | "K";

/**
 * Card keys (base game)
 * - Brown: instant
 * - Blue: equipment / in-play
 *
 * ملاحظة: خليت الأسلحة مفصّلة (volcanic/schofield/...) عشان الرينج يكون واضح
 */
export type CardKey =
  // brown
  | "bang"
  | "missed"
  | "beer"
  | "panic"
  | "catbalou"
  | "duel"
  | "gatling"
  | "indians"
  | "general_store"
  | "stagecoach"
  | "wellsfargo"
  | "saloon"
  // blue
  | "jail"
  | "dynamite"
  | "barrel"
  | "mustang"
  | "scope"
  | "appaloosa"
  | "volcanic"
  | "schofield"
  | "remington"
  | "rev_carabine"
  | "winchester";

export const CHARACTER_HP: Record<CharacterId, number> = {
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

export type Card = {
  id: string; // unique instance id
  key: CardKey;
  suit?: Suit;
  rank?: Rank;
};

export type Player = {
  id: string;
  name: string;

  /** server only */
  ws: WebSocket;

  role: Role;
  playcharacter: CharacterId;

  hp: number;
  maxHp: number;
  isAlive: boolean;

  hand: Card[];
  equipment: Card[]; // includes blue cards in front of player
};

export type PublicPlayer = Omit<Player, "ws" | "hand"> & {
  handCount: number;
};

export function toPublicPlayer(p: Player): PublicPlayer {
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    playcharacter: p.playcharacter,
    hp: p.hp,
    maxHp: p.maxHp,
    isAlive: p.isAlive,
    equipment: p.equipment,
    handCount: p.hand.length,
  };
}
