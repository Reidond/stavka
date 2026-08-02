import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { Context, Effect, Layer } from "effect";

import { GatewayError } from "../domain/types";

export interface StaticAsset {
  readonly content: Uint8Array;
  readonly contentType: string;
}

const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export interface StaticAssetRepositoryService {
  readonly read: (path: string) => Effect.Effect<StaticAsset | undefined, GatewayError>;
}

export class StaticAssetRepository extends Context.Service<
  StaticAssetRepository,
  StaticAssetRepositoryService
>()("@stavka/maskirovka/StaticAssetRepository") {}

export class FileStaticAssetRepository implements StaticAssetRepositoryService {
  constructor(private readonly root: string) {}

  read(path: string): Effect.Effect<StaticAsset | undefined, GatewayError> {
    return Effect.tryPromise({
      try: async () => {
        const safe = normalize(path).replace(/^([.][.][/\\])+/u, "").replace(/^[/\\]+/u, "");
        const filename = join(this.root, safe || "index.html");
        if (
          !filename.startsWith(`${normalize(this.root)}${sep}`) &&
          filename !== normalize(this.root)
        ) return undefined;
        try {
          return {
            content: await readFile(filename),
            contentType: contentTypes[extname(filename)] ?? "application/octet-stream",
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      },
      catch: (cause) => new GatewayError(
        500,
        "STATIC_ASSET_REPOSITORY_FAILURE",
        "Unable to read a dashboard asset",
        [cause instanceof Error ? cause.message : "Unknown static asset error"],
      ),
    });
  }
}

export const StaticAssetRepositoryLive = (
  root: string,
): Layer.Layer<StaticAssetRepository> =>
  Layer.succeed(StaticAssetRepository, new FileStaticAssetRepository(root));
