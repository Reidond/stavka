import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const simulatorRoute = readFileSync(
  new URL("../src/routes/simulations.tsx", import.meta.url),
  "utf8",
);
const replayPage = readFileSync(
  new URL("../src/components/replay-page.tsx", import.meta.url),
  "utf8",
);

describe("Poligon viewport shell", () => {
  it("uses a 100vh fallback followed by the dynamic viewport unit", () => {
    expect(styles).toMatch(/height:\s*100vh;\s*height:\s*100dvh;/u);
    expect(styles).toMatch(/min-height:\s*100vh;\s*min-height:\s*100dvh;/u);
  });

  it("keeps the viewport fixed while simulator panes own scrolling", () => {
    expect(styles).toMatch(/\.poligon-shell\s*\{[\s\S]*overflow:\s*hidden;/u);
    expect(styles).toMatch(
      /\.poligon-layout\s*\{[\s\S]*min-height:\s*0;[\s\S]*overflow:\s*hidden;/u,
    );
    expect(styles).toMatch(
      /\.poligon-layout\s*>\s*section,[\s\S]*\.poligon-replay-content\s*\{[\s\S]*overflow-y:\s*auto;/u,
    );
    expect(replayPage).toContain('className="poligon-replay-content space-y-4"');
    expect(simulatorRoute).toContain('className="flex flex-wrap items-center justify-end gap-2"');
  });
});
