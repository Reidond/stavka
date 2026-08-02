import { Schema } from "effect";

const UnitInterval = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

export const Doctrine = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  aggression: UnitInterval,
  caution: UnitInterval,
  flanking_preference: UnitInterval,
  counterattack_threshold: UnitInterval,
  reinforcement_bias: UnitInterval,
  max_simultaneous_assaults: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
  personality: Schema.Struct({ brief: Schema.String }),
});
export type Doctrine = typeof Doctrine.Type;

export const decodeDoctrine = Schema.decodeUnknownSync(Doctrine);
