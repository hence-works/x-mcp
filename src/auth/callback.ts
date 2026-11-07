import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { XApiError } from '../x/errors.js';
import type { AccountManager, AccountSummary } from './manager.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  res.end(`<!doctype html><meta charset="utf-8"><title>x-mcp</title><p>${escapeHtml(message)}</p>`);
}

export type CompletionListener = (result: { account?: AccountSummary; error?: XApiError }) => void;

/**
 * Local redirect listener for loopback redirect URIs (the stdio use case). It only answers GET on
 * the exact registered path, never echoes the code, and shuts down once no authorization is pending.
 */
export class CallbackListener {
  private server?: Server;
  private starting?: Promise<void>;
  private expiryTimer?: NodeJS.Timeout;
  private readonly completion = new Set<CompletionListener>();
  private readonly redirect: URL;

  constructor(
    private readonly manager: AccountManager,
    redirectUri: string,
    private readonly log: (message: string) => void,
  ) {
    this.redirect = new URL(redirectUri);
    manager.onPendingChange(() => {
      if (this.server && manager.pendingCount() === 0) void this.close();
    });
  }

  get loopback(): boolean {
    return this.redirect.protocol === 'http:' && LOOPBACK.has(this.redirect.hostname);
  }

  onCompletion(listener: CompletionListener): () => void {
    this.completion.add(listener);
    return () => this.completion.delete(listener);
  }

  /** Starts listening (idempotent) and re-arms the expiry timer for the newest request. */
  async ensureListening(lifetimeMs: number): Promise<void> {
    if (!this.loopback) {
      throw new XApiError(
        'invalid_input',
        'X_OAUTH2_REDIRECT_URI is not a loopback http URI, so this process cannot receive the callback; use a loopback redirect such as http://127.0.0.1:8723/callback.',
      );
    }
    clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => {
      if (this.manager.pendingCount() === 0) void this.close();
    }, lifetimeMs + 1000);
    this.expiryTimer.unref();
    if (this.server) return;
    this.starting ??= new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res));
      server.once('error', (error: NodeJS.ErrnoException) => {
        this.starting = undefined;
        reject(new XApiError('invalid_input', `Cannot listen on ${this.redirect.host} for the OAuth callback (${error.code ?? 'error'}).`));
      });
      const host = this.redirect.hostname === '[::1]' ? '::1' : this.redirect.hostname;
      server.listen(Number(this.redirect.port), host, () => {
        this.server = server;
        this.starting = undefined;
        this.log(`OAuth callback listener ready on ${this.redirect.host}`);
        resolve();
      });
    });
    return this.starting;
  }

  async close(): Promise<void> {
    clearTimeout(this.expiryTimer);
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      this.log('OAuth callback listener closed');
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${this.redirect.host}`);
    if (req.method !== 'GET' || url.pathname !== this.redirect.pathname) {
      page(res, 404, 'Not found.');
      return;
    }
    try {
      const account = await this.manager.completeAuthorization({
        code: url.searchParams.get('code'),
        state: url.searchParams.get('state'),
        error: url.searchParams.get('error'),
      });
      this.log(`OAuth authorization completed for account ${account.user_id}`);
      page(res, 200, `Connected X account @${account.username}. You can close this window.`);
      this.completion.forEach((l) => l({ account }));
    } catch (error) {
      const err = error instanceof XApiError ? error : new XApiError('oauth_error', 'Authorization failed.');
      this.log(`OAuth authorization failed: ${err.kind}`);
      page(res, 400, `Authorization failed: ${err.message}`);
      this.completion.forEach((l) => l({ error: err }));
    }
  }
}
