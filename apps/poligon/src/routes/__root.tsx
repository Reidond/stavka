import { QueryClientProvider } from "@tanstack/react-query";
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { RouterContext } from "../router";
import appCss from "../styles.css?url";

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Poligon · Stavka proving ground" },
      { name: "description", content: "Deterministic proving ground for the Stavka AI commander" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: Root,
});

const Document = ({ children }: { readonly children: ReactNode }) => (
  <html lang="en">
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
        <Outlet />
      </QueryClientProvider>
    </Document>
  );
}
