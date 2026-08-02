import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FigureFrame, MapLegend, mapSheetColors, SeatCard, Stamp, StatusChip } from "../src";

describe("map-sheet colors", () => {
  it("exports the exact shared palette", () => {
    expect(mapSheetColors).toEqual({
      paper: "#E9E4D0",
      ink: "#26231B",
      carmine: "#B0342B",
      ultramarine: "#2E4E7E",
      olive: "#6B6B3A",
      contour: "#C7BA92",
    });
  });
});

describe("map-sheet UI", () => {
  it("renders the shared operational components", () => {
    const markup = renderToStaticMarkup(
      <FigureFrame caption="Figure 1">
        <Stamp tone="works">Validated</Stamp>
        <StatusChip tone="pending">Pending</StatusChip>
        <MapLegend items={[{ label: "BLUFOR", tone: "friendly" }]} />
      </FigureFrame>,
    );
    expect(markup).toContain("Validated");
    expect(markup).toContain("Figure 1");
    expect(markup).toContain("BLUFOR");
  });

  it("renders seat health and budget without app-local styling", () => {
    const markup = renderToStaticMarkup(
      <SeatCard
        name="Codex seat"
        provider="codex"
        healthy
        mode="replay"
        budgetUsed={2}
        budgetTotal={10}
        models={["commander", "sergeant"]}
      />,
    );
    expect(markup).toContain("healthy");
    expect(markup).toContain("20%");
  });
});
