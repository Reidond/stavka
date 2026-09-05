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

  it("shows provider metadata without duplicating profile details", () => {
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

    expect(html).not.toContain("Authorization owner");
    expect(html).not.toContain("owner@example.test");
    expect(html).toContain("ChatGPT sign-in");
    expect(html).toContain("Connected");
    expect(html).toContain("Updated");
    expect(html).toContain("Production Codex");
    expect(html).toContain("Active");
    expect(html).not.toContain("access-secret");
  });
});
