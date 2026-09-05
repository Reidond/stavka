import { WorkerEntrypoint } from "cloudflare:workers";
import type { GatewayEnv } from "./config";
import { handleCommanderRequest } from "./router";

/** Only Commander has a service binding to this entrypoint. The default fetch
 * retains human Access authorization and never dispatches to this handler. */
export class CommanderInference extends WorkerEntrypoint<GatewayEnv> {
  override fetch(request: Request): Promise<Response> {
    return handleCommanderRequest(request, this.env);
  }
}
