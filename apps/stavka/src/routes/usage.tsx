import { createFileRoute } from "@tanstack/react-router";
import { SessionInspector } from "../components/operations";
export const Route = createFileRoute("/usage")({
  component: () => <SessionInspector title="Usage" usageOnly />,
});
