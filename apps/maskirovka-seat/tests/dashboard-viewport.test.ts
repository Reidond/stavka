import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../src/dashboard/styles.css", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../src/dashboard/src.tsx", import.meta.url), "utf8");

describe("Hosted Maskirovka seat viewport shell", () => {
  it("uses a 100vh fallback followed by the dynamic viewport unit", () => {
    expect(styles).toMatch(/height:\s*100vh;\s*height:\s*100dvh;/u);
    expect(styles).toMatch(/min-height:\s*100vh;\s*min-height:\s*100dvh;/u);
  });

  it("confines document scrolling to the dashboard content pane", () => {
    expect(styles).toMatch(/\.maskirovka-shell\s*\{[\s\S]*overflow:\s*hidden;/u);
    expect(styles).toMatch(
      /\.maskirovka-content\s*\{[\s\S]*min-height:\s*0;[\s\S]*overflow-y:\s*auto;/u,
    );
    expect(dashboard).toContain('className="maskirovka-content"');
  });
});
