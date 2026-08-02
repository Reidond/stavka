import { describe, expect, it } from "vitest";

import { evaluationTask, evaluationTestFiles, tailwindLintTask } from "../src/task-plan";

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
    ]);
    expect(tailwindLintTask.every((command) => command.arguments.includes("--deny-warnings"))).toBe(
      true,
    );
  });
});
