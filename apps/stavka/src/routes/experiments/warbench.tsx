import { createFileRoute } from "@tanstack/react-router";

import { PlaceholderSection } from "../../components/shell";

export const Route = createFileRoute("/experiments/warbench")({
  component: () => (
    <PlaceholderSection
      title="Warbench"
      description="The independent rule-versus-model benchmark with immutable study evidence will run here."
    />
  ),
});
