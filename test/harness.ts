import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer } from '../src/server.js';
import type { ToolDefinition } from '../src/tools/framework.js';
import { mockFetch, type MockReply, type RecordedRequest, TEST_SECRETS, testConfig } from './helpers.js';
import { XClient } from '../src/x/client.js';

export interface Harness {
  mcp: Client;
  requests: RecordedRequest[];
  logs: string[];
  sleeps: number[];
  close(): Promise<void>;
}

/** Connects an MCP client to a fresh server over an in-memory transport with X HTTP mocked. */
export async function connectHarness(
  handler: (req: RecordedRequest) => MockReply | Promise<MockReply>,
  options: { env?: NodeJS.ProcessEnv; tools?: ToolDefinition[] } = {},
): Promise<Harness> {
  const { fetch, requests } = mockFetch(handler);
  const sleeps: number[] = [];
  const logs: string[] = [];
  const config = testConfig(options.env ?? TEST_SECRETS);
  const client = new XClient(config, {
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 1_800_000_000_000,
  });
  const server = createServer({ config, client, tools: options.tools, log: (m) => logs.push(m) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: 'x-mcp-test', version: '0.0.0' });
  await mcp.connect(clientTransport);
  return {
    mcp,
    requests,
    logs,
    sleeps,
    async close() {
      await mcp.close();
      await server.close();
    },
  };
}

/** Replies from a queue in order; a missing entry fails the request loudly. */
export function queued(replies: MockReply[]) {
  const queue = [...replies];
  return () => {
    const next = queue.shift();
    if (!next) return { status: 599, body: { title: 'unexpected extra request in test' } };
    return next;
  };
}
