import type { GatewayEnv } from "./config";
import { handleRequest } from "./router";

export { MaskirovkaGateway } from "./gateway-container";

export default {
  fetch(request: Request, env: GatewayEnv): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<GatewayEnv>;
