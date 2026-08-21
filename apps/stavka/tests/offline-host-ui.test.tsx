import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const agents = vi.hoisted(() => ({ useAgent: vi.fn() }));

vi.mock("agents/react", () => ({ useAgent: agents.useAgent }));
vi.mock("../src/components/battlefield", () => ({
  Battlefield: () => <div>Deterministic battlefield</div>,
}));

const { decodePoligonSearch, PoligonHost } = await import("../src/routes/simulations");

afterEach(() => {
  agents.useAgent.mockReset();
  vi.unstubAllGlobals();
});

describe("Poligon offline host UI", () => {
  it("validates host search input and defaults to the Agent host", () => {
    expect(decodePoligonSearch({}).host).toBe("agent");
    expect(decodePoligonSearch({ host: "offline" }).host).toBe("offline");
    expect(decodePoligonSearch({ seed: "42", time_scale: "100" })).toMatchObject({
      seed: 42,
      time_scale: 100,
    });
    expect(decodePoligonSearch({ seed: 42, time_scale: 100 })).toMatchObject({
      seed: 42,
      time_scale: 100,
    });
    expect(() => decodePoligonSearch({ host: "browser" })).toThrow();
  });

  it("renders browser-local simulation without invoking Agent or network clients", () => {
    const fetchSpy = vi.fn();
    const webSocketSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("WebSocket", webSocketSpy);
    const search = decodePoligonSearch({
      scenario: "engagement",
      seed: "12",
      time_scale: "10",
      camera: "ortho",
      doctrine: "balanced",
      mode: "single",
      host: "offline",
    });

    const markup = renderToStaticMarkup(
      <PoligonHost search={search} navigate={vi.fn() as never} />,
    );

    expect(markup).toContain("browser offline");
    expect(markup).toContain("no commander / no network");
    expect(markup).toContain("Agent WebSocket and Commander networking are disabled");
    expect(markup).toContain("Deterministic battlefield");
    expect(agents.useAgent).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(webSocketSpy).not.toHaveBeenCalled();
  });
});
