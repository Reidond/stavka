import { createFileRoute } from "@tanstack/react-router";
import { SessionInspector } from "../components/sessions";
export const Route = createFileRoute("/sessions/")({ component: () => <SessionInspector /> });
