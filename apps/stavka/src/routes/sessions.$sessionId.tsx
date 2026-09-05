import { createFileRoute } from "@tanstack/react-router";
import { Effect, Schema } from "effect";
import { SessionInspector } from "../components/operations";
export const Route = createFileRoute("/sessions/$sessionId")({
  validateSearch: Schema.toStandardSchemaV1(
    Schema.Struct({
      faction: Schema.String.check(Schema.isNonEmpty()).pipe(
        Schema.withDecodingDefaultType(Effect.succeed("OPFOR")),
      ),
    }),
  ),
  component: SessionPage,
});
function SessionPage() {
  const { sessionId } = Route.useParams();
  const { faction } = Route.useSearch();
  return (
    <SessionInspector
      key={`${sessionId}:${faction}`}
      initialSessionId={sessionId}
      initialFaction={faction}
    />
  );
}
