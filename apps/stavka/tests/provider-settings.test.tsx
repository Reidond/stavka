import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AccountGate, accountSessionQueryKey } from "../src/components/account-gate";
import { ProviderSettings } from "../src/routes/settings/providers";

const activeSession = {
  status: "active" as const,
  user: {
    id: "user-1",
    displayName: "Andrii Shafar",
    email: "owner@example.test",
    createdAt: 1,
    updatedAt: 1,
  },
  organization: {
    id: "organization-1",
    slug: "stavka-organization",
    name: "Stavka",
    createdAt: 1,
    updatedAt: 1,
  },
  membership: {
    organizationId: "organization-1",
    userId: "user-1",
    role: "owner" as const,
    joinedAt: 1,
  },
};

describe("provider settings", () => {
  it("renders first-time sign-up for the verified owner before application access", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(accountSessionQueryKey, {
      status: "setup_required",
      identity: { email: "owner@example.test", accessRole: "owner" },
      canSignUp: true,
    });

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <AccountGate>
          <p>private application</p>
        </AccountGate>
      </QueryClientProvider>,
    );

    expect(html).toContain("First-time setup");
    expect(html).toContain("owner@example.test");
    expect(html).toContain("Create my Stavka profile");
    expect(html).not.toContain("private application");
  });

  it("shows the signed-in owner on the owned Codex and Claude authorization surface", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(accountSessionQueryKey, activeSession);
    queryClient.setQueryData(
      ["stavka-organization-users"],
      [{ user: activeSession.user, membership: activeSession.membership }],
    );
    queryClient.setQueryData(
      ["stavka-provider-accounts"],
      [
        {
          provider: "codex",
          name: "production",
          label: "Production Codex",
          authKind: "chatgpt-oauth",
          active: true,
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
          owner: {
            id: activeSession.user.id,
            displayName: activeSession.user.displayName,
            email: activeSession.user.email,
          },
          organization: {
            id: activeSession.organization.id,
            name: activeSession.organization.name,
          },
        },
      ],
    );

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <ProviderSettings />
      </QueryClientProvider>,
    );

    expect(html).toContain("Authorization owner");
    expect(html).toContain("Andrii Shafar");
    expect(html).toContain("owner@example.test");
    expect(html).toContain("Production Codex");
    expect(html).toContain("1 visible user");
    expect(html).not.toContain("access-secret");
  });
});
