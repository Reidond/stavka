import { Button } from "@cloudflare/kumo/components/button";
import { Banner } from "@cloudflare/kumo/components/banner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect, Schema } from "effect";
import { ActiveAccountSessionSchema } from "@stavka/access-auth";
import type { ExecutionSession } from "@stavka/protocol";
import { readAccountSession } from "../account-api";
import { requestExecution } from "../execution-api";
import { accountSessionQueryKey } from "./account-gate";

export function SessionAiAuthorization({ session }: { readonly session: ExecutionSession }) {
  const queryClient = useQueryClient();
  const account = useQuery({
    queryKey: accountSessionQueryKey,
    queryFn: readAccountSession,
    staleTime: 30_000,
  });
  const sessionData = account.data;
  const identity = Schema.is(ActiveAccountSessionSchema)(sessionData) ? sessionData : undefined;
  const canOperate = identity?.membership.role === "owner" || identity?.membership.role === "admin";
  const queryKey = [
    "session-ai-authorization",
    identity?.organization.id,
    identity?.user.id,
    session,
  ] as const;
  const authorization = useQuery({
    queryKey,
    enabled: canOperate,
    queryFn: () => Effect.runPromise(requestExecution("status", session)),
    refetchInterval: 10_000,
    retry: false,
  });
  const change = useMutation({
    mutationFn: (action: "authorize" | "revoke") =>
      Effect.runPromise(
        requestExecution(
          action,
          action === "authorize"
            ? {
                ...session,
                duration_minutes: 60,
                request_limit: 20,
              }
            : session,
        ),
      ),
    onSuccess: (result) => queryClient.setQueryData(queryKey, result),
  });
  if (!canOperate) return null;
  const grant = authorization.data?.grant;
  const active = grant?.status === "active";
  const error = change.error ?? authorization.error;
  return (
    <section className="space-y-2 text-sm" aria-label={`AI authorization for ${session.faction}`}>
      <p className="m-0 font-medium text-kumo-strong">{session.faction} AI commander</p>
      <p className="m-0 text-xs text-kumo-subtle">
        {active
          ? `${grant.request_limit - grant.requests_used} requests left · expires ${new Date(grant.expires_at).toLocaleTimeString()}`
          : "Enable up to 20 AI requests for one hour using your active provider accounts."}
      </p>
      {error ? (
        <Banner variant="error" title="AI authorization" description={error.message} />
      ) : null}
      <Button
        type="button"
        size="sm"
        variant={active ? "secondary" : "primary"}
        loading={change.isPending}
        disabled={authorization.isPending || Boolean(authorization.error)}
        onClick={() => change.mutate(active ? "revoke" : "authorize")}
      >
        {active ? "Disable AI" : "Enable AI for 1 hour"}
      </Button>
      {active ? (
        <p className="m-0 text-xs text-kumo-subtle">
          Disabling stops new requests; an active response may finish.
        </p>
      ) : null}
    </section>
  );
}
