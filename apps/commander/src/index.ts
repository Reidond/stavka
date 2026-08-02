import type { Env } from "./config";
import { handleRequest } from "./api/router";

export { OrchestratorAgent } from "./durable/orchestrator";
export { SergeantAgent } from "./durable/sergeant";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
