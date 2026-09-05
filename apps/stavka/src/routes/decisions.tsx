import { createFileRoute } from "@tanstack/react-router";
import { SessionInspector } from "../components/operations";
export const Route = createFileRoute("/decisions")({
  component: () => <SessionInspector title="Decisions" />,
});
