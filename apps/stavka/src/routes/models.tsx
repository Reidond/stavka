import { createFileRoute } from "@tanstack/react-router";
import { Models } from "../components/operations";
export const Route = createFileRoute("/models")({ component: Models });
