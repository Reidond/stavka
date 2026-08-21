import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Link, Outlet } from "@tanstack/react-router";
import type { ReactNode } from "react";

const sections = [
  { to: "/", label: "Overview" },
  { to: "/simulations", label: "Simulations" },
  { to: "/decisions", label: "Decisions" },
  { to: "/replays", label: "Replays" },
  { to: "/experiments/warbench", label: "Warbench" },
  { to: "/models", label: "Models" },
  { to: "/usage", label: "Usage" },
  { to: "/settings/providers", label: "Settings" },
  { to: "/system", label: "System" },
] as const;

const navLinkClass =
  "rounded-md px-2 py-1 text-sm text-kumo-subtle hover:bg-kumo-hover hover:text-kumo-strong";

const activeLinkClass = "bg-kumo-active font-medium text-kumo-strong";

export const StavkaShell = () => (
  <div className="stavka-shell">
    <header className="stavka-header">
      <Link to="/" className="text-sm font-semibold tracking-wider text-kumo-strong uppercase">
        Stavka
      </Link>
      <nav aria-label="Primary">
        {sections.map((section) => (
          <Link
            key={section.to}
            to={section.to}
            className={navLinkClass}
            activeProps={{ className: `${navLinkClass} ${activeLinkClass}` }}
          >
            {section.label}
          </Link>
        ))}
      </nav>
    </header>
    <main className="stavka-main">
      <Outlet />
    </main>
  </div>
);

interface PlaceholderSectionProps {
  readonly title: string;
  readonly description: string;
  readonly children?: ReactNode;
}

/**
 * Route placeholder for sections of the unified dashboard that are not yet
 * implemented. Each keeps a bounded, scrollable content pane.
 */
export const PlaceholderSection = ({ title, description, children }: PlaceholderSectionProps) => (
  <div className="stavka-pane space-y-4">
    <h1 className="m-0 text-xl font-semibold text-kumo-strong">{title}</h1>
    <LayerCard className="p-4">
      <p className="m-0 text-sm text-kumo-default">{description}</p>
      {children}
    </LayerCard>
  </div>
);
