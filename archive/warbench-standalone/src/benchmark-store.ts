import { DurableObject } from "cloudflare:workers";
import type { SeedResult } from "./benchmark";

export class BenchmarkStore extends DurableObject<Record<string, never>> {
  async put(result: SeedResult): Promise<void> {
    const key = `${result.controller}:${result.family}:${result.seed}`;
    await this.ctx.storage.put(key, result);
  }

  async list(): Promise<SeedResult[]> {
    const rows = await this.ctx.storage.list<SeedResult>();
    return [...rows.values()].sort((left, right) => {
      const controller = left.controller.localeCompare(right.controller);
      if (controller !== 0) return controller;
      const family = left.family.localeCompare(right.family);
      return family !== 0 ? family : left.seed - right.seed;
    });
  }

  async clear(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
