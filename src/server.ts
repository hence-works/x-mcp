import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import type { CallbackListener } from './auth/callback.js';
import type { AccountManager } from './auth/manager.js';
import { TOOL_OAUTH2_SCOPES } from './auth/tool-scopes.js';
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
  /** OAuth 2.0 connected accounts (shared across server instances, like the client). */
  accounts?: AccountManager;
  callback?: CallbackListener;
  /** Diagnostics sink. Defaults to stderr; stdout is reserved for JSON-RPC. */
  log?: Logger;
}

/** Configured values shorter than this are not literal-matched: they would corrupt ordinary text. */
const MIN_REDACTABLE_SECRET = 8;

/** Scrubs configured secrets and credential-looking substrings from a string. */
export function createRedactor(config: ServerConfig): (text: string) => string {
  const secrets = secretValues(config.credentials, config.oauth)
    .filter((s) => s.length >= MIN_REDACTABLE_SECRET)
    .sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const secret of secrets) out = out.split(secret).join('[REDACTED]');
    return out
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=%-]{8,}/gi, '$1[REDACTED]')
      .replace(/(oauth_[a-z_]+=")[^"]*"/gi, '$1[REDACTED]"');
  };
}

/** Applies `redact` to every string value (never to keys), preserving structure. */
export function redactDeep<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact)) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, redact)])) as T;
  }
  return value;
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
  const structured = redactDeep(JSON.parse(JSON.stringify(payload)) as Record<string, unknown>, redact);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
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
/**
 * Checks that apply when a call will use a connected account's OAuth 2.0 token: the account must
 * hold the tool's scopes, and an acting-user argument must be that account's own id.
 */
export async function checkConnectedAccount(tool: ToolDefinition, args: Record<string, unknown>, client: XClient): Promise<void> {
  const required = TOOL_OAUTH2_SCOPES[tool.name];
  if (!required || tool.scope === 'auth') return;
  const account = await client.managedCredential(tool.auth);
  if (!account) return;
  const missing = required.filter((s) => !account.scopes.includes(s));
  if (missing.length > 0) {
    throw new XApiError('missing_scopes', `The connected account was not granted ${missing.join(', ')}; reconnect with X_AUTH_CONNECT including this tool.`, {
      detail: missing.join(' '),
    });
  }
  const param = tool.actingUserParam;
  const value = param ? args[param] : undefined;
  if (typeof value === 'string' && value !== 'me' && value !== account.userId) {
    throw new XApiError('invalid_input', `${param} must be the connected account's own user id (${account.userId}) or omitted.`);
  }
}

export function createServer(deps: ServerDeps): McpServer {
  const { config } = deps;
  const client = deps.client ?? new XClient(config, { ...deps.clientDeps, accounts: deps.clientDeps?.accounts ?? deps.accounts });
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
          await checkConnectedAccount(tool, args as Record<string, unknown>, client);
          const payload = await tool.run(args as Record<string, unknown>, {
            client,
            config,
            media,
            signal: ctx.mcpReq.signal,
            accounts: deps.accounts,
            callback: deps.callback,
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
