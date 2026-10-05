import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { createTools } from "./tools.js";

/**
 * The MCP server itself: the tool list and the call handler. Transport-free,
 * so index.js connects it to stdio and tests to an in-memory client.
 */
export function createServer({ jobs, config, readUsage, history }) {
  const { tools, call } = createTools({ jobs, config, readUsage, history });
  const server = new Server({ name: "pixmith", version: config.version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    call(request.params.name, request.params.arguments || {}, request, extra),
  );
  return server;
}
