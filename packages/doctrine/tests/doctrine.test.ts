import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { decodeDoctrine, doctrines, getDoctrine } from "../src";

describe("doctrines", () => {
  for (const id of Object.keys(doctrines)) {
    it(`decodes ${id}.json`, () => {
      const path = fileURLToPath(new URL(`../src/${id}.json`, import.meta.url));
      const decoded = decodeDoctrine(JSON.parse(readFileSync(path, "utf8")));
      expect(decoded).toEqual(doctrines[id as keyof typeof doctrines]);
    });
  }

  it("falls back to the balanced doctrine", () => {
    expect(getDoctrine("unknown").id).toBe("balanced");
  });

  it("rejects values outside doctrine bounds", () => {
    expect(() => decodeDoctrine({ ...doctrines.balanced, aggression: 1.01 })).toThrow();
    expect(() =>
      decodeDoctrine({ ...doctrines.balanced, max_simultaneous_assaults: 1.5 }),
    ).toThrow();
  });
});
