import type {
  AccountSession,
  ActiveAccountSession,
  OrganizationUser,
  SignUpPayload,
} from "@stavka/access-auth";
import type { OwnedProviderAccountPublic } from "@stavka/provider-auth";

const requestJson = async <A>(path: string, init?: RequestInit): Promise<A> => {
  const headers = new Headers(init?.headers);
  headers.set("x-requested-with", "XMLHttpRequest");
  const response = await fetch(path, { ...init, headers });
  const body = (await response.json().catch(() => undefined)) as
    | { readonly error?: { readonly message?: string } }
    | undefined;
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `Stavka request failed with HTTP ${response.status}`);
  }
  return body as A;
};

export const readAccountSession = (): Promise<AccountSession> =>
  requestJson<AccountSession>("/auth/session");

export const signUpAccount = (payload: SignUpPayload): Promise<ActiveAccountSession> =>
  requestJson<ActiveAccountSession>("/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

export const readOrganizationUsers = (): Promise<readonly OrganizationUser[]> =>
  requestJson<{ readonly users: readonly OrganizationUser[] }>("/account/users").then(
    ({ users }) => users,
  );

export const readProviderAccounts = (): Promise<readonly OwnedProviderAccountPublic[]> =>
  requestJson<{ readonly accounts: readonly OwnedProviderAccountPublic[] }>(
    "/admin/provider-accounts",
  ).then(({ accounts }) => accounts);
