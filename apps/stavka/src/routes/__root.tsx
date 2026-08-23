import { QueryClientProvider } from "@tanstack/react-query";
import { HeadContent, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { StavkaShell } from "../components/shell";
import { AccountGate } from "../components/account-gate";
import type { RouterContext } from "../router";
import appCss from "../styles.css?url";

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Stavka" },
      {
        name: "description",
        content: "Unified Stavka operations dashboard",
      },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: Root,
});

const Document = ({ children }: { readonly children: ReactNode }) => (
  <html lang="en" data-mode="light">
    <head>
      <HeadContent />
    </head>
    <body>
      {children}
      <Scripts />
    </body>
  </html>
);

function Root() {
  const { queryClient } = Route.useRouteContext();
  return (
    <Document>
      <QueryClientProvider client={queryClient}>
        <AccountGate>
          <StavkaShell />
        </AccountGate>
      </QueryClientProvider>
    </Document>
  );
}
