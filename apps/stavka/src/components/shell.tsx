import type { ActiveAccountSession } from "@stavka/access-auth";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Sidebar, useSidebar } from "@cloudflare/kumo/components/sidebar";
import { Breadcrumbs } from "@cloudflare/kumo/components/breadcrumbs";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import {
  SquaresFour,
  Crosshair,
  ListChecks,
  Cpu,
  Plugs,
  Users,
  Pulse,
  SignOut,
} from "@phosphor-icons/react";
import { readAccountSession } from "../account-api";
import { accountSessionQueryKey } from "./account-gate";

const sections = [
  { to: "/", label: "Home", icon: SquaresFour, group: "" },
  { to: "/simulations", label: "Simulations", icon: Crosshair, group: "Run" },
  { to: "/sessions", label: "Sessions", icon: ListChecks, group: "Review" },
  { to: "/models", label: "Models", icon: Cpu, group: "Configure" },
  { to: "/settings/providers", label: "Providers", icon: Plugs, group: "Configure" },
  { to: "/settings/access", label: "Access", icon: Users, group: "Configure" },
  { to: "/system", label: "Health", icon: Pulse, group: "Configure" },
] as const;
const ActionsContext = createContext<HTMLElement | null>(null);
export function PageActions({ children }: { readonly children: ReactNode }) {
  const target = useContext(ActionsContext);
  return target ? createPortal(children, target) : null;
}
export function StavkaShell() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1200px)");
    const update = () => setOpen(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return (
    <Sidebar.Provider
      open={open}
      onOpenChange={setOpen}
      mobileBreakpoint={900}
      className="stavka-shell min-h-0"
      style={{ "--sidebar-width": "240px", "--sidebar-width-icon": "56px" } as CSSProperties}
    >
      <ShellContents />
    </Sidebar.Provider>
  );
}
function ShellContents() {
  const { isMobile, state, setOpenMobile } = useSidebar();
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (router) => router.location.pathname });
  const sessionPage =
    pathname.startsWith("/sessions") || ["/decisions", "/usage", "/replays"].includes(pathname);
  const current = sessionPage
    ? "Sessions"
    : (sections.find((item) => item.to === pathname)?.label ?? "Home");
  const nested = /^\/sessions\/[^/]+/.test(pathname);
  const session = useQuery({
    queryKey: accountSessionQueryKey,
    queryFn: readAccountSession,
    staleTime: 30_000,
  });
  const sessionData = session.data;
  const active: ActiveAccountSession | undefined =
    sessionData?.status === "active" ? sessionData : undefined;
  const expanded = isMobile || state !== "collapsed";
  return (
    <>
      <Sidebar aria-label="Primary navigation">
        <Sidebar.Header className="h-[52px] min-h-[52px]">
          <Sidebar.Menu>
            <Sidebar.MenuButton
              href="/"
              icon={<Crosshair size={22} className="shrink-0" aria-hidden="true" />}
              tooltip="Stavka home"
              onClick={(event) => {
                if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                  event.preventDefault();
                  void navigate({ to: "/" });
                  if (isMobile) setOpenMobile(false);
                }
              }}
            >
              Stavka
            </Sidebar.MenuButton>
          </Sidebar.Menu>
        </Sidebar.Header>
        <Sidebar.Content>
          <nav aria-label="Primary">
            {["", "Run", "Review", "Configure"].map((group) => (
              <Sidebar.Group key={group}>
                {group ? (
                  <Sidebar.GroupLabel className="text-xs">{group}</Sidebar.GroupLabel>
                ) : null}
                <Sidebar.Menu>
                  {sections
                    .filter((item) => item.group === group)
                    .map(({ to, label, icon: Icon }) => (
                      <Sidebar.MenuButton
                        key={to}
                        href={to}
                        icon={<Icon size={20} className="shrink-0" aria-hidden="true" />}
                        tooltip={label}
                        active={label === current}
                        aria-current={label === current ? "page" : undefined}
                        onClick={(event) => {
                          if (
                            !event.metaKey &&
                            !event.ctrlKey &&
                            !event.shiftKey &&
                            !event.altKey
                          ) {
                            event.preventDefault();
                            void navigate({ to });
                            if (isMobile) setOpenMobile(false);
                          }
                        }}
                      >
                        {label}
                      </Sidebar.MenuButton>
                    ))}
                </Sidebar.Menu>
              </Sidebar.Group>
            ))}
          </nav>
        </Sidebar.Content>
        <Sidebar.Footer>
          <div className="stavka-profile">
            <Tooltip
              content={`${active?.user.displayName ?? "User"} · ${active?.membership.role ?? "Member"}`}
            >
              <span className="stavka-avatar" tabIndex={expanded ? -1 : 0}>
                {(active?.user.displayName ?? "U").slice(0, 1).toUpperCase()}
              </span>
            </Tooltip>
            {expanded ? (
              <>
                <div>
                  <strong>{active?.user.displayName ?? "Signed-in user"}</strong>
                  <small>{active?.membership.role ?? "Member"}</small>
                </div>
                <Tooltip content="Sign out">
                  <a href="/cdn-cgi/access/logout" aria-label="Sign out">
                    <SignOut size={18} />
                  </a>
                </Tooltip>
              </>
            ) : null}
          </div>
        </Sidebar.Footer>
      </Sidebar>
      <div className="stavka-workspace">
        <header className="stavka-header">
          <Sidebar.Trigger aria-label="Toggle navigation" />
          {nested ? (
            <Breadcrumbs size="sm">
              <Breadcrumbs.Link href="/sessions">Sessions</Breadcrumbs.Link>
              <Breadcrumbs.Separator />
              <Breadcrumbs.Current>
                <h1>Session</h1>
              </Breadcrumbs.Current>
            </Breadcrumbs>
          ) : (
            <h1>{current}</h1>
          )}
          <div className="stavka-header-actions" ref={setActions} />
        </header>
        <ActionsContext.Provider value={actions}>
          <main className="stavka-main">
            <Outlet />
          </main>
        </ActionsContext.Provider>
      </div>
    </>
  );
}
