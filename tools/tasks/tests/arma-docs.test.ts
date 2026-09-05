import { describe, expect, it } from "vitest";
import { extractSignatures, plainHtml } from "../src/arma-docs";

describe("offline native API extraction", () => {
  it("preserves generic types, numeric entities and literal ampersands", () => {
    expect(plainHtml("<a>array</a>&lt;string&gt;&#160; Search(&quot;A&amp;B&quot;)")).toBe(
      'array <string> Search("A&B")',
    );
  });
  it("extracts member rows without treating surrounding page text as API signatures", () => {
    const page =
      '<title>Navigation</title><tr class="memitem:abc"><td>proto bool&#160;</td><td><a>SwitchToGameMode</a> ()</td></tr><p>footer</p>';
    expect(extractSignatures(page)).toEqual(["proto bool SwitchToGameMode ()"]);
  });
});
