import { CallbackListener } from './auth/callback.js';
import { createAccountManager } from './auth/index.js';
import { ConfigError, loadConfig } from './config.js';
import { XApiError } from './x/errors.js';

const USAGE = `Usage:
  x-mcp auth login [--tools TOOL_A,TOOL_B] [--session]
      Authorize an X account in the browser (OAuth 2.0 with PKCE). Requests only the scopes the
      named tools need (all OAuth 2.0-capable tools by default). --session skips offline.access and
      keeps the grant in memory only, which is useless for a separate CLI process.
  x-mcp auth status
  x-mcp auth logout [--account USER_ID]
      Revoke and delete a connected account (the active one by default).
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Terminal account management. Never prints tokens, codes or secrets. Returns the exit code. */
export async function runCli(args: string[], out: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Promise<number> {
  const [command, ...rest] = args;
  try {
    const config = loadConfig();
    const accounts = createAccountManager(config);
    switch (command) {
      case 'status': {
        const list = await accounts.listAccounts();
        out(`OAuth client configured: ${accounts.configured ? 'yes' : 'no (set X_OAUTH2_CLIENT_ID)'}`);
        out(`Encrypted storage: ${accounts.store.persistent ? config.tokenStore.dir : 'disabled (set X_MCP_TOKEN_KEY)'}`);
        if (list.length === 0) out('No connected accounts.');
        for (const a of list) {
          out(`${a.active ? '*' : ' '} ${a.user_id} @${a.username} expires ${a.expires_at}${a.refreshable ? ' (refreshable)' : ''}`);
          out(`    scopes: ${a.scopes.join(' ')}`);
        }
        return 0;
      }
      case 'login': {
        if (!config.oauth) throw new ConfigError('Set X_OAUTH2_CLIENT_ID (and X_OAUTH2_REDIRECT_URI) first.');
        const tools = flag(rest, '--tools')?.split(',').filter(Boolean);
        const persistent = !rest.includes('--session');
        const listener = new CallbackListener(accounts, config.oauth.redirectUri, (m) => process.stderr.write(`[x-mcp] ${m}\n`));
        const request = accounts.startAuthorization({ tools, persistent });
        const done = new Promise<number>((resolve) => {
          listener.onCompletion(({ account, error }) => {
            if (account) out(`Connected ${account.user_id} @${account.username} with scopes: ${account.scopes.join(' ')}`);
            else out(`Authorization failed: ${error?.message ?? 'unknown error'}`);
            resolve(account ? 0 : 1);
          });
          setTimeout(() => {
            out('Authorization timed out.');
            resolve(1);
          }, config.oauth!.callbackTimeoutMs).unref();
        });
        await listener.ensureListening(config.oauth.callbackTimeoutMs);
        out('Open this URL in a browser signed in to the X account to connect:');
        out(request.authorization_url);
        out(`Waiting for the callback on ${request.redirect_uri} until ${request.expires_at} ...`);
        const code = await done;
        await listener.close();
        return code;
      }
      case 'logout': {
        const id = flag(rest, '--account') ?? (await accounts.activeAccountId());
        if (!id) {
          out('No connected account.');
          return 1;
        }
        if (!/^\d{1,19}$/.test(id)) throw new ConfigError('--account must be a numeric X user id');
        const result = await accounts.disconnect(id);
        out(`Disconnected ${result.user_id} (refresh token revoked: ${result.revoked.refresh_token}, access token revoked: ${result.revoked.access_token}).`);
        return 0;
      }
      default:
        out(USAGE);
        return command === undefined || command === 'help' || command === '--help' ? 0 : 2;
    }
  } catch (error) {
    const message = error instanceof ConfigError || error instanceof XApiError ? error.message : 'unexpected error';
    process.stderr.write(`[x-mcp] auth ${command ?? ''} failed: ${message}\n`);
    return 1;
  }
}
