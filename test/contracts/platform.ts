import { TEST_SECRETS } from '../helpers.js';
import type { ContractCase } from './types.js';

const bearer = { X_BEARER_TOKEN: TEST_SECRETS.X_BEARER_TOKEN };
const JOB = '1382081613278814209';

export const platformCases: ContractCase[] = [
  {
    tool: 'TWITTER_CREATE_COMPLIANCE_JOB',
    env: bearer,
    args: { type: 'tweets', name: 'my batch tweets job', resumable: false },
    calls: [{ method: 'POST', path: '/2/compliance/jobs', body: { type: 'tweets', name: 'my batch tweets job', resumable: false }, auth: 'app_bearer' }],
    replies: [{ body: { data: { id: JOB, type: 'tweets', status: 'created', upload_url: 'https://storage.googleapis.com/x', download_url: 'https://storage.googleapis.com/y' } } }],
  },
  {
    tool: 'TWITTER_GET_COMPLIANCE_JOB',
    env: bearer,
    args: { id: JOB, compliance_job_fields: ['status', 'download_url'] },
    calls: [{ method: 'GET', path: `/2/compliance/jobs/${JOB}`, query: { 'compliance_job.fields': 'status,download_url' }, auth: 'app_bearer' }],
  },
  {
    tool: 'TWITTER_GET_COMPLIANCE_JOBS',
    args: { type: 'users', status: 'complete' },
    calls: [{ method: 'GET', path: '/2/compliance/jobs', query: { type: 'users', status: 'complete' }, auth: 'app_bearer' }],
  },
  {
    tool: 'TWITTER_GET_POST_ANALYTICS',
    args: {
      ids: ['1228393702244134912'],
      start_time: '2026-10-01T00:00:00Z',
      end_time: '2026-10-08T00:00:00Z',
      granularity: 'daily',
      'analytics.fields': ['impressions', 'likes'],
    },
    calls: [
      {
        method: 'GET',
        path: '/2/tweets/analytics',
        query: {
          ids: '1228393702244134912',
          start_time: '2026-10-01T00:00:00Z',
          end_time: '2026-10-08T00:00:00Z',
          granularity: 'daily',
          'analytics.fields': 'impressions,likes',
        },
      },
    ],
  },
  {
    tool: 'TWITTER_GET_POST_USAGE',
    args: { days: 30, usage_fields: ['project_usage', 'cap_reset_day'] },
    calls: [{ method: 'GET', path: '/2/usage/tweets', query: { days: '30', 'usage.fields': 'project_usage,cap_reset_day' }, auth: 'app_bearer' }],
  },
  {
    tool: 'TWITTER_STREAM_POST_LABELS',
    args: { backfill_minutes: 2, max_events: 2 },
    calls: [{ method: 'GET', path: '/2/tweets/label/stream', query: { backfill_minutes: '2' }, auth: 'app_bearer' }],
    replies: [
      {
        body:
          '{"data":{"event_type":"PublicTweetNotice","tweet_id":"1"}}\r\n\r\n' +
          '{"data":{"event_type":"PublicTweetUnviewable","tweet_id":"2"}}\r\n' +
          '{"data":{"event_type":"PublicTweetNotice","tweet_id":"3"}}\r\n',
      },
    ],
    verify(s) {
      const events = (s.data as { events: { data: { tweet_id: string } }[] }).events;
      if (s.event_count !== 2 || s.stopped !== 'max_events' || events[1]!.data.tweet_id !== '2') {
        throw new Error(`unexpected stream result ${JSON.stringify(s)}`);
      }
    },
  },
  {
    tool: 'TWITTER_CREATE_ACTIVITY_SUBSCRIPTION',
    args: { event_type: 'follow.follow', filter: { user_id: '2244994945' }, tag: 'xdevs follows', webhook_id: '1146654567674912769' },
    calls: [
      {
        method: 'POST',
        path: '/2/activity/subscriptions',
        body: { event_type: 'follow.follow', filter: { user_id: '2244994945' }, tag: 'xdevs follows', webhook_id: '1146654567674912769' },
      },
    ],
  },
  {
    tool: 'TWITTER_LIST_CHAT_CONVERSATIONS',
    args: { max_results: 50, chat_conversation_fields: ['id', 'type'], expansions: ['participant_ids'] },
    calls: [{ method: 'GET', path: '/2/chat/conversations', query: { max_results: '50', 'chat_conversation.fields': 'id,type', expansions: 'participant_ids' } }],
  },
  {
    tool: 'TWITTER_GET_USER_PUBLIC_KEYS',
    args: { id: '2244994945', public_key_fields: ['public_key'] },
    calls: [{ method: 'GET', path: '/2/users/2244994945/public_keys', query: { 'public_key.fields': 'public_key' } }],
  },
  {
    tool: 'TWITTER_SEARCH_NEWS',
    env: bearer,
    args: { query: 'space launch', max_results: 5, max_age_hours: 24, news_fields: ['name', 'summary'] },
    calls: [
      { method: 'GET', path: '/2/news/search', query: { query: 'space launch', max_results: '5', max_age_hours: '24', 'news.fields': 'name,summary' }, auth: 'app_bearer' },
    ],
  },
  {
    tool: 'TWITTER_GET_OPENAPI_SPEC',
    args: {},
    calls: [{ method: 'GET', path: '/2/openapi.json', auth: 'none' }],
    replies: [{ body: { openapi: '3.0.0', info: { title: 'X API v2', version: '2.174' }, paths: {} } }],
  },
];
