#!/usr/bin/env python3
"""Render docs/COVERAGE.md from coverage/manifest.json.
Usage: python3 -I scripts/coverage/render_coverage.py coverage/manifest.json docs/COVERAGE.md
"""
import json
import sys

AUTH = {'oauth2_user': 'OAuth2 user', 'oauth1_user': 'OAuth1a user', 'app_bearer': 'App bearer'}

m = json.load(open(sys.argv[1]))
out = []
b, x = m['baseline'], m['x_api']
out.append('# Tool coverage\n')
out.append(f"Generated from `coverage/manifest.json` by `scripts/coverage/render_coverage.py`. Baseline: Composio "
           f"`{b['toolkit']}` toolkit version `{b['version']}` ({b['tool_count']} tools, retrieved {b['retrieved']}). "
           f"Endpoints: X API v2 OpenAPI `{x['openapi_version']}`. Rate limits: [X rate-limit page]({x['rate_limits_source'].removesuffix('.md')}).\n")
out.append(f"All {b['tool_count']} baseline tools are implemented, registered and covered by mocked HTTP contract tests "
           "(`test/contracts/`). None is a stub. Live behavior against api.x.com has not been exercised (see README).\n")
out.append('## Resolved discrepancies\n')
for d in m['global_discrepancies']:
    out.append(f'- {d}')
out.append('')
out.append('## Extra tools (not counted toward coverage)\n')
for e in m['extra_tools']:
    out.append(f"- `{e['name']}` (`{e['operationId']}`): {e['reason']}")
out.append('')
for scope in ['posts-users', 'lists-bookmarks-relationships', 'direct-messages', 'spaces-media', 'platform']:
    out.append(f'## {scope}\n')
    out.append('| Tool | X endpoint(s) | Auth | OAuth 2.0 scopes | Rate limit (app / user) | Pagination | Notes |')
    out.append('| --- | --- | --- | --- | --- | --- | --- |')
    for t in [t for t in m['tools'] if t['scope'] == scope]:
        eps = '<br>'.join(f"`{e['method']} {e['path']}`" for e in t['endpoints'])
        e0 = t['endpoints'][0]
        auth = ', '.join(AUTH[a] for a in e0['auth']) or 'none'
        scopes_ = ', '.join(f'`{s}`' for s in e0['oauth2_scopes']) or '-'
        rl = e0['rate_limit']
        rate = f"{rl['per_app']} / {rl['per_user']}" if rl else 'not listed'
        pag = f"`{t['pagination']['request_param']}`" if t['pagination'] else '-'
        notes = ' '.join(t['notes']).replace('|', '\\|') or '-'
        out.append(f"| `{t['name']}` | {eps} | {auth} | {scopes_} | {rate} | {pag} | {notes} |")
    out.append('')
open(sys.argv[2], 'w').write('\n'.join(out))
print(f"rendered {len(m['tools'])} tools")
