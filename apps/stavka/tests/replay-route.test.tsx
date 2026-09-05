import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SessionInspector } from "../src/components/sessions";

describe("session export source", () => {
  it("offers a bounded local file input without making a network request", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const markup = renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <SessionInspector initialSource="file" />
        </QueryClientProvider>,
      );
      expect(markup).toContain('type="file"');
      expect(markup).toContain('accept=".json,application/json"');
      expect(markup).toContain("The file stays in");
      expect(markup).toContain("5");
      expect(markup).toContain("Choose export file");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
