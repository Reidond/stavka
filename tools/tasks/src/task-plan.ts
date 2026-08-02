export interface TaskCommand {
  readonly label: string;
  readonly executable: "pnpm";
  readonly arguments: ReadonlyArray<string>;
}

export const evaluationTestFiles = [
  "packages/sim-link/tests/sim-link.test.ts",
  "apps/commander/tests/llm-client.test.ts",
  "apps/commander/tests/command-validator.test.ts",
  "apps/commander/tests/seat-router.test.ts",
  "apps/commander/tests/terrain-prompt.test.ts",
  "apps/commander/tests/semantic-replay.test.ts",
  "apps/poligon/tests/sim-world.test.ts",
  "apps/poligon/tests/sim-world-rpc.test.ts",
  "apps/poligon/tests/offline-sim-host.test.ts",
  "apps/poligon/tests/replay-dashboard.test.tsx",
] as const;

export const evaluationTask = (
  forwardedArguments: ReadonlyArray<string>,
): ReadonlyArray<TaskCommand> => [
  {
    label: "focused deterministic evaluation",
    executable: "pnpm",
    arguments: ["exec", "vp", "test", "--run", ...evaluationTestFiles],
  },
  {
    label: "workspace evaluation",
    executable: "pnpm",
    arguments: [
      "exec",
      "vp",
      "run",
      "--filter",
      "@stavka/*",
      "--filter",
      "!@stavka/tasks",
      "eval",
      ...(forwardedArguments.length === 0 ? [] : ["--", ...forwardedArguments]),
    ],
  },
];

export const tailwindLintTask: ReadonlyArray<TaskCommand> = [
  {
    label: "shared and Commander Tailwind diagnostics",
    executable: "pnpm",
    arguments: [
      "exec",
      "oxlint",
      "--config",
      ".oxlintrc.json",
      "--deny-warnings",
      "apps/commander",
      "packages",
      "tools/architecture",
    ],
  },
  {
    label: "Poligon Tailwind diagnostics",
    executable: "pnpm",
    arguments: [
      "exec",
      "oxlint",
      "--config",
      ".oxlintrc.poligon.json",
      "--deny-warnings",
      "apps/poligon",
    ],
  },
  {
    label: "hosted Maskirovka Tailwind diagnostics",
    executable: "pnpm",
    arguments: [
      "exec",
      "oxlint",
      "--config",
      ".oxlintrc.maskirovka-seat.json",
      "--deny-warnings",
      "apps/maskirovka-seat",
    ],
  },
  {
    label: "local Maskirovka Tailwind diagnostics",
    executable: "pnpm",
    arguments: [
      "exec",
      "oxlint",
      "--config",
      ".oxlintrc.maskirovka.json",
      "--deny-warnings",
      "tools/maskirovka",
    ],
  },
];
