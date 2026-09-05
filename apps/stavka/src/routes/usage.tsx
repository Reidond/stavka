import { createFileRoute } from "@tanstack/react-router";
import { SessionInspector } from "../components/sessions";
export const Route = createFileRoute("/usage")({
  component: () => <SessionInspector initialView="usage" />,
});
