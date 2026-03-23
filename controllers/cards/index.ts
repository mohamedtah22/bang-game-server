import type { PlayCardFn } from "./types";

import { playWeapon } from "./weapon";
import { playBarrel } from "./barrel";
import { playMustang } from "./mustang";
import { playScope } from "./scope";
import { playDynamite } from "./dynamite";
import { playJail } from "./jail";
import { playBang } from "./bang";
import { playBeer } from "./beer";
import { playStagecoach } from "./stagecoach";
import { playWellsFargo } from "./wellsfargo";
import { playGeneralStore } from "./generalstore";
import { playSaloon } from "./saloon";
import { playPanic } from "./panic";
import { playCatBalou } from "./catbalou";
import { playIndians } from "./indians";
import { playGatling } from "./gatling";
import { playDuel } from "./duel";

export const cardPlayRegistry: Record<string, PlayCardFn> = {
  weapon: playWeapon,
  barrel: playBarrel,
  mustang: playMustang,
  scope: playScope,
  dynamite: playDynamite,
  jail: playJail,
  bang: playBang,
  missed: playBang,
  beer: playBeer,
  stagecoach: playStagecoach,
  wellsfargo: playWellsFargo,
  generalstore: playGeneralStore,
  saloon: playSaloon,
  panic: playPanic,
  catbalou: playCatBalou,
  indians: playIndians,
  gatling: playGatling,
  duel: playDuel,
};

