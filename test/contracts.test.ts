import { describe, expect, it } from 'vitest';
import { connectHarness, queued } from './harness.js';
import { TEST_SECRETS, type MockReply } from './helpers.js';
import { contractCases } from './contracts/index.js';
import type { ExpectedAuth } from './contracts/types.js';

function authOf(header: string | undefined): ExpectedAuth {
  if (header === undefined) return 'none';
  if (header === `Bearer ${TEST_SECRETS.X_OAUTH2_ACCESS_TOKEN}`) return 'oauth2_user';
  if (header === `Bearer ${TEST_SECRETS.X_BEARER_TOKEN}`) return 'app_bearer';
  if (header.startsWith('OAuth ')) return 'oauth1_user';
  throw new Error('unexpected authorization header');
}

describe('X endpoint contracts (mocked HTTP, called through MCP)', () => {
  for (const c of contractCases) {
    it(`${c.tool}${c.label ? ` (${c.label})` : ''}`, async () => {
      const replies: MockReply[] = c.calls.map((_, i) => c.replies?.[i] ?? { body: { data: { contract: c.tool, call: i } } });
      const all: MockReply[] = c.me ? [{ body: { data: { id: c.me, name: 'Me', username: 'me' } } }, ...replies] : replies;
      const h = await connectHarness(queued(all), { env: c.env });
      try {
        await c.setup?.(h);
        const result = await h.mcp.callTool({ name: c.tool, arguments: c.args });
        expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
        const reqs = [...h.requests];
        if (c.me) {
          const me = reqs.shift()!;
          expect(me.method).toBe('GET');
          expect(me.url.pathname).toBe('/2/users/me');
        }
        expect(reqs).toHaveLength(c.calls.length);
        c.calls.forEach((exp, i) => {
          const req = reqs[i]!;
          expect(req.method).toBe(exp.method);
          expect(req.url.pathname).toBe(exp.path);
          expect(Object.fromEntries(req.url.searchParams)).toEqual(exp.query ?? {});
          if (exp.multipart) {
            expect(req.body).toBeInstanceOf(FormData);
            const form = req.body as FormData;
            for (const [k, v] of Object.entries(exp.multipart)) {
              const got = form.get(k);
              if (typeof v === 'string') expect(got).toBe(v);
              else expect((got as Blob).size).toBe(v.bytes);
            }
          } else {
            expect(req.body).toEqual(exp.body);
          }
          expect(authOf(req.headers.authorization)).toBe(exp.auth ?? 'oauth2_user');
        });
        const structured = result.structuredContent as Record<string, unknown>;
        const lastAuth = c.calls.length ? (c.calls[c.calls.length - 1]!.auth ?? 'oauth2_user') : undefined;
        if (lastAuth && lastAuth !== 'none' && !c.tool.startsWith('X_AUTH_')) expect(structured.auth).toBe(lastAuth);
        if (c.verify) c.verify(structured);
        else expect(structured.data).toEqual(replies[replies.length - 1]!.body);
      } finally {
        await h.close();
      }
    });
  }
});
