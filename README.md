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

Configure any combination; each tool uses the first configured credential its endpoint accepts, in the order
OAuth 2.0 user token, OAuth 1.0a user, app-only bearer token. A tool whose endpoint accepts none of the configured
credentials returns an `auth_not_configured` error without calling X.

| Variable | Auth type | Used for |
| --- | --- | --- |
| `X_OAUTH2_ACCESS_TOKEN` | OAuth 2.0 user access token (Authorization Code with PKCE) | User-context reads and writes. Required for bookmark writes and Space ticket buyers. |
| `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` | OAuth 1.0a user context (all four required) | User-context endpoints that accept OAuth 1.0a. Requests are HMAC-SHA1 signed locally. |
| `X_BEARER_TOKEN` | App-only bearer token | Public reads, and app-only endpoints: compliance jobs, post usage, full-archive counts, label stream. |

The server reads credentials from its environment only. It does not obtain, refresh or store tokens: an expired
OAuth 2.0 access token produces a 401 tool error until a new token is supplied.

### OAuth 2.0 scopes

Request the scopes for the tools you enable. Per-tool scopes are listed in [docs/COVERAGE.md](docs/COVERAGE.md).
The union across all tools is:

`tweet.read tweet.write tweet.moderate.write users.read follows.read follows.write like.read like.write
list.read list.write bookmark.read bookmark.write mute.read mute.write block.read dm.read dm.write
space.read media.write offline.access` (the last only if you refresh tokens outside this server).

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

- **Results**: `structuredContent` is `{ data, rate_limit?, pagination? }`, where `data` is the unmodified X response
  body (including partial `errors` on 200 responses), `rate_limit` comes from the `x-rate-limit-*` headers and
  `pagination` echoes `meta.next_token` / `meta.previous_token`. The same JSON is returned as a text block.
- **Pagination**: each call returns one page. Pass `pagination.next_token` back as `pagination_token` (or
  `next_token` on search endpoints). Composio's automatic multi-page fetching is not reproduced.
- **Errors**: failures are MCP tool results with `isError: true` and
  `structuredContent.error = { type, message, status?, title?, detail?, x_errors?, rate_limit?, retry_after_seconds? }`.
  Types: `invalid_input`, `auth_not_configured`, `http_error`, `rate_limited`, `network_error`, `timeout`,
  `unexpected_response`, `media_processing`, `internal_error`. Configured credential values are redacted from
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
- `test/stdio.test.ts`: spawns `build/index.js` and checks discovery and calls with the pinned 2026-07-28 handshake,
  auto negotiation and the legacy `initialize` handshake.

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

## Reference

The [EnesCinr/twitter-mcp](https://github.com/EnesCinr/twitter-mcp) server (MIT) was reviewed as a reference. No code
was copied from it, and two of its patterns were deliberately not adopted: logging tool arguments, and reporting errors
inside text blocks instead of at the result level.
