import { describe, expect, it } from 'vitest';
import { connectHarness, queued } from './harness.js';
import { TEST_SECRETS } from './helpers.js';

function text(result: { content: unknown }): string {
  return ((result.content as { text: string }[])[0]?.text) ?? '';
}

describe('tool discovery', () => {
  it('lists every registered tool with annotations and strict input schemas', async () => {
    const h = await connectHarness(queued([]));
    try {
      const { tools } = await h.mcp.listTools();
      const create = tools.find((t) => t.name === 'TWITTER_CREATION_OF_A_POST')!;
      expect(create.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
      expect(create.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      const del = tools.find((t) => t.name === 'TWITTER_POST_DELETE_BY_POST_ID')!;
      expect(del.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
      const get = tools.find((t) => t.name === 'TWITTER_POST_LOOKUP_BY_POST_ID')!;
      expect(get.annotations).toMatchObject({ readOnlyHint: true });
    } finally {
      await h.close();
    }
  });
});

describe('argument validation', () => {
  it('rejects malformed ids, unknown keys and out-of-range values before any HTTP call', async () => {
    const h = await connectHarness(queued([]));
    try {
      const bad = [
        { name: 'TWITTER_POST_LOOKUP_BY_POST_ID', arguments: { id: '12ab' } },
        { name: 'TWITTER_POST_LOOKUP_BY_POST_ID', arguments: { id: '1', 'tweet.fields': ['x'] } },
        { name: 'TWITTER_RECENT_SEARCH', arguments: { query: 'x', max_results: 101 } },
        { name: 'TWITTER_RECENT_SEARCH', arguments: { query: '' } },
        { name: 'TWITTER_USER_LOOKUP_BY_USERNAME', arguments: { username: '@XDevelopers' } },
        { name: 'TWITTER_RECENT_SEARCH', arguments: { query: 'x', start_time: 'yesterday' } },
        { name: 'TWITTER_POST_LOOKUP_BY_POST_IDS', arguments: { ids: [] } },
      ];
      for (const call of bad) {
        const result = await h.mcp.callTool(call);
        expect(result.isError, JSON.stringify(call)).toBe(true);
      }
      expect(h.requests).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('enforces cross-field rules without calling X', async () => {
    const h = await connectHarness(queued([]));
    try {
      const cases = [
        { args: { query: 'x', start_time: '2026-11-01T00:00:00Z', since_id: '1' }, tool: 'TWITTER_RECENT_SEARCH', msg: /cannot be combined/ },
        { args: { text: 'x', poll_options: ['a', 'b'] }, tool: 'TWITTER_CREATION_OF_A_POST', msg: /provided together/ },
        { args: { text: 'x', poll_options: ['a', 'b'], poll_duration_minutes: 10, quote_tweet_id: '1' }, tool: 'TWITTER_CREATION_OF_A_POST', msg: /Only one of/ },
        { args: {}, tool: 'TWITTER_CREATION_OF_A_POST', msg: /text is required/ },
        { args: { text: 'x', media_tagged_user_ids: ['1'] }, tool: 'TWITTER_CREATION_OF_A_POST', msg: /requires media_media_ids/ },
      ];
      for (const c of cases) {
        const result = await h.mcp.callTool({ name: c.tool, arguments: c.args });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ error: { type: 'invalid_input' } });
        expect(text(result)).toMatch(c.msg);
      }
      expect(h.requests).toHaveLength(0);
    } finally {
      await h.close();
    }
  });
});

describe('X failures surface as redacted result-level errors', () => {
  it('reports missing credentials without calling X', async () => {
    const h = await connectHarness(queued([]), { env: { X_BEARER_TOKEN: TEST_SECRETS.X_BEARER_TOKEN } });
    try {
      const result = await h.mcp.callTool({ name: 'TWITTER_CREATION_OF_A_POST', arguments: { text: 'hi' } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { type: 'auth_not_configured' } });
      expect(text(result)).toMatch(/X_OAUTH2_ACCESS_TOKEN/);
      expect(h.requests).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('reports 401 from X and never leaks credentials into results or logs', async () => {
    const h = await connectHarness(
      queued([{ status: 401, body: { title: 'Unauthorized', type: 'about:blank', status: 401, detail: `bad token ${TEST_SECRETS.X_OAUTH2_ACCESS_TOKEN}` } }]),
    );
    try {
      const result = await h.mcp.callTool({ name: 'TWITTER_USER_LOOKUP_ME', arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { type: 'http_error', status: 401, title: 'Unauthorized' } });
      const everything = text(result) + JSON.stringify(result.structuredContent) + h.logs.join('\n');
      for (const secret of Object.values(TEST_SECRETS)) expect(everything).not.toContain(secret);
    } finally {
      await h.close();
    }
  });

  it('reports 429 with rate-limit details and does not retry a write', async () => {
    const h = await connectHarness(
      queued([{ status: 429, body: { title: 'Too Many Requests' }, headers: { 'x-rate-limit-limit': '100', 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': String(1_800_000_000 + 900) } }]),
    );
    try {
      const result = await h.mcp.callTool({ name: 'TWITTER_CREATION_OF_A_POST', arguments: { text: 'hi' } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { type: 'rate_limited', status: 429, retry_after_seconds: 900, rate_limit: { limit: 100, remaining: 0, reset: 1_800_000_900 } },
      });
      expect(h.requests).toHaveLength(1);
      expect(h.sleeps).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('retries a read after a short 429 and returns rate-limit metadata', async () => {
    const h = await connectHarness(
      queued([
        { status: 429, body: { title: 'Too Many Requests' }, headers: { 'x-rate-limit-reset': String(1_800_000_000 + 1) } },
        { body: { data: { id: '1' } }, headers: { 'x-rate-limit-limit': '900', 'x-rate-limit-remaining': '899', 'x-rate-limit-reset': '1800000900' } },
      ]),
    );
    try {
      const result = await h.mcp.callTool({ name: 'TWITTER_GET_USER_BY_ID', arguments: { id: '1' } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ data: { data: { id: '1' } }, rate_limit: { remaining: 899 } });
      expect(h.sleeps).toEqual([1000]);
    } finally {
      await h.close();
    }
  });

  it('reports X partial errors inside a 200 response as data, not failure', async () => {
    const body = { data: [{ id: '1', text: 'ok' }], errors: [{ value: '2', detail: 'Could not find tweet with ids: [2].', title: 'Not Found Error', resource_type: 'tweet', parameter: 'ids' }] };
    const h = await connectHarness(queued([{ body }]));
    try {
      const result = await h.mcp.callTool({ name: 'TWITTER_POST_LOOKUP_BY_POST_IDS', arguments: { ids: ['1', '2'] } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ data: body });
    } finally {
      await h.close();
    }
  });

  it('logs tool outcomes to the diagnostics sink without arguments', async () => {
    const h = await connectHarness(queued([{ status: 201, body: { data: { id: '9', text: 'private words' } } }]));
    try {
      await h.mcp.callTool({ name: 'TWITTER_CREATION_OF_A_POST', arguments: { text: 'private words' } });
      expect(h.logs.join('\n')).toMatch(/TWITTER_CREATION_OF_A_POST ok/);
      expect(h.logs.join('\n')).not.toContain('private words');
    } finally {
      await h.close();
    }
  });
});

describe('lists, bookmarks and relationships', () => {
  it('requires an OAuth 2.0 user token for bookmark writes (OAuth 1.0a is not accepted by X)', async () => {
    const h = await connectHarness(queued([]), {
      env: { X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_TOKEN_SECRET: 'ts' },
    });
    try {
      const result = await h.mcp.callTool({ name: 'TWITTER_ADD_POST_TO_BOOKMARKS', arguments: { id: '1', tweet_id: '2' } });
      expect(result.structuredContent).toMatchObject({ error: { type: 'auth_not_configured' } });
      expect(h.requests).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('refuses an empty list update', async () => {
    const h = await connectHarness(queued([]));
    try {
      const result = await h.mcp.callTool({ name: 'TWITTER_UPDATE_LIST', arguments: { id: '1' } });
      expect(result.structuredContent).toMatchObject({ error: { type: 'invalid_input' } });
      expect(h.requests).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('walks pages with pagination.next_token until it is absent', async () => {
    const h = await connectHarness(
      queued([
        { body: { data: [{ id: '1' }], meta: { result_count: 1, next_token: 'PAGE2TOKEN000000' } } },
        { body: { data: [{ id: '2' }], meta: { result_count: 1, previous_token: 'PAGE1TOKEN000000' } } },
      ]),
    );
    try {
      const first = await h.mcp.callTool({ name: 'TWITTER_FOLLOWERS_BY_USER_ID', arguments: { id: '7', max_results: 1 } });
      const token = (first.structuredContent as { pagination?: { next_token?: string } }).pagination?.next_token;
      expect(token).toBe('PAGE2TOKEN000000');
      const second = await h.mcp.callTool({
        name: 'TWITTER_FOLLOWERS_BY_USER_ID',
        arguments: { id: '7', max_results: 1, pagination_token: token },
      });
      expect(second.structuredContent).toMatchObject({ pagination: { previous_token: 'PAGE1TOKEN000000' } });
      expect((second.structuredContent as { pagination: object }).pagination).not.toHaveProperty('next_token');
      expect(h.requests[1]!.url.searchParams.get('pagination_token')).toBe('PAGE2TOKEN000000');
    } finally {
      await h.close();
    }
  });

  it('propagates a failed /2/users/me lookup as the tool error', async () => {
    const h = await connectHarness(queued([{ status: 403, body: { title: 'Forbidden', detail: 'app not attached to a project' } }]));
    try {
      const result = await h.mcp.callTool({ name: 'TWITTER_UNMUTE_USER', arguments: { target_user_id: '5' } });
      expect(result.structuredContent).toMatchObject({ error: { type: 'http_error', status: 403 } });
      expect(h.requests).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
});

describe('direct messages', () => {
  it('requires text or an attachment and validates conversation ids locally', async () => {
    const h = await connectHarness(queued([]));
    try {
      const calls = [
        { name: 'TWITTER_SEND_A_NEW_MESSAGE_TO_A_USER', arguments: { participant_id: '1' } },
        { name: 'TWITTER_CREATE_DM_CONVERSATION', arguments: { conversation_type: 'Group', participant_ids: ['1', '2'], message: {} } },
        { name: 'TWITTER_CREATE_DM_CONVERSATION', arguments: { conversation_type: 'Group', participant_ids: ['1'], message: { text: 'x' } } },
        { name: 'TWITTER_CREATE_DM_CONVERSATION', arguments: { conversation_type: 'OneToOne', participant_ids: ['1', '2'], message: { text: 'x' } } },
        { name: 'TWITTER_SEND_DM_TO_CONVERSATION', arguments: { dm_conversation_id: '../../2/tweets', text: 'x' } },
        { name: 'TWITTER_SEND_A_NEW_MESSAGE_TO_A_USER', arguments: { participant_id: '1', text: 'x', attachments: [{ media_url: 'https://x' }] } },
      ];
      for (const call of calls) {
        const result = await h.mcp.callTool(call);
        expect(result.isError, JSON.stringify(call)).toBe(true);
      }
      expect(h.requests).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('never retries a DM send after a server error', async () => {
    const h = await connectHarness(queued([{ status: 503, body: { title: 'Service Unavailable' } }]));
    try {
      const result = await h.mcp.callTool({ name: 'TWITTER_SEND_A_NEW_MESSAGE_TO_A_USER', arguments: { participant_id: '1', text: 'x' } });
      expect(result.structuredContent).toMatchObject({ error: { type: 'http_error', status: 503 } });
      expect(h.requests).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
});

describe('media lifecycle', () => {
  const MEDIA = '1880028106020515840';
  const video = { base64: Buffer.alloc(32, 1).toString('base64'), mime_type: 'video/mp4' };

  it('fails with media_processing when X reports a failed state', async () => {
    const h = await connectHarness(
      queued([
        { body: { data: { id: MEDIA } } },
        { body: {} },
        { body: { data: { id: MEDIA, processing_info: { state: 'in_progress', check_after_secs: 1 } } } },
        { body: { data: { id: MEDIA, processing_info: { state: 'failed', error: { message: 'InvalidMedia' } } } } },
      ]),
    );
    try {
      const result = await h.mcp.callTool({ name: 'TWITTER_UPLOAD_LARGE_MEDIA', arguments: { media: video } });
      expect(result.structuredContent).toMatchObject({ error: { type: 'media_processing' } });
      expect(h.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
        'POST /2/media/upload/initialize',
        `POST /2/media/upload/${MEDIA}/append`,
        `POST /2/media/upload/${MEDIA}/finalize`,
        'GET /2/media/upload',
      ]);
    } finally {
      await h.close();
    }
  });

  it('stops polling at X_MCP_MEDIA_PROCESSING_TIMEOUT_MS', async () => {
    const pending = { body: { data: { id: MEDIA, processing_info: { state: 'pending', check_after_secs: 5 } } } };
    const h = await connectHarness(queued([{ body: { data: { id: MEDIA } } }, { body: {} }, pending, pending, pending]), {
      env: { ...TEST_SECRETS, X_MCP_MEDIA_PROCESSING_TIMEOUT_MS: '10000' },
    });
    try {
      const result = await h.mcp.callTool({ name: 'TWITTER_UPLOAD_LARGE_MEDIA', arguments: { media: video } });
      expect(result.structuredContent).toMatchObject({ error: { type: 'media_processing' } });
      expect(text(result)).toMatch(/still pending/);
      expect(h.sleeps).toEqual([5000, 5000]);
    } finally {
      await h.close();
    }
  });

  it('stops after a failed APPEND without retrying or finalizing', async () => {
    const h = await connectHarness(queued([{ body: { data: { id: MEDIA } } }, { status: 503, body: { title: 'Service Unavailable' } }]));
    try {
      const result = await h.mcp.callTool({ name: 'TWITTER_UPLOAD_LARGE_MEDIA', arguments: { media: video } });
      expect(result.structuredContent).toMatchObject({ error: { type: 'http_error', status: 503 } });
      expect(h.requests).toHaveLength(2);
    } finally {
      await h.close();
    }
  });

  it('validates one-shot uploads locally', async () => {
    const h = await connectHarness(queued([]));
    try {
      const big = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
      const cases = [
        { media: { base64: Buffer.from('x').toString('base64'), mime_type: 'image/png' }, shared: true },
        { media: { base64: big, mime_type: 'image/png' } },
        { media: { base64: Buffer.from('x').toString('base64'), mime_type: 'video/mp4' } },
        { media: { base64: Buffer.from('x').toString('base64') } },
        { media: { url: 'https://example.com/a.png' } },
      ];
      for (const args of cases) {
        const result = await h.mcp.callTool({ name: 'TWITTER_UPLOAD_MEDIA', arguments: args });
        expect(result.isError, JSON.stringify(args).slice(0, 80)).toBe(true);
      }
      const unknown = await h.mcp.callTool({
        name: 'TWITTER_UPLOAD_LARGE_MEDIA',
        arguments: { media: { base64: Buffer.from('x').toString('base64'), mime_type: 'application/zip' } },
      });
      expect(unknown.structuredContent).toMatchObject({ error: { type: 'invalid_input' } });
      expect(h.requests).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('uploads from X_MCP_MEDIA_ROOT and refuses paths outside it', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = await mkdtemp(path.join(os.tmpdir(), 'x-mcp-root-'));
    await writeFile(path.join(root, 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    const h = await connectHarness(queued([{ body: { data: { id: MEDIA } } }]), {
      env: { ...TEST_SECRETS, X_MCP_MEDIA_ROOT: root },
    });
    try {
      const ok = await h.mcp.callTool({ name: 'TWITTER_UPLOAD_MEDIA', arguments: { media: { path: 'photo.jpg' } } });
      expect(ok.isError).toBeFalsy();
      expect(h.requests[0]!.body).toEqual({ media: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64'), media_category: 'tweet_image' });
      const escape = await h.mcp.callTool({ name: 'TWITTER_UPLOAD_MEDIA', arguments: { media: { path: '/etc/hostname' } } });
      expect(escape.structuredContent).toMatchObject({ error: { type: 'invalid_input' } });
      expect(h.requests).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
});
