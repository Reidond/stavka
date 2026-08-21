import { createFileRoute } from "@tanstack/react-router";

import { ReplayPage } from "../components/replay-page";

export const Route = createFileRoute("/replays")({
  component: ReplayRoute,
});

function ReplayRoute() {
  const navigate = Route.useNavigate();
  return <ReplayPage onReturn={() => void navigate({ to: "/simulations" })} />;
}
