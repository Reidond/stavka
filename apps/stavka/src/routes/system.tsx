import { createFileRoute } from "@tanstack/react-router";
import { SystemStatus } from "../components/operations";
export const Route = createFileRoute("/system")({ component: () => <SystemStatus /> });
