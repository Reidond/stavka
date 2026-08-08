import { describe, expect, it } from "vitest";

import {
  evaluationTask,
  evaluationTestFiles,
  maskirovkaGatewayBuildTask,
  productionDeployTask,
  tailwindLintTask,
} from "../src/task-plan";

describe("repository task plans", () => {
  it("keeps the evaluation file list out of package.json and forwards task arguments", () => {
    const commands = evaluationTask(["--replay"]);

    expect(commands).toHaveLength(2);
    expect(commands[0]?.arguments).toEqual(["exec", "vp", "test", "--run", ...evaluationTestFiles]);
    expect(commands[1]?.arguments).toEqual([
      "exec",
      "vp",
      "run",
      "--filter",
      "@stavka/*",
      "--filter",
      "!@stavka/tasks",
      "eval",
      "--",
      "--replay",
    ]);
  });

  it("keeps every Tailwind entrypoint explicit and warning-fatal", () => {
    expect(
      tailwindLintTask.map(
        (command) => command.arguments[command.arguments.indexOf("--config") + 1],
      ),
    ).toEqual([
      ".oxlintrc.json",
      ".oxlintrc.poligon.json",
      ".oxlintrc.maskirovka-seat.json",
      ".oxlintrc.maskirovka.json",
      ".oxlintrc.maskirovka-gateway.json",
    ]);
    expect(tailwindLintTask.every((command) => command.arguments.includes("--deny-warnings"))).toBe(
      true,
    );
  });

  it("builds the gateway dashboard before its Worker dry run", () => {
    expect(maskirovkaGatewayBuildTask.map((command) => command.arguments)).toEqual([
      ["--filter", "@stavka/maskirovka-gateway", "build:dashboard"],
      [
        "--filter",
        "@stavka/maskirovka-gateway",
        "exec",
        "wrangler",
        "deploy",
        "--dry-run",
        "--outdir",
        "dist/worker",
      ],
    ]);
  });

  it("prebuilds every service before deploying in dependency order", () => {
    expect(productionDeployTask.map((command) => command.arguments)).toEqual([
      ["--filter", "@stavka/maskirovka-gateway", "build:dashboard"],
      ["--filter", "@stavka/maskirovka-seat", "build:dashboard"],
      ["--filter", "@stavka/poligon", "build"],
      ["--filter", "@stavka/maskirovka-gateway", "exec", "wrangler", "deploy"],
      ["--filter", "@stavka/maskirovka-seat", "exec", "wrangler", "deploy"],
      ["--filter", "@stavka/commander", "exec", "wrangler", "deploy"],
      [
        "--filter",
        "@stavka/poligon",
        "exec",
        "wrangler",
        "deploy",
        "-c",
        "dist/server/wrangler.json",
      ],
    ]);

    const firstDeploy = productionDeployTask.findIndex((command) =>
      command.arguments.includes("deploy"),
    );
    expect(firstDeploy).toBe(3);
    expect(
      productionDeployTask
        .slice(0, firstDeploy)
        .every(
          (command) =>
            command.arguments.includes("build") || command.arguments.includes("build:dashboard"),
        ),
    ).toBe(true);
  });
});
