import type { ContractCase } from './types.js';
import { TEST_SECRETS } from '../helpers.js';

const L = '1441162269824405510';
const U = '2244994945';
const T = '1460323737035677698';

export const listsRelationshipsCases: ContractCase[] = [
  {
    tool: 'TWITTER_CREATE_LIST',
    args: { name: 'test v2 create list', description: 'list for testing', private: false },
    calls: [{ method: 'POST', path: '/2/lists', body: { name: 'test v2 create list', description: 'list for testing', private: false } }],
    replies: [{ body: { data: { id: L, name: 'test v2 create list' } } }],
  },
  {
    tool: 'TWITTER_UPDATE_LIST',
    args: { id: L, private: true },
    calls: [{ method: 'PUT', path: `/2/lists/${L}`, body: { private: true } }],
    replies: [{ body: { data: { updated: true } } }],
  },
  { tool: 'TWITTER_DELETE_LIST', args: { id: L }, calls: [{ method: 'DELETE', path: `/2/lists/${L}` }], replies: [{ body: { data: { deleted: true } } }] },
  {
    tool: 'TWITTER_GET_LIST',
    args: { id: L, list_fields: ['owner_id', 'member_count'], expansions: ['owner_id'], user_fields: ['username'] },
    calls: [{ method: 'GET', path: `/2/lists/${L}`, query: { 'list.fields': 'owner_id,member_count', expansions: 'owner_id', 'user.fields': 'username' } }],
  },
  {
    tool: 'TWITTER_GET_LIST_MEMBERS',
    args: { id: L, max_results: 100, pagination_token: 'abcdefghijklmnop', tweet_fields: ['created_at'] },
    calls: [{ method: 'GET', path: `/2/lists/${L}/members`, query: { max_results: '100', pagination_token: 'abcdefghijklmnop', 'tweet.fields': 'created_at' } }],
  },
  {
    tool: 'TWITTER_GET_LIST_FOLLOWERS',
    env: { X_BEARER_TOKEN: TEST_SECRETS.X_BEARER_TOKEN },
    args: { id: L },
    calls: [{ method: 'GET', path: `/2/lists/${L}/followers`, auth: 'app_bearer' }],
  },
  {
    tool: 'TWITTER_LIST_POSTS_TIMELINE_BY_LIST_ID',
    args: { id: L, max_results: 10, expansions: ['author_id'], poll_fields: ['options'] },
    calls: [{ method: 'GET', path: `/2/lists/${L}/tweets`, query: { max_results: '10', expansions: 'author_id', 'poll.fields': 'options' } }],
  },
  {
    tool: 'TWITTER_ADD_LIST_MEMBER',
    args: { id: L, user_id: U },
    calls: [{ method: 'POST', path: `/2/lists/${L}/members`, body: { user_id: U } }],
    replies: [{ body: { data: { is_member: true } } }],
  },
  {
    tool: 'TWITTER_REMOVE_LIST_MEMBER',
    args: { id: L, user_id: U },
    calls: [{ method: 'DELETE', path: `/2/lists/${L}/members/${U}` }],
    replies: [{ body: { data: { is_member: false } } }],
  },
  {
    tool: 'TWITTER_FOLLOW_LIST',
    args: { id: U, list_id: L },
    calls: [{ method: 'POST', path: `/2/users/${U}/followed_lists`, body: { list_id: L } }],
    replies: [{ body: { data: { following: true } } }],
  },
  { tool: 'TWITTER_UNFOLLOW_LIST', args: { id: U, list_id: L }, calls: [{ method: 'DELETE', path: `/2/users/${U}/followed_lists/${L}` }] },
  {
    tool: 'TWITTER_PIN_LIST',
    args: { id: U, list_id: L },
    calls: [{ method: 'POST', path: `/2/users/${U}/pinned_lists`, body: { list_id: L } }],
    replies: [{ body: { data: { pinned: true } } }],
  },
  { tool: 'TWITTER_UNPIN_LIST', args: { list_id: L }, me: U, calls: [{ method: 'DELETE', path: `/2/users/${U}/pinned_lists/${L}` }] },
  {
    tool: 'TWITTER_GET_USER_OWNED_LISTS',
    args: { id: U, max_results: 50, list_fields: ['follower_count'] },
    calls: [{ method: 'GET', path: `/2/users/${U}/owned_lists`, query: { max_results: '50', 'list.fields': 'follower_count' } }],
  },
  {
    tool: 'TWITTER_GET_USER_FOLLOWED_LISTS',
    args: { id: U, pagination_token: 'abc' },
    calls: [{ method: 'GET', path: `/2/users/${U}/followed_lists`, query: { pagination_token: 'abc' } }],
  },
  {
    tool: 'TWITTER_GET_USER_LIST_MEMBERSHIPS',
    args: { id: U, expansions: ['owner_id'] },
    calls: [{ method: 'GET', path: `/2/users/${U}/list_memberships`, query: { expansions: 'owner_id' } }],
  },
  {
    tool: 'TWITTER_GET_USER_PINNED_LISTS',
    args: { id: U, list_fields: ['private'] },
    calls: [{ method: 'GET', path: `/2/users/${U}/pinned_lists`, query: { 'list.fields': 'private' } }],
  },
  {
    tool: 'TWITTER_BOOKMARKS_BY_USER',
    label: 'default me, Composio-internal field ignored',
    args: { max_results: 10, composio_execution_message: 'ignore me', tweet_fields: ['created_at'] },
    me: U,
    calls: [{ method: 'GET', path: `/2/users/${U}/bookmarks`, query: { max_results: '10', 'tweet.fields': 'created_at' } }],
  },
  {
    tool: 'TWITTER_ADD_POST_TO_BOOKMARKS',
    args: { id: U, tweet_id: T },
    calls: [{ method: 'POST', path: `/2/users/${U}/bookmarks`, body: { tweet_id: T } }],
    replies: [{ body: { data: { bookmarked: true } } }],
  },
  { tool: 'TWITTER_REMOVE_POST_FROM_BOOKMARKS', args: { id: U, tweet_id: T }, calls: [{ method: 'DELETE', path: `/2/users/${U}/bookmarks/${T}` }] },
  {
    tool: 'TWITTER_FOLLOW_USER',
    args: { target_user_id: '6253282' },
    me: U,
    calls: [{ method: 'POST', path: `/2/users/${U}/following`, body: { target_user_id: '6253282' } }],
    replies: [{ body: { data: { following: true, pending_follow: false } } }],
  },
  {
    tool: 'TWITTER_UNFOLLOW_USER',
    args: { source_user_id: U, target_user_id: '6253282' },
    calls: [{ method: 'DELETE', path: `/2/users/${U}/following/6253282` }],
  },
  {
    tool: 'TWITTER_FOLLOWERS_BY_USER_ID',
    args: { id: U, max_results: 1000, user_fields: ['created_at'] },
    calls: [{ method: 'GET', path: `/2/users/${U}/followers`, query: { max_results: '1000', 'user.fields': 'created_at' } }],
  },
  {
    tool: 'TWITTER_FOLLOWING_BY_USER_ID',
    args: { id: U, pagination_token: 'tok' },
    calls: [{ method: 'GET', path: `/2/users/${U}/following`, query: { pagination_token: 'tok' } }],
  },
  {
    tool: 'TWITTER_MUTE_USER',
    args: { id: U, target_user_id: '6253282' },
    calls: [{ method: 'POST', path: `/2/users/${U}/muting`, body: { target_user_id: '6253282' } }],
    replies: [{ body: { data: { muting: true } } }],
  },
  { tool: 'TWITTER_UNMUTE_USER', args: { target_user_id: '6253282' }, me: U, calls: [{ method: 'DELETE', path: `/2/users/${U}/muting/6253282` }] },
  {
    tool: 'TWITTER_GET_MUTED_USERS',
    args: { id: U, max_results: 1 },
    calls: [{ method: 'GET', path: `/2/users/${U}/muting`, query: { max_results: '1' } }],
  },
  {
    tool: 'TWITTER_GET_BLOCKED_USERS',
    env: { X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_TOKEN_SECRET: 'ts' },
    args: { id: U },
    calls: [{ method: 'GET', path: `/2/users/${U}/blocking`, auth: 'oauth1_user' }],
  },
];
