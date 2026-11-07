# x-mcp

Standalone [Model Context Protocol](https://modelcontextprotocol.io) server for the
[X API v2](https://docs.x.com/x-api/introduction), communicating directly with `api.x.com` over stdio.
It implements every tool in the [Composio Twitter toolkit](https://composio.dev/toolkits/twitter)
(84 tools, toolkit version `20261101_00`) with the same tool names and parameter names, plus one extra
tool that completes the chunked media upload flow. There is no Composio runtime dependency.

- Coverage, endpoint mapping, scopes, rate limits and resolved discrepancies: [docs/COVERAGE.md](docs/COVERAGE.md)
- Machine-readable mapping and how to regenerate it: [coverage/](coverage/README.md)

Built on `@modelcontextprotocol/server` 2.4.0 following the
[official TypeScript server guide](https://modelcontextprotocol.io/docs/2026-07-28/develop/build-server#typescript):
`serveStdio(createServer)` with a fresh `McpServer` per factory call, so the same process serves 2026-07-28
clients and clients that use the 2025-era `initialize` handshake. Diagnostics go to stderr only.

## Requirements

Node.js 20.3 or newer, and an X developer app with the credentials below. The X API uses
[pay-per-usage pricing](https://docs.x.com/x-api/getting-started/pricing): **every live call is billable**,
including reads, and writes create real public content or messages.

## Setup

```sh
npm ci
npm run build
```

MCP client configuration (for example Claude Desktop):

```json
{
  "mcpServers": {
    "x": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/x-mcp/build/index.js"],
      "env": {
        "X_OAUTH2_ACCESS_TOKEN": "...",
        "X_BEARER_TOKEN": "..."
      }
    }
  }
}
```

## Credentials

Configure any combination. Each tool uses the first available credential its endpoint accepts (per the X spec),
in this order: a connected account (below), then `X_OAUTH2_ACCESS_TOKEN`, then OAuth 1.0a user credentials, then
the app-only bearer token. A tool whose endpoint accepts none of the available credentials returns an
`auth_not_configured` error without calling X. User credentials are never sent to app-only endpoints, and app-only
credentials are never substituted for user context: every result reports the auth type it used in `auth`.

| Variable | Auth type | Used for |
| --- | --- | --- |
| `X_OAUTH2_CLIENT_ID` (+ `X_OAUTH2_CLIENT_SECRET` for confidential clients) | OAuth 2.0 Authorization Code with PKCE | Connecting user accounts in the browser (recommended). See below. |
| `X_OAUTH2_ACCESS_TOKEN` | Pre-issued OAuth 2.0 user access token | User-context reads and writes without the connect flow. Not refreshed: it fails with 401 after it expires (2 hours). |
| `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` | OAuth 1.0a user context (all four required) | User-context endpoints that accept OAuth 1.0a. Requests are HMAC-SHA1 signed locally. |
| `X_BEARER_TOKEN` | App-only bearer token | Public reads, and app-only endpoints: compliance jobs, post usage, full-archive counts, label stream. |

Every user-context tool accepts OAuth 2.0, so no 3-legged OAuth 1.0a flow is implemented. OAuth 1.0a user
credentials still work if supplied through the environment. Six tools are app-only and need `X_BEARER_TOKEN`
(compliance jobs, post usage, full-archive counts, label stream); `TWITTER_GET_OPENAPI_SPEC` needs no credentials.

### Connecting user accounts (OAuth 2.0 with PKCE)

1. In the [X Developer Console](https://developer.x.com/en/portal/dashboard), open the app's **User authentication
   settings**, enable OAuth 2.0, and choose the app type: **Native App** (public client, no secret) or **Web App /
   Automated App or bot** (confidential client, which issues a Client Secret).
2. Add the callback URL **exactly** as you will configure it, for example `http://127.0.0.1:8723/callback`
   (the default). X matches redirect URIs exactly: scheme, host, port and path. Loopback http redirects are served
   by this process; any other redirect must be https and is not served locally.
3. Configure the server:

   | Variable | Default | Meaning |
   | --- | --- | --- |
   | `X_OAUTH2_CLIENT_ID` | unset | Enables account connection. |
   | `X_OAUTH2_CLIENT_SECRET` | unset | Confidential clients only; sent with HTTP Basic auth. |
   | `X_OAUTH2_REDIRECT_URI` | `http://127.0.0.1:8723/callback` | Must equal the registered callback URL. |
   | `X_OAUTH2_CALLBACK_TIMEOUT_MS` | 300000 | Lifetime of each authorization request (state, PKCE verifier, listener), 30 s to 15 min. |
   | `X_MCP_TOKEN_KEY` | unset | 32-byte key (64 hex characters or base64), e.g. `openssl rand -base64 32`. Enables encrypted persistent storage. Supply it separately from the token directory, for example from a secret manager. |
   | `X_MCP_TOKEN_DIR` | `$XDG_CONFIG_HOME/x-mcp/accounts` | One AES-256-GCM encrypted file per account (mode 0600, directory 0700). |
   | `X_MCP_ACCOUNT_ID` | unset | X user id of the account to act as when several are connected. |

4. Connect from a terminal with `x-mcp auth login [--tools TOOL_A,TOOL_B]`, or from the MCP client with
   `X_AUTH_CONNECT`. Either prints or returns an authorize URL to open in a browser signed in to the X account. Check
   the result with `x-mcp auth status` or `X_AUTH_STATUS`. Disconnect with `x-mcp auth logout [--account ID]` or
   `X_AUTH_DISCONNECT` (active account only).

How it works:

- PKCE S256 with a fresh verifier per request. The state is 256 random bits, single-use (consumed before any other
  check, so a replayed or forged callback fails), and expires with the request. The callback listener answers only
  GET on the exact redirect path, never echoes the code, and stops once no request is pending.
- Scopes: only those the named tools need (from the X spec security; see `src/auth/tool-scopes.ts`), plus
  `tweet.read users.read` to verify the account. `offline.access` is requested only for persistent connections, which
  need `X_MCP_TOKEN_KEY`. Without it, a connection lasts for the process and ends when its 2-hour access token expires.
- After the code exchange, the server calls `GET /2/users/me` with the new token. The account is bound to the user id X
  returns, and is never trusted from input.
- Tokens refresh about a minute before expiry, one refresh per account at a time. X refresh tokens are single-use, so
  the rotated token is saved before the new access token is used. A 401 triggers one refresh and one retry; X rejected
  the token before acting, so this is safe even for writes. If X rejects the grant (`invalid_grant`, revoked or
  expired), the stored grant is deleted and tools return `reauthorization_required`.
- Isolation: the active account comes from `X_MCP_ACCOUNT_ID`, else the account connected in this session, else the
  only stored account. With several stored accounts and no pin, tools refuse to guess. No tool argument selects an
  account. Arguments naming the acting user (for example `id` on like, bookmark, mute and list-follow tools) must equal
  the connected account's id or be omitted. Tools whose scopes were not granted fail with `missing_scopes` before any
  request. Each account's file is encrypted with the account id as additional authenticated data, so a file copied
  to another account's name does not decrypt. Grants issued to a different client id are refused.
- No tool accepts or returns tokens, authorization codes or client secrets, and diagnostics never include them.

### OAuth 2.0 scopes

Per-tool scopes are listed in [docs/COVERAGE.md](docs/COVERAGE.md). Connecting for all tools requests:

`tweet.read tweet.write tweet.moderate.write users.read follows.read follows.write like.read like.write
list.read list.write bookmark.read bookmark.write mute.read mute.write block.read dm.read dm.write
space.read media.write`, plus `offline.access` for persistent connections.

### Billing

X API access is prepaid pay-per-usage ([pricing](https://docs.x.com/x-api/getting-started/pricing)); for example,
Post reads are charged per returned resource and post creation per request, with higher rates for posts containing
URLs. Rates vary by operation and change over time, so check the Developer Console before live use.

- OAuth grants account permissions; it does **not** waive charges. Usage is charged to the developer app whose
  credentials (client id, or bearer and OAuth 1.0a keys) make the request. Users who bring their own developer app
  fund that app's usage.
- Do not assume that users authorizing a shared app qualify for discounts that apply to the app owner's own reads.
- Before live use, buy credits and set a spending limit (and auto-recharge policy) in the Developer Console.
  This server does not track spend. `TWITTER_GET_POST_USAGE` reports post consumption.
- Resolving the acting user via `GET /2/users/me` is one extra billable request, except for connected accounts, whose
  id is already known.

### Plan and access notes

- Official X reference pages do not state per-endpoint plan restrictions. Composio reports that
  `TWITTER_GET_POST_ANALYTICS` and `TWITTER_STREAM_POST_LABELS` need Enterprise access (403 otherwise); this is
  recorded but unverified.
- Pay-per-usage plans cap Post reads at 3 million per monthly billing cycle (X pricing page).
- X Activity webhook deliveries (`TWITTER_CREATE_ACTIVITY_SUBSCRIPTION`) are billed per delivered event.

## Optional settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `X_API_BASE_URL` | `https://api.x.com` | Must be https; plain http is allowed only for loopback hosts (tests). |
| `X_MCP_MEDIA_ROOT` | unset | Directory that `media.path` inputs must resolve inside (symlinks are resolved first). Path inputs are disabled when unset; base64 input always works. |
| `X_MCP_MAX_MEDIA_BYTES` | 536870912 | Maximum bytes for one media input. |
| `X_MCP_MAX_RETRIES` | 2 | Retries for GET requests on 429, 5xx or network errors (0-5). |
| `X_MCP_MAX_RETRY_WAIT_MS` | 5000 | Longest single retry wait. A 429 whose reset is further away is returned immediately. |
| `X_MCP_TIMEOUT_MS` | 30000 | Per-request timeout. |
| `X_MCP_MEDIA_PROCESSING_TIMEOUT_MS` | 120000 | Upper bound for STATUS polling in `TWITTER_UPLOAD_LARGE_MEDIA`. |

## Behavior

- **Results**: `structuredContent` is `{ data, rate_limit?, pagination?, auth? }`, where `auth` is the credential type used and `data` is the unmodified X response
  body (including partial `errors` on 200 responses), `rate_limit` comes from the `x-rate-limit-*` headers and
  `pagination` echoes `meta.next_token` / `meta.previous_token`. The same JSON is returned as a text block.
- **Pagination**: each call returns one page. Pass `pagination.next_token` back as `pagination_token` (or
  `next_token` on search endpoints). Composio's automatic multi-page fetching is not reproduced.
- **Errors**: failures are MCP tool results with `isError: true` and
  `structuredContent.error = { type, message, status?, title?, detail?, x_errors?, rate_limit?, retry_after_seconds? }`.
  Types: `invalid_input`, `auth_not_configured`, `missing_scopes`, `reauthorization_required`, `oauth_error`,
  `http_error`, `rate_limited`, `network_error`, `timeout`, `unexpected_response`, `media_processing`, `internal_error`. Configured credential values are redacted from
  error payloads and diagnostics; tool arguments are never logged.
- **Validation**: input schemas are strict (unknown keys are rejected) and use the X spec's id patterns, bounds and
  enums. Cross-field rules that the Composio baseline documents are checked before any request: incompatible post
  attachments, incomplete polls, and combining time bounds with id bounds on recent search and full-archive counts.
  The X spec states none of these rules, so they are enforced only where documented.
- **Retries**: only GET requests are retried. Writes, including DM sends, posts and media APPEND/FINALIZE, are never
  retried; a network failure on a write says the outcome is unknown.
- **Authenticated user id**: tools whose Composio schema makes the acting user id optional resolve it once per process
  via `GET /2/users/me`, which is one extra billable request.
- **Media**: `media` inputs are `{ base64 | path, mime_type?, filename? }` instead of Composio's hosted file object.
  `TWITTER_UPLOAD_LARGE_MEDIA` runs INITIALIZE, then 4 MiB APPENDs, FINALIZE, and STATUS polling. Manual chunked uploads use
  `TWITTER_INITIALIZE_MEDIA_UPLOAD`, `TWITTER_APPEND_MEDIA_UPLOAD`, the extra `X_FINALIZE_MEDIA_UPLOAD`, then
  `TWITTER_GET_MEDIA_UPLOAD_STATUS`.
- **Streams**: `TWITTER_STREAM_POST_LABELS` reads for at most `timeout_seconds` (default 10) or `max_events`
  (default 100), then disconnects.

## Development

```sh
npm run typecheck   # tsc --noEmit over src and test
npm run build       # emit build/
npm test            # vitest: offline unit, contract, conformance and stdio integration tests
npm run check       # all three
```

All tests are offline. X HTTP is mocked (an in-memory fetch stub, or a loopback HTTP server for the stdio tests),
so they make no real posts, messages or paid API calls:

- `test/contracts/`: at least one contract case per tool, called through an MCP client, asserting the exact X
  method, path, query, body and auth type.
- `test/manifest.test.ts`: every manifest tool is registered with matching operation ids, accepted auth,
  parameters, required-ness and official enums, and has a contract case that hits the manifest endpoint.
- `test/behavior.test.ts`: validation, missing credentials, 401, 429 and retry policy, pagination, media lifecycle
  (processing failure, polling timeout, append failure, media root), streams and redaction.
- `test/auth.test.ts`: the OAuth flow through the real loopback callback against a fake X authorization server. It
  covers success, denial, state mismatch, replay and expiry, refresh with rotation and single-flight, 401 refresh,
  revoked or invalid grants, missing scopes, disconnect, account isolation (pinning, acting-user ids, encrypted file
  swap, ambiguity, foreign client), confidential clients, and storage permissions.
- `test/stdio.test.ts`: spawns `build/index.js` and checks discovery and calls with the pinned 2026-07-28 handshake,
  auto negotiation and the legacy `initialize` handshake. It also runs the `x-mcp auth login`, `status` and `logout`
  CLI end to end.

Manual protocol check with the official Inspector (lists tools only, no X calls):

```sh
npx @modelcontextprotocol/inspector@2.14.0 --cli node build/index.js --protocol-era modern --method tools/list
npx @modelcontextprotocol/inspector@2.14.0 --cli node build/index.js --protocol-era legacy --method tools/list
```

## Not verified live

No request has been sent to `api.x.com`: live calls are billable and can publish content. The following are
verified only against the official spec and documentation, not against live responses:

- `tweet.fields` as the wire name. X OpenAPI 2.174 says `post.fields`, while the fields guide and Composio say `tweet.fields`.
- Enterprise-only access for post analytics and the label stream.
- Real response shapes for X Chat, news, activity subscriptions and the label stream event framing.
- OAuth 1.0a acceptance on v2 media upload and other endpoints the spec marks `UserToken`. The signer matches X's
  published signature example.
- Media processing timings and chunk limits beyond the spec's 0-9999 `segment_index` range.
- The OAuth flow against x.com: acceptance of a loopback `http://127.0.0.1` callback URL by the Developer Console,
  real token and revoke response bodies, and refresh-token rotation timing. Tests follow the documented formats.
- Whether X reports granted scopes in the token response for every client type. When it does not, the requested
  scopes are recorded.

## Reference

The [EnesCinr/twitter-mcp](https://github.com/EnesCinr/twitter-mcp) server (MIT) was reviewed as a reference. No code
was copied from it, and two of its patterns were deliberately not adopted: logging tool arguments, and reporting errors
inside text blocks instead of at the result level.
