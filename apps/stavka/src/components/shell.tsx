import type { ActiveAccountSession } from "@stavka/access-auth";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import {
  SquaresFour,
  Crosshair,
  ListChecks,
  PlayCircle,
  Cpu,
  ChartBar,
  Plugs,
  Users,
  Pulse,
  List,
  X,
  SignOut,
  ShieldCheck,
} from "@phosphor-icons/react";
import { readAccountSession } from "../account-api";
import { accountSessionQueryKey } from "./account-gate";

const sections = [
  { to: "/", label: "Overview", icon: SquaresFour, group: "Workspace" },
  { to: "/simulations", label: "Simulations", icon: Crosshair, group: "Workspace" },
  { to: "/decisions", label: "Decisions", icon: ListChecks, group: "Workspace" },
  { to: "/replays", label: "Replays", icon: PlayCircle, group: "Workspace" },
  { to: "/usage", label: "Usage", icon: ChartBar, group: "Operations" },
  { to: "/models", label: "Models", icon: Cpu, group: "Operations" },
  { to: "/settings/providers", label: "Providers", icon: Plugs, group: "Operations" },
  { to: "/settings/access", label: "Access", icon: Users, group: "Operations" },
  { to: "/system", label: "System", icon: Pulse, group: "Operations" },
] as const;

export function StavkaShell() {
  const localDevelopment = import.meta.env.MODE === "local-account";
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const current = sections.find((item) => item.to === pathname)?.label ?? "Session detail";
  const session = useQuery({
    queryKey: accountSessionQueryKey,
    queryFn: readAccountSession,
    staleTime: 30_000,
  });
  const sessionData = session.data;
  const active: ActiveAccountSession | undefined =
    sessionData?.status === "active" ? sessionData : undefined;
  return (
    <div className="stavka-shell">
      {menuOpen ? (
        <button
          className="stavka-nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setMenuOpen(false)}
        />
      ) : null}
      <aside className="stavka-sidebar" data-open={menuOpen}>
        <Link to="/" className="stavka-brand" onClick={() => setMenuOpen(false)}>
          <span className="stavka-brand-mark">
            <Crosshair size={22} weight="bold" />
          </span>
          <span>
            STAVKA<small>COMMAND WORKSPACE</small>
          </span>
        </Link>
        <div className="stavka-workspace-label">
          <span className="stavka-status-dot" />
          {active?.organization.name ?? "Workspace"}
        </div>
        <nav aria-label="Primary" className="stavka-navigation">
          {["Workspace", "Operations"].map((group) => (
            <div key={group} className="stavka-nav-group">
              <p>{group}</p>
              {sections
                .filter((item) => item.group === group)
                .map(({ to, label, icon: Icon }) => (
                  <Link
                    key={to}
                    to={to}
                    className="stavka-nav-link"
                    activeProps={{ className: "stavka-nav-link is-active" }}
                    activeOptions={{ exact: to === "/" }}
                    onClick={() => setMenuOpen(false)}
                  >
                    <Icon size={19} />
                    <span>{label}</span>
                  </Link>
                ))}
            </div>
          ))}
        </nav>
        <div className="stavka-sidebar-footer">
          <ShieldCheck size={17} />
          <span>
            {localDevelopment
              ? "Local development · loopback only"
              : "Protected by Cloudflare Access"}
          </span>
        </div>
        <div className="stavka-profile">
          <span className="stavka-avatar">
            {(active?.user.displayName ?? "U").slice(0, 1).toUpperCase()}
          </span>
          <div>
            <strong>{active?.user.displayName ?? "Signed-in user"}</strong>
            <small>{active?.membership.role ?? "Checking access"}</small>
          </div>
          {localDevelopment ? null : (
            <a href="/cdn-cgi/access/logout" aria-label="Sign out" title="Sign out">
              <SignOut size={18} />
            </a>
          )}
        </div>
      </aside>
      <div className="stavka-workspace">
        <header className="stavka-header">
          <Button
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            className="stavka-menu-button"
            size="sm"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {menuOpen ? <X size={18} /> : <List size={18} />}
          </Button>
          <div className="stavka-breadcrumb">
            <span>Workspace</span>
            <span>/</span>
            <strong>{current}</strong>
          </div>
          <span className="stavka-header-account">
            <ShieldCheck size={15} />
            {active?.organization.name ?? "Stavka"}
          </span>
        </header>
        <main className="stavka-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
