import { execFileSync, spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allTools } from '../src/tools/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = fileURLToPath(new URL('../build/index.js', import.meta.url));
const TOKEN = 'stdio-test-oauth2-token-0123456789';

interface Seen {
  method: string;
  path: string;
  auth?: string;
  body?: unknown;
}

let mock: Server;
let baseUrl: string;
const seen: Seen[] = [];

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

beforeAll(async () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '-p', 'tsconfig.build.json'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  mock = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const body = await readJson(req);
    seen.push({ method: req.method ?? '', path: url.pathname, auth: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-rate-limit-limit', '75');
    res.setHeader('x-rate-limit-remaining', '74');
    res.setHeader('x-rate-limit-reset', '1800000900');
    if (url.pathname === '/2/users/me') {
      res.end(JSON.stringify({ data: { id: '2244994945', name: 'X Developers', username: 'XDevelopers' } }));
    } else if (url.pathname === '/2/tweets' && req.method === 'POST') {
      res.statusCode = 201;
      res.end(JSON.stringify({ data: { id: '1445880548472328192', text: (body as { text: string }).text } }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ title: 'Not Found Error', detail: 'mock', type: 'https://api.twitter.com/2/problems/resource-not-found' }));
    }
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => mock.close(() => resolve()));
});

function transport(stderr: PassThrough): StdioClientTransport {
  const t = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: { ...getDefaultEnvironment(), X_API_BASE_URL: baseUrl, X_OAUTH2_ACCESS_TOKEN: TOKEN },
    stderr: 'pipe',
  });
  t.stderr?.pipe(stderr);
  return t;
}

function collect(stream: PassThrough): () => string {
  let text = '';
  stream.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
  });
  return () => text;
}

const eras = [
  { label: 'modern handshake (pinned 2026-07-28)', options: { versionNegotiation: { mode: { pin: '2026-07-28' } } }, era: 'modern', version: '2026-07-28' },
  { label: 'auto negotiation', options: { versionNegotiation: { mode: 'auto' as const } }, era: 'modern', version: '2026-07-28' },
  { label: 'legacy initialize handshake', options: {}, era: 'legacy', version: undefined },
] as const;

describe('stdio MCP client integration (built server, loopback mock X API)', () => {
  for (const mode of eras) {
    it(`discovers and calls tools over the ${mode.label}`, async () => {
      seen.length = 0;
      const stderr = new PassThrough();
      const stderrText = collect(stderr);
      const client = new Client({ name: 'x-mcp-stdio-test', version: '0.0.0' }, mode.options as never);
      await client.connect(transport(stderr));
      try {
        expect(client.getProtocolEra()).toBe(mode.era);
        if (mode.version) expect(client.getNegotiatedProtocolVersion()).toBe(mode.version);
        expect(client.getServerVersion()).toMatchObject({ name: 'x-mcp', version: '0.1.0' });

        const names: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined);
          names.push(...page.tools.map((t) => t.name));
          cursor = page.nextCursor;
        } while (cursor);
        expect(names.sort()).toEqual(allTools().map((t) => t.name).sort());
        expect(names).toHaveLength(85);

        const me = await client.callTool({ name: 'TWITTER_USER_LOOKUP_ME', arguments: {} });
        expect(me.isError).toBeFalsy();
        expect(me.structuredContent).toMatchObject({ data: { data: { id: '2244994945' } }, rate_limit: { remaining: 74 } });

        const post = await client.callTool({ name: 'TWITTER_RETWEET_POST', arguments: { tweet_id: '1228393702244134912' } });
        expect(post.isError).toBe(true); // mock answers 404 for the repost route
        expect(post.structuredContent).toMatchObject({ error: { type: 'http_error', status: 404 } });

        const created = await client.callTool({ name: 'TWITTER_CREATION_OF_A_POST', arguments: { text: 'stdio integration' } });
        expect(created.structuredContent).toMatchObject({ data: { data: { text: 'stdio integration' } } });

        const invalid = await client.callTool({ name: 'TWITTER_POST_LOOKUP_BY_POST_ID', arguments: { id: 'not-a-number' } });
        expect(invalid.isError).toBe(true);

        expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
          'GET /2/users/me', // TWITTER_USER_LOOKUP_ME
          'GET /2/users/me', // id resolution for TWITTER_RETWEET_POST
          'POST /2/users/2244994945/retweets',
          'POST /2/tweets',
        ]);
        expect(seen.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true);
      } finally {
        await client.close();
      }
      expect(stderrText()).toContain('X MCP server running on stdio');
      expect(stderrText()).not.toContain(TOKEN);
      expect(stderrText()).not.toContain('stdio integration');
    });
  }

  it('exits with a redacted configuration error for an unsafe base URL', async () => {
    const child = spawn(process.execPath, [ENTRY], {
      env: { ...getDefaultEnvironment(), X_API_BASE_URL: 'http://api.example.com', X_OAUTH2_ACCESS_TOKEN: TOKEN },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/configuration error: X_API_BASE_URL must use https/);
    expect(stderr).not.toContain(TOKEN);
  });
});
