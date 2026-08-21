import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { ReplayPage } = await import("../src/components/replay-page");

describe("replay route", () => {
  it("offers a bounded local file input and a return to the simulator", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const markup = renderToStaticMarkup(<ReplayPage onReturn={vi.fn()} />);

    expect(markup).toContain('type="file"');
    expect(markup).toContain('accept=".json,application/json"');
    expect(markup).toContain("Nothing is uploaded and remote URLs are not accepted");
    expect(markup).toContain("max 5 MiB");
    expect(markup).toContain("Return to simulator");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
