import { APPEND_CHUNK_BYTES } from '../../src/tools/spaces-media.js';
import { TEST_SECRETS } from '../helpers.js';
import type { ContractCase } from './types.js';

const SPACE = '1DXxyRYNejbKM';
const MEDIA = '1880028106020515840';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64');
const VIDEO_BYTES = APPEND_CHUNK_BYTES + 10;
const VIDEO = Buffer.alloc(VIDEO_BYTES, 7).toString('base64');
const bearer = { X_BEARER_TOKEN: TEST_SECRETS.X_BEARER_TOKEN };

export const spacesMediaCases: ContractCase[] = [
  {
    tool: 'TWITTER_GET_SPACE_BY_ID',
    args: { id: SPACE, space_fields: ['title', 'state'], expansions: ['creator_id'], topic_fields: ['name'] },
    calls: [{ method: 'GET', path: `/2/spaces/${SPACE}`, query: { 'space.fields': 'title,state', expansions: 'creator_id', 'topic.fields': 'name' } }],
  },
  {
    tool: 'TWITTER_GET_SPACES_BY_IDS',
    env: bearer,
    args: { ids: [SPACE, '1YpKkgVgjMgJj'] },
    calls: [{ method: 'GET', path: '/2/spaces', query: { ids: `${SPACE},1YpKkgVgjMgJj` }, auth: 'app_bearer' }],
  },
  {
    tool: 'TWITTER_GET_SPACES_BY_CREATORS',
    args: { user_ids: ['2244994945', '6253282'], user_fields: ['username'] },
    calls: [{ method: 'GET', path: '/2/spaces/by/creator_ids', query: { user_ids: '2244994945,6253282', 'user.fields': 'username' } }],
  },
  {
    tool: 'TWITTER_SEARCH_SPACES',
    args: { query: 'hello', state: 'live', max_results: 25 },
    calls: [{ method: 'GET', path: '/2/spaces/search', query: { query: 'hello', state: 'live', max_results: '25' } }],
  },
  {
    tool: 'TWITTER_GET_SPACE_POSTS',
    args: { id: SPACE, max_results: 10, tweet_fields: ['author_id'] },
    calls: [{ method: 'GET', path: `/2/spaces/${SPACE}/tweets`, query: { max_results: '10', 'tweet.fields': 'author_id' } }],
  },
  {
    tool: 'TWITTER_GET_SPACE_TICKET_BUYERS',
    args: { id: SPACE, pagination_token: 'abcdefghijklmnopq' },
    calls: [{ method: 'GET', path: `/2/spaces/${SPACE}/buyers`, query: { pagination_token: 'abcdefghijklmnopq' } }],
  },
  {
    tool: 'TWITTER_UPLOAD_MEDIA',
    label: 'image, category inferred',
    args: { media: { base64: PNG, filename: 'pixel.png' }, additional_owners: ['2244994945', '6253282'] },
    calls: [
      {
        method: 'POST',
        path: '/2/media/upload',
        body: { media: PNG, media_category: 'tweet_image', additional_owners: '2244994945,6253282' },
      },
    ],
    replies: [{ body: { data: { id: MEDIA, media_key: `3_${MEDIA}`, size: 12, expires_after_secs: 86400 } } }],
  },
  {
    tool: 'TWITTER_UPLOAD_MEDIA',
    label: 'subtitles via media_type, OAuth 1.0a',
    env: { X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_TOKEN_SECRET: 'ts' },
    args: { media: { base64: Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nhi\n').toString('base64') }, media_type: 'text/srt' },
    calls: [
      {
        method: 'POST',
        path: '/2/media/upload',
        body: { media: Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nhi\n').toString('base64'), media_category: 'subtitles' },
        auth: 'oauth1_user',
      },
    ],
  },
  {
    tool: 'TWITTER_UPLOAD_LARGE_MEDIA',
    label: 'video lifecycle with processing poll',
    args: { media: { base64: VIDEO, mime_type: 'video/mp4' }, shared: false },
    calls: [
      { method: 'POST', path: '/2/media/upload/initialize', body: { media_type: 'video/mp4', total_bytes: VIDEO_BYTES, media_category: 'tweet_video', shared: false } },
      { method: 'POST', path: `/2/media/upload/${MEDIA}/append`, multipart: { segment_index: '0', media: { bytes: APPEND_CHUNK_BYTES } } },
      { method: 'POST', path: `/2/media/upload/${MEDIA}/append`, multipart: { segment_index: '1', media: { bytes: 10 } } },
      { method: 'POST', path: `/2/media/upload/${MEDIA}/finalize` },
      { method: 'GET', path: '/2/media/upload', query: { media_id: MEDIA, command: 'STATUS' } },
    ],
    replies: [
      { body: { data: { id: MEDIA, media_key: `7_${MEDIA}`, expires_after_secs: 86400 } } },
      { body: { data: { expires_at: 1_800_086_400 } } },
      { body: { data: { expires_at: 1_800_086_400 } } },
      { body: { data: { id: MEDIA, processing_info: { state: 'pending', check_after_secs: 2 } } } },
      { body: { data: { id: MEDIA, processing_info: { state: 'succeeded', progress_percent: 100 } } } },
    ],
    verify(s) {
      if (s.media_id !== MEDIA || s.segments !== 2 || s.status_polls !== 1 || s.media_category !== 'tweet_video') {
        throw new Error(`unexpected summary ${JSON.stringify({ ...s, data: undefined })}`);
      }
      const state = (s.data as { data: { processing_info: { state: string } } }).data.processing_info.state;
      if (state !== 'succeeded') throw new Error('final status not returned');
    },
  },
  {
    tool: 'TWITTER_INITIALIZE_MEDIA_UPLOAD',
    args: { media_type: 'video/mp4', total_bytes: 1048576, media_category: 'amplify_video', shared: true, additional_owners: ['6253282'] },
    calls: [
      {
        method: 'POST',
        path: '/2/media/upload/initialize',
        body: { media_type: 'video/mp4', total_bytes: 1048576, media_category: 'amplify_video', shared: true, additional_owners: ['6253282'] },
      },
    ],
  },
  {
    tool: 'TWITTER_APPEND_MEDIA_UPLOAD',
    args: { id: MEDIA, media: Buffer.from('chunk-bytes').toString('base64'), segment_index: 3 },
    calls: [{ method: 'POST', path: `/2/media/upload/${MEDIA}/append`, multipart: { segment_index: '3', media: { bytes: 11 } } }],
    verify(s) {
      if (s.media_id !== MEDIA || s.segment_index !== 3 || s.bytes !== 11) throw new Error('append summary missing');
    },
  },
  {
    tool: 'X_FINALIZE_MEDIA_UPLOAD',
    args: { id: MEDIA },
    calls: [{ method: 'POST', path: `/2/media/upload/${MEDIA}/finalize` }],
  },
  {
    tool: 'TWITTER_GET_MEDIA_UPLOAD_STATUS',
    args: { media_id: MEDIA },
    calls: [{ method: 'GET', path: '/2/media/upload', query: { media_id: MEDIA, command: 'STATUS' } }],
  },
];
