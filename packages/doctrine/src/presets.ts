import type { Doctrine } from "./types";

export const aggressive = {
  id: "aggressive",
  name: "Soviet Aggressive",
  description: "Overwhelming force, rapid assault, accepts casualties",
  aggression: 0.9,
  caution: 0.2,
  flanking_preference: 0.6,
  counterattack_threshold: 0.3,
  reinforcement_bias: 0.8,
  max_simultaneous_assaults: 3,
  personality: {
    brief:
      "You are a Soviet battalion commander in the 1980s. Favor rapid combined-arms assault and decisive local superiority, while respecting the resource budget.",
  },
} as const satisfies Doctrine;

export const defensive = {
  id: "defensive",
  name: "Defense in Depth",
  description: "Preserves combat power, prepares layered positions, counterattacks selectively",
  aggression: 0.35,
  caution: 0.85,
  flanking_preference: 0.45,
  counterattack_threshold: 0.7,
  reinforcement_bias: 0.9,
  max_simultaneous_assaults: 1,
  personality: {
    brief:
      "You command a defense in depth. Preserve combat power, contest key terrain, and counterattack only when the local balance is favorable.",
  },
} as const satisfies Doctrine;

export const balanced = {
  id: "balanced",
  name: "Balanced Maneuver",
  description: "Balances initiative, force preservation, reinforcement, and maneuver",
  aggression: 0.6,
  caution: 0.55,
  flanking_preference: 0.65,
  counterattack_threshold: 0.5,
  reinforcement_bias: 0.6,
  max_simultaneous_assaults: 2,
  personality: {
    brief:
      "You are a disciplined battalion commander. Gain information, concentrate force, use terrain, and preserve a reserve for unexpected threats.",
  },
} as const satisfies Doctrine;

export const doctrines = { aggressive, defensive, balanced } as const;
export type DoctrineId = keyof typeof doctrines;

export const getDoctrine = (id: string): Doctrine =>
  doctrines[id as DoctrineId] ?? balanced;

export const doctrinePrompt = (doctrine: Doctrine, difficulty: number): string =>
  [
    `Doctrine: ${doctrine.name}.`,
    doctrine.personality.brief,
    `Aggression ${doctrine.aggression.toFixed(2)}; caution ${doctrine.caution.toFixed(2)}; flanking preference ${doctrine.flanking_preference.toFixed(2)}.`,
    `Difficulty ${Math.min(1, Math.max(0, difficulty)).toFixed(2)}. Never exceed the supplied resource budget or active-unit cap.`,
  ].join(" ");
