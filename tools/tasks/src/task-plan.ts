export interface TaskCommand {
  readonly label: string;
  readonly executable: "pnpm";
  readonly arguments: ReadonlyArray<string>;
}

const gatewayFilter = "@stavka/maskirovka-gateway";
const seatFilter = "@stavka/maskirovka-seat";
const commanderFilter = "@stavka/commander";
const poligonFilter = "@stavka/stavka";

const filterScript = (filter: string, script: string): TaskCommand => ({
  label: `${filter} ${script}`,
  executable: "pnpm",
  arguments: ["--filter", filter, script],
});

export const maskirovkaGatewayBuildTask: ReadonlyArray<TaskCommand> = [
  filterScript(gatewayFilter, "build:dashboard"),
  {
    label: "Maskirovka gateway Worker dry run",
    executable: "pnpm",
    arguments: [
      "--filter",
      gatewayFilter,
      "exec",
      "wrangler",
      "deploy",
      "--dry-run",
      "--outdir",
      "dist/worker",
    ],
  },
];

export const productionDeployTask: ReadonlyArray<TaskCommand> = [
  filterScript(gatewayFilter, "build:dashboard"),
  filterScript(seatFilter, "build:dashboard"),
  filterScript(poligonFilter, "build"),
  {
    label: "Deploy Maskirovka gateway",
    executable: "pnpm",
    arguments: ["--filter", gatewayFilter, "exec", "wrangler", "deploy"],
  },
  {
    label: "Deploy Maskirovka seat",
    executable: "pnpm",
    arguments: ["--filter", seatFilter, "exec", "wrangler", "deploy"],
  },
  {
    label: "Deploy Commander",
    executable: "pnpm",
    arguments: ["--filter", commanderFilter, "exec", "wrangler", "deploy"],
  },
  {
    label: "Deploy Poligon",
    executable: "pnpm",
    arguments: [
      "--filter",
      poligonFilter,
      "exec",
      "wrangler",
      "deploy",
      "-c",
      "dist/server/wrangler.json",
    ],
  },
];

export const evaluationTestFiles = [
  "packages/sim-link/tests/sim-link.test.ts",
  "apps/commander/tests/llm-client.test.ts",
  "apps/commander/tests/command-validator.test.ts",
  "apps/commander/tests/seat-router.test.ts",
  "apps/commander/tests/terrain-prompt.test.ts",
  "apps/commander/tests/semantic-replay.test.ts",
  "apps/stavka/tests/sim-world.test.ts",
  "apps/stavka/tests/sim-world-rpc.test.ts",
  "apps/stavka/tests/offline-sim-host.test.ts",
  "apps/stavka/tests/replay-dashboard.test.tsx",
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
    label: "Commander Tailwind diagnostics",
    executable: "pnpm",
    arguments: [
      "exec",
      "oxlint",
      "--config",
      ".oxlintrc.json",
      "--deny-warnings",
      "apps/commander",
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
      ".oxlintrc.stavka.json",
      "--deny-warnings",
      "apps/stavka",
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
  {
    label: "gateway Maskirovka Tailwind diagnostics",
    executable: "pnpm",
    arguments: [
      "exec",
      "oxlint",
      "--config",
      ".oxlintrc.maskirovka-gateway.json",
      "--deny-warnings",
      "apps/maskirovka-gateway",
    ],
  },
];
