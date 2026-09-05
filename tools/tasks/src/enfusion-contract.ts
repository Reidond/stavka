import { Data, Schema } from "effect";

export const RunId = Schema.String.check(
  Schema.isPattern(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u,
  ),
);
const Query = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120));
const ResourceQuery = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,119}$/u),
);
const Timeout = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 600 }));
export const EmptyInput = Schema.Record(Schema.String, Schema.Never);
export const DocsInput = Schema.Struct({ query: Query });
export const RunInput = Schema.Struct({
  action: Schema.Literals(["validate", "smoke", "pack", "resources"]),
  target: Schema.optionalKey(Schema.Literals(["ALL", "WORKBENCH", "PC", "XBOX", "PS4", "PS5"])),
  timeoutSeconds: Schema.optionalKey(Timeout),
  query: Schema.optionalKey(ResourceQuery),
});
export type RunInput = typeof RunInput.Type;
export const JobInput = Schema.Struct({ runId: RunId });

export class EnfusionError extends Data.TaggedError("EnfusionError")<{
  readonly code: "INVALID_ARGUMENT" | "BUSY" | "NOT_FOUND" | "FAILED";
  readonly message: string;
}> {}

export const toNativeArguments = (input: RunInput): ReadonlyArray<string> => [
  ...(input.target ? ["--target", input.target] : []),
  ...(input.timeoutSeconds ? ["--timeout-seconds", String(input.timeoutSeconds)] : []),
  ...(input.query ? ["--query", input.query] : []),
];

export const toolContracts = [
  {
    name: "enfusion_doctor",
    description:
      "Inspect the local game/Tools installation, project presence and editor conflicts. Does not launch Workbench.",
    input: EmptyInput,
    readOnly: true,
  },
  {
    name: "enfusion_docs",
    description:
      "Search version-matched offline Enfusion/Reforger API signatures. Returns original documentation paths; no browser needed.",
    input: DocsInput,
    readOnly: true,
  },
  {
    name: "enfusion_start",
    description:
      "Start an isolated native validation, AI smoke, package or resource lookup job. Returns a runId immediately; poll enfusion_job. One active job per server. Target applies only to validation; resources requires query. No deployment, Workshop publishing or provider calls.",
    input: RunInput,
    readOnly: false,
  },
  {
    name: "enfusion_job",
    description:
      "Read a native job's state and completed evidence. Poll after a short delay while running. Completed results include artifact paths and digest verification.",
    input: JobInput,
    readOnly: true,
  },
  {
    name: "enfusion_cancel",
    description:
      "Cancel an active job owned by this MCP session and wait for scoped cleanup. Cannot stop unrelated editors or jobs from another session.",
    input: JobInput,
    readOnly: false,
  },
  {
    name: "enfusion_inspect",
    description:
      "Read a saved CLI/MCP run and verify artifact digests. Accepts only a run UUID inside the configured project's output directory.",
    input: JobInput,
    readOnly: true,
  },
] as const;
