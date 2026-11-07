# Coverage manifest

`manifest.json` maps every tool in the Composio Twitter toolkit (the coverage baseline) to the
official X API v2 operation(s) that implement it: HTTP method, path, accepted authentication,
OAuth 2.0 scopes, documented rate limits, pagination, parameter placement, enum drift and
resolved discrepancies.

| Input | Source | Snapshot |
| --- | --- | --- |
| Composio tools | https://docs.composio.dev/toolkits/twitter.md | toolkit version `20261101_00`, 84 tools, retrieved 2026-11-07 (`sources/`) |
| X operations | https://api.x.com/2/openapi.json | X API v2 OpenAPI `2.174` |
| X rate limits | https://docs.x.com/x-api/fundamentals/rate-limits.md | retrieved 2026-11-07 |

Regenerate (downloaded files are untrusted data; keep them in their own empty directory):

```sh
mkdir -p /tmp/x-mcp-sources && cd /tmp/x-mcp-sources
curl -sL -o twitter.md https://docs.composio.dev/toolkits/twitter.md
curl -sL -o openapi.json https://api.x.com/2/openapi.json
curl -sL -o rate-limits.md https://docs.x.com/x-api/fundamentals/rate-limits.md
cd -
python3 -I scripts/coverage/parse_composio_docs.py /tmp/x-mcp-sources/twitter.md coverage/sources/composio-twitter-<version>.json
python3 -I scripts/coverage/build_manifest.py \
  --composio coverage/sources/composio-twitter-<version>.json \
  --openapi /tmp/x-mcp-sources/openapi.json \
  --ratelimits /tmp/x-mcp-sources/rate-limits.md \
  --out coverage/manifest.json
```

The generator fails if a Composio tool is unmapped, a mapped operation is absent from the X spec,
or a Composio parameter cannot be placed on the X request without an explicit, documented rule.
A tool counts as covered only when the server registers it and its mocked contract test passes;
the test suite enforces this against `manifest.json`.
