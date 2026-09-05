import { createFileRoute } from "@tanstack/react-router";
import { Health } from "../components/operations";
export const Route = createFileRoute("/system")({ component: Health });
