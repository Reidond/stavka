/** Mulberry32 with explicitly persisted uint32 state. */
export const nextRandom = (state: number): readonly [number, number] => {
  const nextState = (state + 0x6d2b79f5) >>> 0;
  let value = nextState;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return [((value ^ (value >>> 14)) >>> 0) / 4_294_967_296, nextState] as const;
};

export const randomFromWorld = (world: { rngState: number }): number => {
  const [value, state] = nextRandom(world.rngState);
  world.rngState = state;
  return value;
};
