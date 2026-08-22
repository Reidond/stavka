import { createFileRoute } from "@tanstack/react-router";

import { PlaceholderSection } from "../components/shell";

export const Route = createFileRoute("/sessions/$sessionId")({
  component: () => {
    const { sessionId } = Route.useParams();
    return (
      <PlaceholderSection
        title={`Session ${sessionId}`}
        description="Map, objectives, groups, orders, and the live timeline for this session will appear here."
      />
    );
  },
});
