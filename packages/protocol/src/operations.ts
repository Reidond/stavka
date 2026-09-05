import { Schema } from "effect";

/** Metadata-only projection used by the human operations UI. */
export const InferenceStatus = Schema.Struct({
  ok: Schema.Boolean,
  mode: Schema.Literals(["live", "record", "replay"]),
  killed: Schema.Boolean,
  aliases: Schema.Array(
    Schema.Struct({ tier: Schema.String, seat: Schema.String, model: Schema.String }),
  ),
  container: Schema.Struct({ status: Schema.String, last_change: Schema.Number }),
});

export const CommanderHealth = Schema.Struct({
  ok: Schema.Boolean,
  status: Schema.Literals(["live", "degraded", "not_ready"]),
  service: Schema.Literal("stavka-commander"),
  protocol_version: Schema.Literal(1),
});

/** Provider response fields shown after an explicit human model test. */
export const ModelProbeResponse = Schema.Struct({
  model: Schema.String,
  usage: Schema.Struct({ input_tokens: Schema.Number, output_tokens: Schema.Number }),
  output: Schema.optional(
    Schema.Array(
      Schema.Struct({
        content: Schema.optional(
          Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
        ),
      }),
    ),
  ),
  content: Schema.optional(Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))),
});

export const ModelProbeFailure = Schema.Struct({
  error: Schema.Struct({ message: Schema.String }),
});
