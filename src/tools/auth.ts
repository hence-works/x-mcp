import { z } from 'zod';
import { TOOL_OAUTH2_SCOPES } from '../auth/tool-scopes.js';
import { XApiError } from '../x/errors.js';
import { customTool, type ToolContext, type ToolDefinition } from './framework.js';

const scope = 'auth' as const;

function manager(ctx: ToolContext) {
  if (!ctx.accounts) throw new XApiError('auth_not_configured', 'Account management is unavailable in this server instance.');
  return ctx.accounts;
}

const toolName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{2,80}$/)
  .refine((n) => n in TOOL_OAUTH2_SCOPES, 'not a tool that can use an OAuth 2.0 user token');

/**
 * Account tools. None of them accepts or returns tokens, codes or secrets, and none lets the
 * caller pick which stored account is used.
 */
export const authTools: ToolDefinition[] = [
  customTool({
    name: 'X_AUTH_STATUS',
    title: 'Show X account connection status',
    description:
      'Lists connected X accounts (user id, username, granted scopes, token expiry, whether it can refresh) and which one is active. Never returns tokens.',
    scope,
    composio: false,
    operationIds: [],
    auth: [],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    input: {},
    async run(_args, ctx) {
      const accounts = manager(ctx);
      const creds = ctx.config.credentials;
      return {
        data: {
          oauth_configured: accounts.configured,
          persistent_storage: accounts.store.persistent,
          redirect_uri: ctx.config.oauth?.redirectUri ?? null,
          pinned_account_id: ctx.config.accountId ?? null,
          pending_authorizations: accounts.pendingCount(),
          accounts: await accounts.listAccounts(),
          environment_credentials: {
            oauth2_user_token: Boolean(creds.oauth2UserToken),
            oauth1_user: Boolean(creds.oauth1),
            app_bearer_token: Boolean(creds.bearerToken),
          },
        },
      };
    },
  }),
  customTool({
    name: 'X_AUTH_CONNECT',
    title: 'Connect an X account (OAuth 2.0 with PKCE)',
    description:
      'Starts browser authorization of an X account and returns the URL for the user to open. Scopes are derived from the tools named in `tools` (all OAuth 2.0-capable tools when omitted). The local callback completes the connection; check X_AUTH_STATUS afterwards. The request expires after X_OAUTH2_CALLBACK_TIMEOUT_MS.',
    scope,
    composio: false,
    operationIds: [],
    auth: [],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    input: {
      tools: z.array(toolName).min(1).max(100).optional().describe('Tools the account will be used with; only their scopes are requested.'),
      persistent: z
        .boolean()
        .optional()
        .describe('Request offline.access and store the grant encrypted (requires X_MCP_TOKEN_KEY). Defaults to true when storage is configured.'),
    },
    async run(args, ctx) {
      const accounts = manager(ctx);
      if (!ctx.callback) throw new XApiError('auth_not_configured', 'The OAuth callback listener is unavailable.');
      const request = accounts.startAuthorization({ tools: args.tools, persistent: args.persistent });
      await ctx.callback.ensureListening(ctx.config.oauth!.callbackTimeoutMs);
      return { data: { ...request, next_step: 'Open authorization_url in a browser signed in to the X account, approve, then call X_AUTH_STATUS.' } };
    },
  }),
  customTool({
    name: 'X_AUTH_DISCONNECT',
    title: 'Disconnect the active X account',
    description:
      'Revokes the active account\'s refresh and access tokens with X and deletes them locally. Only the active account can be disconnected from MCP; use the `x-mcp auth logout` CLI for others.',
    scope,
    composio: false,
    operationIds: [],
    auth: [],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    input: {},
    async run(_args, ctx) {
      const result = await manager(ctx).disconnectActive();
      if (!result) throw new XApiError('invalid_input', 'No X account is connected.');
      return { data: { disconnected: true, ...result } };
    },
  }),
];
