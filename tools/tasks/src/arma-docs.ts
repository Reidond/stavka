import { dirname, resolve } from "node:path";
import { Config, Console, Effect, FileSystem, Schema } from "effect";
import { ArmaEnvironment, ArmaTaskFailed } from "./arma-environment";

const DocEntry = Schema.Struct({
  symbol: Schema.String,
  source: Schema.String,
  signatures: Schema.Array(Schema.String),
});
const DocIndex = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  engineVersion: Schema.String,
  apiRoot: Schema.String,
  entries: Schema.Array(DocEntry),
});

export const plainHtml = (html: string): string =>
  html
    .replace(/<[^>]*>/gu, " ")
    .replace(
      /&#(?:x([\da-f]+)|(\d+));/giu,
      (_, hex: string | undefined, decimal: string | undefined) => {
        const code = Number.parseInt(hex ?? decimal ?? "32", hex ? 16 : 10);
        return code <= 0x10ffff ? String.fromCodePoint(code) : " ";
      },
    )
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replace(/\s+/gu, " ")
    .trim();

export const extractSignatures = (html: string): ReadonlyArray<string> =>
  [...html.matchAll(/<tr class="memitem:[\s\S]*?<\/tr>/gu)].map((match) => plainHtml(match[0]));

/** Read-only native API lookup. The only writes are a versioned local cache. */
export const searchArmaDocs = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const rebuild = args.includes("--reindex");
    const query = args
      .filter((arg) => arg !== "--reindex")
      .join(" ")
      .trim();
    if (!query || query.length > 120)
      return yield* Effect.fail(
        new ArmaTaskFailed({
          stage: "docs",
          message: "Provide a symbol or method name (1–120 characters).",
        }),
      );
    const fs = yield* FileSystem.FileSystem;
    const environment = yield* ArmaEnvironment;
    const installation = yield* environment.inspect;
    const apiRoot = resolve(dirname(installation.executable), "docs");
    const home = yield* Config.string("USERPROFILE");
    const cache = resolve(home, ".cache/stavka/arma-reforger", installation.toolsVersion);
    yield* fs.makeDirectory(cache, { recursive: true });
    const indexPath = resolve(cache, "api-index-v1.json");
    let index: typeof DocIndex.Type | undefined;
    if (!rebuild && (yield* fs.exists(indexPath))) {
      index = yield* fs.readFileString(indexPath).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(DocIndex))),
        Effect.catch(() => Effect.succeed(undefined)),
      );
      if (index?.apiRoot !== apiRoot || index?.engineVersion !== installation.toolsVersion)
        index = undefined;
    }
    if (!index) {
      const entries: Array<typeof DocEntry.Type> = [];
      for (const api of ["EnfusionScriptAPI", "ArmaReforgerScriptAPIPublic"]) {
        const htmlRoot = resolve(apiRoot, api, "html");
        const files = (yield* fs.readDirectory(htmlRoot))
          .filter((file) => /^interface[^/]+\.html$/u.test(file) && !file.endsWith("-members.html"))
          .sort();
        const batch = yield* Effect.forEach(
          files,
          (file) =>
            Effect.gen(function* () {
              const source = resolve(htmlRoot, file);
              const html = yield* fs.readFileString(source);
              const title = /<title>([\s\S]*?)<\/title>/u.exec(html)?.[1] ?? file;
              return {
                symbol: plainHtml(title)
                  .replace(/^.*?: /u, "")
                  .replace(/ Interface Reference$/u, ""),
                source,
                signatures: extractSignatures(html),
              };
            }),
          { concurrency: 16 },
        );
        entries.push(...batch);
      }
      index = { schemaVersion: 1, engineVersion: installation.toolsVersion, apiRoot, entries };
      const staging = `${indexPath}.${crypto.randomUUID()}.tmp`;
      yield* fs.writeFileString(staging, JSON.stringify(index));
      yield* fs.rename(staging, indexPath);
    }
    const needle = query.toLowerCase();
    const matches = index.entries
      .flatMap((entry) => {
        const nameMatch = entry.symbol.toLowerCase().includes(needle);
        const signatures = entry.signatures.filter(
          (signature) => nameMatch || signature.toLowerCase().includes(needle),
        );
        return nameMatch || signatures.length
          ? [{ symbol: entry.symbol, source: entry.source, signatures: signatures.slice(0, 30) }]
          : [];
      })
      .sort(
        (a, b) =>
          Number(b.symbol.toLowerCase() === needle) - Number(a.symbol.toLowerCase() === needle),
      );
    return {
      engineVersion: index.engineVersion,
      query,
      totalMatches: matches.length,
      matches: matches.slice(0, 20),
      cache: indexPath,
    };
  });

export const runArmaDocs = (args: ReadonlyArray<string>) =>
  searchArmaDocs(args).pipe(
    Effect.flatMap((result) => Console.log(JSON.stringify(result, null, 2))),
  );
