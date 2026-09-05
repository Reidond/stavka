import { Loader } from "@cloudflare/kumo/components/loader";
import { Button } from "@cloudflare/kumo/components/button";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { ArrowClockwise } from "@phosphor-icons/react";

export function Loading({ label = "Loading" }: { readonly label?: string }) {
  return (
    <div className="flex items-center gap-2 p-4 text-sm text-kumo-subtle" role="status">
      <Loader aria-label={label} />
      {label}…
    </div>
  );
}
export function CheckedAt({ timestamp }: { readonly timestamp: number }) {
  return timestamp > 0 ? (
    <time
      className="text-xs text-kumo-subtle"
      dateTime={new Date(timestamp).toISOString()}
      title={new Date(timestamp).toLocaleString()}
    >
      Checked at{" "}
      {new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
    </time>
  ) : null;
}
export function Refresh({
  onClick,
  loading,
}: {
  readonly onClick: () => void;
  readonly loading: boolean;
}) {
  return (
    <Tooltip content="Refresh">
      <Button
        variant="ghost"
        shape="square"
        aria-label="Refresh"
        loading={loading}
        onClick={onClick}
        icon={<ArrowClockwise size={18} />}
      />
    </Tooltip>
  );
}
export const titleCase = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");
