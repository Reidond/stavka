import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  ToolSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { Effect, ManagedRuntime, Schema } from "effect";
import { EnfusionBackend } from "./enfusion-backend";
import {
  DocsInput,
  EmptyInput,
  EnfusionError,
  JobInput,
  RunInput,
  toolContracts,
} from "./enfusion-contract";
import { EnfusionJobs } from "./enfusion-jobs";

export type EnfusionServices = EnfusionBackend | EnfusionJobs;
const decode = <S extends Schema.Constraint>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError(
      (error) => new EnfusionError({ code: "INVALID_ARGUMENT", message: error.message }),
    ),
  );

export const callEnfusionTool = (
  name: string,
  input: unknown,
): Effect.Effect<Record<string, unknown>, EnfusionError, EnfusionServices> =>
  Effect.gen(function* () {
    const backend = yield* EnfusionBackend;
    const jobs = yield* EnfusionJobs;
    switch (name) {
      case "enfusion_doctor":
        yield* decode(EmptyInput, input);
        return yield* backend.doctor;
      case "enfusion_docs": {
        const request = yield* decode(DocsInput, input);
        return yield* backend.docs(request.query);
      }
      case "enfusion_start":
        return yield* jobs.start(yield* decode(RunInput, input));
      case "enfusion_job":
        return yield* jobs.get((yield* decode(JobInput, input)).runId);
      case "enfusion_cancel":
        return yield* jobs.cancel((yield* decode(JobInput, input)).runId);
      case "enfusion_inspect":
        return yield* backend.inspect((yield* decode(JobInput, input)).runId);
      default:
        return yield* Effect.fail(
          new EnfusionError({
            code: "INVALID_ARGUMENT",
            message: `Unknown Enfusion tool: ${name}`,
          }),
        );
    }
  });

export const advertisedTools = toolContracts.map((tool) => {
  const document = Schema.toJsonSchemaDocument(tool.input);
  return ToolSchema.parse({
    name: tool.name,
    description: tool.description,
    inputSchema: { ...document.schema, $defs: document.definitions },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: {
      readOnlyHint: tool.readOnly,
      destructiveHint: false,
      idempotentHint: tool.readOnly,
      openWorldHint: false,
    },
  });
});

/** The Promise interface is confined to this SDK adapter. */
export const createEnfusionServer = (
  runtime: ManagedRuntime.ManagedRuntime<EnfusionServices, never>,
) => {
  const server = new Server(
    { name: "enfusion-workbench", version: "0.1.0" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        "Controls isolated local Workbench jobs for the configured project. Start native work with enfusion_start, then poll enfusion_job. Do not start duplicate jobs while one runs. Live editor attachment, arbitrary scripts, deployment and Workshop publishing are not exposed.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: advertisedTools }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    runtime.runPromise(
      callEnfusionTool(request.params.name, request.params.arguments ?? {}).pipe(
        Effect.match({
          onFailure: (error): CallToolResult => ({
            isError: true,
            content: [{ type: "text", text: error.message }],
            structuredContent: { error: { code: error.code, message: error.message } },
          }),
          onSuccess: (result): CallToolResult => ({
            isError:
              result.artifactIntegrity === "failed" ||
              (typeof result.result === "object" &&
                result.result !== null &&
                "artifactIntegrity" in result.result &&
                result.result.artifactIntegrity === "failed"),
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          }),
        }),
      ),
      { signal: extra.signal },
    ),
  );
  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [
      {
        uri: "enfusion://capabilities",
        name: "Enfusion Workbench capabilities",
        mimeType: "application/json",
      },
    ],
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
    resourceTemplates: [
      {
        uriTemplate: "enfusion://runs/{runId}",
        name: "Native run evidence",
        mimeType: "application/json",
      },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, (request, extra) => {
    const uri = request.params.uri;
    if (uri === "enfusion://capabilities")
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(advertisedTools) }],
      };
    const match = /^enfusion:\/\/runs\/([\da-f-]+)$/iu.exec(uri);
    if (!match) throw new McpError(ErrorCode.InvalidParams, "Unsupported Enfusion resource URI");
    return runtime.runPromise(
      callEnfusionTool("enfusion_job", { runId: match[1] }).pipe(
        Effect.map((result) => ({
          contents: [{ uri, mimeType: "application/json", text: JSON.stringify(result) }],
        })),
      ),
      { signal: extra.signal },
    );
  });
  return server;
};
