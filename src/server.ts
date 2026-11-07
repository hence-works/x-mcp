import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { secretValues, type ServerConfig } from './config.js';
import { MediaReader } from './media.js';
import { allTools } from './tools/index.js';
import type { ToolDefinition, ToolSuccess } from './tools/framework.js';
import { XClient, type XClientDeps } from './x/client.js';
import { XApiError } from './x/errors.js';

export const SERVER_NAME = 'x-mcp';
export const SERVER_VERSION = '0.1.0';

export type Logger = (message: string) => void;

export interface ServerDeps {
  config: ServerConfig;
  /** Shared across server instances so the cached authenticated-user id survives era probing. */
  client?: XClient;
  clientDeps?: XClientDeps;
  tools?: readonly ToolDefinition[];
  /** Diagnostics sink. Defaults to stderr; stdout is reserved for JSON-RPC. */
  log?: Logger;
}

/** Scrubs configured secrets and credential-looking substrings from text. */
export function createRedactor(config: ServerConfig): (text: string) => string {
  const secrets = secretValues(config.credentials).sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const secret of secrets) out = out.split(secret).join('[REDACTED]');
    return out
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=%-]{8,}/gi, '$1[REDACTED]')
      .replace(/(oauth_[a-z_]+=")[^"]*"/gi, '$1[REDACTED]"');
  };
}

export function successResult(payload: ToolSuccess): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

export interface ToolErrorPayload {
  error: {
    type: string;
    message: string;
    status?: number;
    title?: string;
    detail?: string;
    x_type?: string;
    x_errors?: unknown[];
    rate_limit?: unknown;
    retry_after_seconds?: number;
  };
}

/** Tool failure reported at the MCP result level (`isError: true`), never as a protocol error. */
export function errorResult(error: unknown, redact: (text: string) => string): CallToolResult {
  let payload: ToolErrorPayload;
  if (error instanceof XApiError) {
    const d = error.details;
    payload = {
      error: {
        type: error.kind,
        message: error.message,
        status: d.status,
        title: d.title,
        detail: d.detail,
        x_type: d.type,
        x_errors: d.errors,
        rate_limit: d.rateLimit,
        retry_after_seconds: d.retryAfterSeconds,
      },
    };
  } else {
    payload = { error: { type: 'internal_error', message: 'The tool failed unexpectedly; see server diagnostics.' } };
  }
  const text = redact(JSON.stringify(payload));
  return {
    isError: true,
    content: [{ type: 'text', text }],
    structuredContent: JSON.parse(text) as Record<string, unknown>,
  };
}

const stderrLogger: Logger = (message) => {
  process.stderr.write(`[x-mcp] ${message}\n`);
};

/**
 * Builds a fresh MCP server instance with every tool registered. `serveStdio` may call this more
 * than once per connection (e.g. for a discarded `server/discover` probe), so it holds no
 * connection state beyond the shared X client.
 */
export function createServer(deps: ServerDeps): McpServer {
  const { config } = deps;
  const client = deps.client ?? new XClient(config, deps.clientDeps);
  const media = new MediaReader(config);
  const redact = createRedactor(config);
  const log = deps.log ?? stderrLogger;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

  for (const tool of deps.tools ?? allTools()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { title: tool.title, ...tool.annotations },
      },
      async (args, ctx) => {
        const started = Date.now();
        try {
          const payload = await tool.run(args as Record<string, unknown>, {
            client,
            config,
            media,
            signal: ctx.mcpReq.signal,
          });
          log(`${tool.name} ok in ${Date.now() - started}ms`);
          return successResult(payload);
        } catch (error) {
          // Arguments are never logged: they may contain message text or media bytes.
          const summary =
            error instanceof XApiError
              ? `${error.kind}${error.details.status ? ` ${error.details.status}` : ''}`
              : error instanceof Error
                ? `${error.name}: ${error.message}`
                : 'unknown error';
          log(redact(`${tool.name} failed in ${Date.now() - started}ms: ${summary}`));
          return errorResult(error, redact);
        }
      },
    );
  }
  return server;
}
