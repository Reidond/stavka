import type { SeatEnv } from "./config";
import { handleRequest } from "./router";

export { MaskirovkaSeat } from "./seat-container";

export default {
  fetch(request: Request, env: SeatEnv): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<SeatEnv>;
