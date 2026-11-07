import { z } from 'zod';
import { invalidInput, XApiError } from '../x/errors.js';
import { customTool, httpTool, type ToolDefinition } from './framework.js';
import { expansions, fields, idList, maxResults, paginationToken, timestamp, xId } from './schemas.js';

const scope = 'platform' as const;
const APP_ONLY = ['app_bearer'] as const;
const USER_CONTEXT = ['oauth2_user', 'oauth1_user'] as const;

/** X activity event types (OpenAPI 2.174 enum; a superset of the Composio list). */
const ACTIVITY_EVENT_TYPES = [
  'profile.update.bio', 'profile.update.profile_picture', 'profile.update.banner_picture', 'profile.update.screenname',
  'profile.update.geo', 'profile.update.url', 'profile.update.verified_badge', 'profile.update.affiliate_badge',
  'profile.update.handle', 'news.new', 'follow.follow', 'follow.unfollow', 'subscriptions.subscribe',
  'subscriptions.unsubscribe', 'spaces.start', 'spaces.end', 'broadcast.start', 'broadcast.end', 'broadcast.chat',
  'broadcast.chat.remove', 'chat.received', 'chat.sent', 'chat.conversation.join', 'chat.conversation_join',
  'chat.conversation.member_added', 'chat.conversation.member_removed', 'chat.conversation.admin_added',
  'chat.conversation.admin_removed', 'chat.update.group_name', 'chat.update.restrictions', 'dm.sent', 'dm.received',
  'dm.indicate_typing', 'dm.read', 'post.create', 'post.delete', 'post.mention.create', 'post.reply.create',
  'post.quote.create', 'post.repost.create', 'like.create', 'mute.mute', 'mute.unmute', 'block.block', 'block.unblock',
] as const;

const complianceFields = fields('Compliance job');

