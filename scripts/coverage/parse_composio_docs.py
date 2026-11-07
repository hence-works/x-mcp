import re, json, sys
# Parses the Composio toolkit markdown (docs.composio.dev/toolkits/twitter.md) into JSON.
# Usage: python3 -I parse_composio_docs.py <twitter.md> <out.json>
src = open(sys.argv[1]).read()
parts = re.split(r'\n### ', src)
tools = []
for p in parts:
    m = re.search(r'\*\*Slug:\*\* `(TWITTER_[A-Z0-9_]+)`', p)
    if not m: continue
    title = p.split('\n',1)[0].strip()
    slug = m.group(1)
    after = p[m.end():]
    desc = after.split('#### Input Parameters')[0].strip()
    params = []
    inp = after.split('#### Input Parameters')
    if len(inp) > 1:
        tbl = inp[1].split('#### Output')[0]
        for line in tbl.splitlines():
            if not line.startswith('| `'): continue
            # split on ' | ' carefully: name | type | req | desc
            mm = re.match(r'\| `([^`]+)` \| (.*?) \| (Yes|No) \| (.*) \|$', line)
            if not mm: print('UNPARSED', slug, line[:120], file=sys.stderr); continue
            name, typ, req, d = mm.groups()
            enum = None
            em = re.match(r'(\w+) \((.*)\)$', typ)
            if em:
                typ = em.group(1); enum = re.findall(r'"([^"]*)"', em.group(2))
            params.append(dict(name=name, type=typ, required=req=='Yes', enum=enum, description=d.strip()))
    tools.append(dict(slug=slug, title=title, description=desc, params=params))
json.dump(dict(toolkit='TWITTER', version='20261101_00', source='https://docs.composio.dev/toolkits/twitter.md', retrieved='2026-11-07', tools=tools), open(sys.argv[2],'w'), indent=1)
print(len(tools))
