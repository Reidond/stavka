import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Schema } from "effect";

import {
  LocalProfilesSchema,
  ProviderAccountSchema,
  ProviderAuthError,
  emptyLocalProfiles,
  providerAccountKey,
  type CloudflareAccessProfile,
  type LocalProfiles,
  type ProviderAccount,
  type ProviderId,
} from "./accounts";

const storeError = (operation: string, cause: unknown): ProviderAuthError =>
  new ProviderAuthError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export class LocalProfileStore {
  readonly file: string;

  constructor(readonly directory: string) {
    this.file = join(directory, "profiles.json");
  }

  read(): Effect.Effect<LocalProfiles, ProviderAuthError> {
    return Effect.tryPromise({
      try: async () => {
        try {
          return Schema.decodeUnknownSync(LocalProfilesSchema)(
            JSON.parse(await readFile(this.file, "utf8")) as unknown,
          );
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return emptyLocalProfiles();
          throw cause;
        }
      },
      catch: (cause) => storeError("profiles.read", cause),
    });
  }

  write(profiles: LocalProfiles): Effect.Effect<void, ProviderAuthError> {
    return Effect.tryPromise({
      try: async () => {
        const validated = Schema.decodeUnknownSync(LocalProfilesSchema)(profiles);
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await chmod(this.directory, 0o700);
        const temporary = join(dirname(this.file), `.profiles-${crypto.randomUUID()}.tmp`);
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.chmod(0o600);
          await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, this.file);
        await chmod(this.file, 0o600);
      },
      catch: (cause) => storeError("profiles.write", cause),
    });
  }

  putProviderAccount(
    account: ProviderAccount,
    activate = true,
  ): Effect.Effect<void, ProviderAuthError> {
    return Effect.gen({ self: this }, function* () {
      const validated = Schema.decodeUnknownSync(ProviderAccountSchema)(account);
      const profiles = yield* this.read();
      const key = providerAccountKey(validated.provider, validated.name);
      const next = {
        ...profiles,
        providerAccounts: [
          ...profiles.providerAccounts.filter(
            (candidate) => providerAccountKey(candidate.provider, candidate.name) !== key,
          ),
          validated,
        ].sort((left, right) =>
          providerAccountKey(left.provider, left.name).localeCompare(
            providerAccountKey(right.provider, right.name),
          ),
        ),
        active: activate ? { ...profiles.active, [validated.provider]: key } : profiles.active,
      } satisfies LocalProfiles;
      yield* this.write(next);
    });
  }

  putCloudflareProfile(
    profile: CloudflareAccessProfile,
    activate = true,
  ): Effect.Effect<void, ProviderAuthError> {
    return Effect.gen({ self: this }, function* () {
      const profiles = yield* this.read();
      yield* this.write({
        ...profiles,
        cloudflareProfiles: [
          ...profiles.cloudflareProfiles.filter((candidate) => candidate.name !== profile.name),
          profile,
        ].sort((left, right) => left.name.localeCompare(right.name)),
        active: activate ? { ...profiles.active, cloudflare: profile.name } : profiles.active,
      });
    });
  }

  useProviderAccount(provider: ProviderId, name: string): Effect.Effect<void, ProviderAuthError> {
    return Effect.gen({ self: this }, function* () {
      const profiles = yield* this.read();
      const key = providerAccountKey(provider, name);
      if (
        !profiles.providerAccounts.some(
          (account) => providerAccountKey(account.provider, account.name) === key,
        )
      ) {
        return yield* Effect.fail(
          new ProviderAuthError({ operation: "profiles.use", message: `Unknown account ${key}` }),
        );
      }
      yield* this.write({ ...profiles, active: { ...profiles.active, [provider]: key } });
    });
  }

  useCloudflareProfile(name: string): Effect.Effect<void, ProviderAuthError> {
    return Effect.gen({ self: this }, function* () {
      const profiles = yield* this.read();
      if (!profiles.cloudflareProfiles.some((profile) => profile.name === name)) {
        return yield* Effect.fail(
          new ProviderAuthError({
            operation: "profiles.use",
            message: `Unknown Cloudflare profile ${name}`,
          }),
        );
      }
      yield* this.write({ ...profiles, active: { ...profiles.active, cloudflare: name } });
    });
  }

  activeProviderAccount(provider: ProviderId): Effect.Effect<ProviderAccount, ProviderAuthError> {
    return this.read().pipe(
      Effect.flatMap((profiles) => {
        const key = profiles.active[provider];
        const account = profiles.providerAccounts.find(
          (candidate) => providerAccountKey(candidate.provider, candidate.name) === key,
        );
        return account
          ? Effect.succeed(account)
          : Effect.fail(
              new ProviderAuthError({
                operation: "profiles.active",
                message: `No active ${provider} account. Run stavka ${provider} login first.`,
              }),
            );
      }),
    );
  }

  providerAccount(
    provider: ProviderId,
    name: string,
  ): Effect.Effect<ProviderAccount, ProviderAuthError> {
    return this.read().pipe(
      Effect.flatMap((profiles) => {
        const key = providerAccountKey(provider, name);
        const account = profiles.providerAccounts.find(
          (candidate) => providerAccountKey(candidate.provider, candidate.name) === key,
        );
        return account
          ? Effect.succeed(account)
          : Effect.fail(
              new ProviderAuthError({
                operation: "profiles.account",
                message: `Unknown provider account ${key}`,
              }),
            );
      }),
    );
  }

  cloudflareProfile(name?: string): Effect.Effect<CloudflareAccessProfile, ProviderAuthError> {
    return this.read().pipe(
      Effect.flatMap((profiles) => {
        const selected = name ?? profiles.active.cloudflare;
        const profile = profiles.cloudflareProfiles.find(
          (candidate) => candidate.name === selected,
        );
        return profile
          ? Effect.succeed(profile)
          : Effect.fail(
              new ProviderAuthError({
                operation: "profiles.cloudflare",
                message: selected
                  ? `Unknown Cloudflare profile ${selected}`
                  : "No active Cloudflare profile. Run stavka cloudflare login first.",
              }),
            );
      }),
    );
  }
}
