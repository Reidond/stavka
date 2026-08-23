import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { readAccountSession, signUpAccount } from "../account-api";

export const accountSessionQueryKey = ["stavka-account-session"] as const;

export const AccountGate = ({ children }: { readonly children: ReactNode }) => {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState("");
  const [organizationName, setOrganizationName] = useState("Stavka");
  const session = useQuery({
    queryKey: accountSessionQueryKey,
    queryFn: readAccountSession,
    enabled: typeof window !== "undefined",
    staleTime: 30_000,
  });
  const signUp = useMutation({
    mutationFn: signUpAccount,
    onSuccess: async (active) => {
      queryClient.setQueryData(accountSessionQueryKey, active);
      await queryClient.invalidateQueries({ queryKey: ["stavka-provider-accounts"] });
    },
  });

  if (session.data?.status === "active") return children;

  return (
    <div className="stavka-account-gate">
      <LayerCard className="w-full max-w-xl space-y-4 p-5">
        <div className="space-y-1">
          <p className="m-0 text-xs tracking-wider text-kumo-subtle uppercase">Stavka account</p>
          <h1 className="m-0 text-xl font-semibold text-kumo-strong">First-time setup</h1>
          <p className="m-0 text-sm text-kumo-default">
            Cloudflare Access handles sign in. Stavka now needs your private user profile and
            organization before provider credentials can be authorized.
          </p>
        </div>

        {session.isPending ? (
          <p className="m-0 text-sm text-kumo-subtle">Confirming your signed-in identity…</p>
        ) : null}
        {session.error ? (
          <div className="space-y-3">
            <Banner
              variant="error"
              title="Sign in unavailable"
              description={session.error.message}
            />
            <Button type="button" variant="primary" onClick={() => window.location.assign("/")}>
              Sign in with Cloudflare Access
            </Button>
          </div>
        ) : null}
        {session.data?.status === "setup_required" ? (
          <>
            <LayerCard className="space-y-1 p-3">
              <p className="m-0 text-xs text-kumo-subtle uppercase">Signed in with Access</p>
              <p className="m-0 text-sm font-medium text-kumo-strong">
                {session.data.identity.email ?? "Verified Cloudflare Access identity"}
              </p>
              <p className="m-0 text-xs text-kumo-subtle">
                Access role: {session.data.identity.accessRole}
              </p>
            </LayerCard>
            {session.data.canSignUp ? (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  signUp.mutate({
                    displayName: displayName.trim(),
                    organizationName: organizationName.trim(),
                  });
                }}
              >
                <Input
                  label="Your name"
                  autoComplete="name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.currentTarget.value)}
                  maxLength={120}
                  required
                />
                <Input
                  label="Organization"
                  value={organizationName}
                  onChange={(event) => setOrganizationName(event.currentTarget.value)}
                  maxLength={120}
                  required
                />
                {signUp.error ? (
                  <Banner
                    variant="error"
                    title="Profile setup failed"
                    description={signUp.error.message}
                  />
                ) : null}
                <Button
                  type="submit"
                  variant="primary"
                  loading={signUp.isPending}
                  disabled={!displayName.trim() || !organizationName.trim()}
                >
                  Create my Stavka profile
                </Button>
              </form>
            ) : (
              <Banner
                variant="error"
                title="Registration unavailable"
                description="Only the designated Stavka owner can create the organization, and only one organization is allowed."
              />
            )}
          </>
        ) : null}
      </LayerCard>
    </div>
  );
};