export const platformTools: ToolDefinition[] = [
  httpTool({
    name: 'TWITTER_CREATE_COMPLIANCE_JOB',
    title: 'Create a batch compliance job',
    description:
      'Creates a batch compliance job for post or user ids and returns its upload_url and download_url. App-only bearer token required. Uploading ids to upload_url is outside this tool.',
    scope,
    operationId: 'createComplianceJobs',
    method: 'POST',
    path: '/2/compliance/jobs',
    auth: APP_ONLY,
    input: {
      type: z.enum(['tweets', 'users']).describe('Kind of ids the job will check.'),
      name: z.string().max(64).optional().describe('Job name (max 64 characters).'),
      resumable: z.boolean().optional().describe('Enable resumable uploads for the upload_url.'),
    },
  }),
  httpTool({
    name: 'TWITTER_GET_COMPLIANCE_JOB',
    title: 'Get a compliance job',
    description: 'Returns one batch compliance job, including status and download_url. App-only bearer token required.',
    scope,
    operationId: 'getComplianceJobsById',
    method: 'GET',
    path: '/2/compliance/jobs/{id}',
    auth: APP_ONLY,
    input: { id: xId('Compliance job id'), compliance_job_fields: complianceFields },
  }),
  httpTool({
    name: 'TWITTER_GET_COMPLIANCE_JOBS',
    title: 'List compliance jobs',
    description: 'Lists batch compliance jobs of a type, optionally filtered by status. App-only bearer token required.',
    scope,
    operationId: 'getComplianceJobs',
    method: 'GET',
    path: '/2/compliance/jobs',
    auth: APP_ONLY,
    input: {
      type: z.enum(['tweets', 'users']).describe('Job type.'),
      status: z.enum(['created', 'in_progress', 'failed', 'complete']).optional().describe('Status filter (X enum; Composio\'s "expired" is not accepted by X).'),
      compliance_job_fields: complianceFields,
    },
  }),
  httpTool({
    name: 'TWITTER_GET_POST_ANALYTICS',
    title: 'Get post analytics',
    description:
      'Returns engagement analytics for up to 100 posts over a time range. Composio reports this requires an X Enterprise plan (403 otherwise); unverified.',
    scope,
    operationId: 'getPostsAnalytics',
    method: 'GET',
    path: '/2/tweets/analytics',
    auth: USER_CONTEXT,
    input: {
      ids: idList('Post ids'),
      start_time: timestamp('Range start').unwrap().describe('Range start as an RFC 3339 UTC timestamp.'),
      end_time: timestamp('Range end').unwrap().describe('Range end as an RFC 3339 UTC timestamp.'),
      granularity: z.enum(['hourly', 'daily', 'weekly', 'total']).optional().describe('Aggregation granularity (default total).'),
      'analytics.fields': fields('Analytics'),
    },
    check(args) {
      if (Date.parse(args.start_time) >= Date.parse(args.end_time)) throw invalidInput('start_time must be before end_time');
    },
  }),
  httpTool({
    name: 'TWITTER_GET_POST_USAGE',
    title: 'Get post usage',
    description: 'Returns post consumption for the project and its apps over 1-90 days. App-only bearer token required.',
    scope,
    operationId: 'getUsage',
    method: 'GET',
    path: '/2/usage/tweets',
    auth: APP_ONLY,
    input: {
      days: z.number().int().min(1).max(90).optional().describe('Days of usage to return (1-90, default 7).'),
      usage_fields: fields('Usage'),
    },
  }),
  customTool({
    name: 'TWITTER_STREAM_POST_LABELS',
    title: 'Read the post label stream',
    description:
      'Connects to the post label compliance stream, collects events for a bounded window (max_events / timeout_seconds), then disconnects. App-only bearer token required; Composio reports Enterprise access is needed.',
    scope,
    operationIds: ['streamLabelsCompliance'],
    auth: APP_ONLY,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    input: {
      backfill_minutes: z.number().int().min(0).max(5).optional().describe('Minutes of missed events to replay on connect (0-5).'),
      start_time: timestamp('Earliest event time'),
      end_time: timestamp('Time at which the stream closes'),
      max_events: z.number().int().min(1).max(1000).optional().describe('Stop after this many events (default 100). Extension, not a Composio parameter.'),
      timeout_seconds: z.number().int().min(1).max(60).optional().describe('Stop after this many seconds (default 10). Extension, not a Composio parameter.'),
    },
    async run(args, ctx) {
      const maxEvents = args.max_events ?? 100;
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), (args.timeout_seconds ?? 10) * 1000);
      const events: unknown[] = [];
      let stopped: 'max_events' | 'timeout' | 'stream_closed' = 'stream_closed';
      let authUsed: string | undefined;
      try {
        const query: Record<string, string | undefined> = {
          backfill_minutes: args.backfill_minutes?.toString(),
          start_time: args.start_time,
          end_time: args.end_time,
        };
        const { response, auth } = await ctx.client.openStream({
          method: 'GET',
          path: '/2/tweets/label/stream',
          query,
          auth: APP_ONLY,
          signal: controller.signal,
        });
        authUsed = auth;
        if (!response.body) throw new XApiError('unexpected_response', 'Stream response had no body');
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        try {
          while (events.length < maxEvents) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += value;
            let newline: number;
            while ((newline = buffer.indexOf('\n')) >= 0 && events.length < maxEvents) {
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1);
              if (!line) continue; // keep-alive
              try {
                events.push(JSON.parse(line));
              } catch {
                events.push({ unparsed: line.slice(0, 2000) });
              }
            }
          }
          if (events.length >= maxEvents) stopped = 'max_events';
        } catch (error) {
          if (!controller.signal.aborted) throw error;
          stopped = 'timeout';
        } finally {
          controller.abort();
          await reader.cancel().catch(() => undefined);
        }
      } catch (error) {
        if (!(error instanceof XApiError) && controller.signal.aborted && !ctx.signal?.aborted) {
          stopped = 'timeout';
        } else {
          throw error;
        }
      } finally {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
      }
      return { data: { events }, event_count: events.length, stopped, ...(authUsed ? { auth: authUsed } : {}) };
    },
  }),
  httpTool({
    name: 'TWITTER_CREATE_ACTIVITY_SUBSCRIPTION',
    title: 'Create an X Activity subscription',
    description:
      'Subscribes a webhook to an X Activity API event type, filtered by user_id and/or keyword. Event deliveries are billed per event.',
    scope,
    operationId: 'createActivitySubscription',
    method: 'POST',
    path: '/2/activity/subscriptions',
    auth: ['oauth2_user', 'oauth1_user', 'app_bearer'],
    input: {
      event_type: z.enum(ACTIVITY_EVENT_TYPES).describe('Activity event type in dot notation.'),
      filter: z
        .strictObject({
          user_id: xId('User the subscription is scoped to').optional(),
          keyword: z.string().min(1).optional().describe('Keyword filter.'),
          direction: z.enum(['inbound', 'outbound']).optional().describe('Direction filter for directional events.'),
        })
        .describe('Filter: at least one of user_id or keyword.'),
      tag: z.string().min(1).max(200).optional().describe('Caller-defined tag (1-200 characters).'),
      webhook_id: xId('Webhook id to deliver events to').optional(),
    },
    check(args) {
      if (args.filter.user_id === undefined && args.filter.keyword === undefined) {
        throw invalidInput('filter must include user_id or keyword');
      }
    },
  }),
  httpTool({
    name: 'TWITTER_LIST_CHAT_CONVERSATIONS',
    title: 'List X Chat conversations',
    description: "Lists one page of X Chat conversations in the authenticated user's inbox.",
    scope,
    operationId: 'getChatConversations',
    method: 'GET',
    path: '/2/chat/conversations',
    auth: USER_CONTEXT,
    input: {
      max_results: maxResults(1, 1000),
      pagination_token: paginationToken,
      expansions,
      user_fields: fields('User'),
      chat_conversation_fields: fields('Chat conversation'),
    },
  }),
  httpTool({
    name: 'TWITTER_GET_USER_PUBLIC_KEYS',
    title: "Get a user's public keys",
    description: "Returns a user's registered public keys for X Chat encryption.",
    scope,
    operationId: 'getUsersPublicKey',
    method: 'GET',
    path: '/2/users/{id}/public_keys',
    auth: USER_CONTEXT,
    input: { id: xId('User id'), public_key_fields: fields('Public key') },
  }),
  httpTool({
    name: 'TWITTER_SEARCH_NEWS',
    title: 'Search X news',
    description: 'Searches X news stories matching text.',
    scope,
    operationId: 'searchNews',
    method: 'GET',
    path: '/2/news/search',
    auth: ['oauth2_user', 'oauth1_user', 'app_bearer'],
    input: {
      query: z.string().min(1).max(2048).describe('Text to match in news stories.'),
      max_results: maxResults(1, 100),
      max_age_hours: z.number().int().min(1).max(720).optional().describe('Maximum story age in hours (1-720, default 168).'),
      news_fields: fields('News'),
    },
  }),
  httpTool({
    name: 'TWITTER_GET_OPENAPI_SPEC',
    title: 'Get the X API OpenAPI spec',
    description: 'Fetches the X API v2 OpenAPI document (large, about 1.3 MB). No authentication required.',
    scope,
    operationId: 'getOpenApiSpec',
    method: 'GET',
    path: '/2/openapi.json',
    auth: [],
    input: {},
  }),
];
