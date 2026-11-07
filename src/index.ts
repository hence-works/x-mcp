#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ConfigError, loadConfig } from './config.js';
import { createServer } from './server.js';
import { XClient } from './x/client.js';

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`[x-mcp] configuration error: ${error instanceof ConfigError ? error.message : 'invalid configuration'}\n`);
    process.exit(1);
  }
  // One X client per process: it caches the authenticated user's id across server instances.
  const client = new XClient(config);
  serveStdio(() => createServer({ config, client }), {
    onerror: (error) => process.stderr.write(`[x-mcp] transport error: ${error.message}\n`),
  });
  process.stderr.write('[x-mcp] X MCP server running on stdio\n');
}

main();
