#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { CallbackListener } from './auth/callback.js';
import { createAccountManager } from './auth/index.js';
import { runCli } from './cli.js';
import { ConfigError, loadConfig } from './config.js';
import { createServer } from './server.js';
import { XClient } from './x/client.js';

const log = (message: string) => process.stderr.write(`[x-mcp] ${message}\n`);

function main(): void {
  if (process.argv[2] === 'auth') {
    runCli(process.argv.slice(3)).then((code) => process.exit(code));
    return;
  }
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`[x-mcp] configuration error: ${error instanceof ConfigError ? error.message : 'invalid configuration'}\n`);
    process.exit(1);
  }
  // One X client and account manager per process, shared by every server instance serveStdio creates.
  const accounts = createAccountManager(config);
  const callback = config.oauth ? new CallbackListener(accounts, config.oauth.redirectUri, log) : undefined;
  const client = new XClient(config, { accounts });
  serveStdio(() => createServer({ config, client, accounts, callback }), {
    onerror: (error) => process.stderr.write(`[x-mcp] transport error: ${error.message}\n`),
  });
  process.stderr.write('[x-mcp] X MCP server running on stdio\n');
}

main();
