import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../src/dashboard/styles.css", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../src/dashboard/src.tsx", import.meta.url), "utf8");
const document = readFileSync(new URL("../src/dashboard/index.html", import.meta.url), "utf8");

describe("Maskirovka gateway dashboard shell", () => {
  it("uses a light Kumo mode and the dynamic viewport fallback", () => {
    expect(document).toContain('<html lang="en" data-mode="light">');
    expect(styles).toMatch(/height:\s*100vh;\s*height:\s*100dvh;/u);
    expect(styles).toMatch(/min-height:\s*100vh;\s*min-height:\s*100dvh;/u);
  });

  it("keeps scrolling in the explicit content pane", () => {
    expect(styles).toMatch(/\.maskirovka-gateway-shell\s*\{[\s\S]*overflow:\s*hidden;/u);
    expect(styles).toMatch(
      /\.maskirovka-gateway-content\s*\{[\s\S]*min-height:\s*0;[\s\S]*overflow-y:\s*auto;/u,
    );
    expect(dashboard).toContain('className="maskirovka-gateway-content"');
  });

  it("keeps credential controls labelled and errors announced", () => {
    expect(dashboard).toContain('label="Token"');
    expect(dashboard).toContain('title="Credential update failed"');
    expect(dashboard).toContain('type="password"');
  });
});
