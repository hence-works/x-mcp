import { TEST_SECRETS } from '../helpers.js';
import type { ContractCase } from './types.js';

const fieldsArgs = {
  expansions: ['author_id', 'attachments.media_keys'],
  tweet_fields: ['created_at', 'public_metrics'],
  user_fields: ['username'],
  media_fields: ['url'],
  place_fields: ['full_name'],
  poll_fields: ['options'],
};
const fieldsQuery = {
  expansions: 'author_id,attachments.media_keys',
  'tweet.fields': 'created_at,public_metrics',
  'user.fields': 'username',
  'media.fields': 'url',
  'place.fields': 'full_name',
  'poll.fields': 'options',
};

export const postsUsersCases: ContractCase[] = [
  {
    tool: 'TWITTER_CREATION_OF_A_POST',
    label: 'reply with media',
    args: {
      text: 'hello',
      reply_settings: 'following',
      media_media_ids: ['1455952740635586573'],
      media_tagged_user_ids: ['2244994945'],
      reply_in_reply_to_tweet_id: '1460323737035677698',
      reply_exclude_reply_user_ids: ['6253282'],
      geo_place_id: 'df51dec6f4ee2b2c',
      for_super_followers_only: false,
    },
    calls: [
      {
        method: 'POST',
        path: '/2/tweets',
        body: {
          text: 'hello',
          reply_settings: 'following',
          media: { media_ids: ['1455952740635586573'], tagged_user_ids: ['2244994945'] },
          reply: { in_reply_to_tweet_id: '1460323737035677698', exclude_reply_user_ids: ['6253282'] },
          geo: { place_id: 'df51dec6f4ee2b2c' },
          for_super_followers_only: false,
        },
      },
    ],
    replies: [{ status: 201, body: { data: { id: '1445880548472328192', text: 'hello', edit_history_tweet_ids: ['1445880548472328192'] } } }],
  },
  {
    tool: 'TWITTER_CREATION_OF_A_POST',
    label: 'poll',
    args: { text: 'Pick one', poll_options: ['a', 'b'], poll_duration_minutes: 60, poll_reply_settings: 'following' },
    calls: [
      {
        method: 'POST',
        path: '/2/tweets',
        body: { text: 'Pick one', poll: { options: ['a', 'b'], duration_minutes: 60, reply_settings: 'following' } },
      },
    ],
  },
  {
    tool: 'TWITTER_CREATION_OF_A_POST',
    label: 'OAuth 1.0a only',
    env: {
      X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_TOKEN_SECRET: 'ts',
    },
    args: { text: 'quote', quote_tweet_id: '1409931481552543749' },
    calls: [{ method: 'POST', path: '/2/tweets', body: { text: 'quote', quote_tweet_id: '1409931481552543749' }, auth: 'oauth1_user' }],
  },
  {
    tool: 'TWITTER_POST_DELETE_BY_POST_ID',
    args: { id: '1228393702244134912' },
    calls: [{ method: 'DELETE', path: '/2/tweets/1228393702244134912' }],
    replies: [{ body: { data: { deleted: true } } }],
  },
  {
    tool: 'TWITTER_POST_LOOKUP_BY_POST_ID',
    args: { id: '1228393702244134912', ...fieldsArgs },
    calls: [{ method: 'GET', path: '/2/tweets/1228393702244134912', query: fieldsQuery }],
  },
  {
    tool: 'TWITTER_POST_LOOKUP_BY_POST_IDS',
    args: { ids: ['1228393702244134912', '1227640996038684673'], tweet_fields: ['lang'] },
    calls: [{ method: 'GET', path: '/2/tweets', query: { ids: '1228393702244134912,1227640996038684673', 'tweet.fields': 'lang' } }],
  },
  {
    tool: 'TWITTER_RECENT_SEARCH',
    args: {
      query: 'from:XDevelopers -is:retweet',
      start_time: '2026-11-01T00:00:00Z',
      end_time: '2026-11-06T00:00:00Z',
      max_results: 50,
      sort_order: 'recency',
      next_token: 'b26v89c19zqg8o3fpzbkk',
      ...fieldsArgs,
    },
    calls: [
      {
        method: 'GET',
        path: '/2/tweets/search/recent',
        query: {
          query: 'from:XDevelopers -is:retweet',
          start_time: '2026-11-01T00:00:00Z',
          end_time: '2026-11-06T00:00:00Z',
          max_results: '50',
          sort_order: 'recency',
          next_token: 'b26v89c19zqg8o3fpzbkk',
          ...fieldsQuery,
        },
      },
    ],
    replies: [{ body: { data: [{ id: '1', text: 't' }], meta: { result_count: 1, next_token: 'b26v89c19zqg8o3fpzbkm', newest_id: '1', oldest_id: '1' } } }],
    verify(s) {
      if ((s.pagination as { next_token?: string })?.next_token !== 'b26v89c19zqg8o3fpzbkm') throw new Error('next_token not surfaced');
    },
  },
  {
    tool: 'TWITTER_RECENT_SEARCH',
    label: 'app-only fallback',
    env: { X_BEARER_TOKEN: TEST_SECRETS.X_BEARER_TOKEN },
    args: { query: 'x', since_id: '1', until_id: '99' },
    calls: [{ method: 'GET', path: '/2/tweets/search/recent', query: { query: 'x', since_id: '1', until_id: '99' }, auth: 'app_bearer' }],
  },
  {
    tool: 'TWITTER_FULL_ARCHIVE_SEARCH',
    args: { query: 'conference', max_results: 500, pagination_token: 'abc123' },
    calls: [{ method: 'GET', path: '/2/tweets/search/all', query: { query: 'conference', max_results: '500', pagination_token: 'abc123' } }],
  },
  {
    tool: 'TWITTER_SEARCH_RECENT_COUNTS',
    args: { query: 'lakers', granularity: 'day', search_count_fields: ['tweet_count'] },
    calls: [{ method: 'GET', path: '/2/tweets/counts/recent', query: { query: 'lakers', granularity: 'day', 'search_count.fields': 'tweet_count' } }],
  },
  {
    tool: 'TWITTER_SEARCH_FULL_ARCHIVE_COUNTS',
    args: { query: 'lakers', start_time: '2020-01-01T00:00:00Z', granularity: 'hour' },
    calls: [
      { method: 'GET', path: '/2/tweets/counts/all', query: { query: 'lakers', start_time: '2020-01-01T00:00:00Z', granularity: 'hour' }, auth: 'app_bearer' },
    ],
  },
  {
    tool: 'TWITTER_GET_USER_POSTS',
    args: { id: '2244994945', exclude: ['replies', 'retweets'], max_results: 5, pagination_token: 'tok', tweet_fields: ['created_at'] },
    calls: [
      {
        method: 'GET',
        path: '/2/users/2244994945/tweets',
        query: { exclude: 'replies,retweets', max_results: '5', pagination_token: 'tok', 'tweet.fields': 'created_at' },
      },
    ],
  },
  {
    tool: 'TWITTER_GET_USER_MENTIONS',
    args: { id: '2244994945', since_id: '1', max_results: 100 },
    calls: [{ method: 'GET', path: '/2/users/2244994945/mentions', query: { since_id: '1', max_results: '100' } }],
  },
  {
    tool: 'TWITTER_USER_HOME_TIMELINE_BY_USER_ID',
    label: 'id resolved from /2/users/me',
    args: { max_results: 20 },
    me: '2244994945',
    calls: [{ method: 'GET', path: '/2/users/2244994945/timelines/reverse_chronological', query: { max_results: '20' } }],
  },
  {
    tool: 'TWITTER_USER_HOME_TIMELINE_BY_USER_ID',
    label: 'explicit id',
    args: { id: '2244994945', exclude: ['replies'] },
    calls: [{ method: 'GET', path: '/2/users/2244994945/timelines/reverse_chronological', query: { exclude: 'replies' } }],
  },
  {
    tool: 'TWITTER_RETRIEVE_POSTS_THAT_QUOTE_A_POST',
    args: { id: '1409931481552543749', max_results: 10, exclude: ['retweets'] },
    calls: [{ method: 'GET', path: '/2/tweets/1409931481552543749/quote_tweets', query: { max_results: '10', exclude: 'retweets' } }],
  },
  {
    tool: 'TWITTER_GET_POST_RETWEETS',
    args: { id: '1409931481552543749', max_results: 100 },
    calls: [{ method: 'GET', path: '/2/tweets/1409931481552543749/retweets', query: { max_results: '100' } }],
  },
  {
    tool: 'TWITTER_GET_POST_RETWEETERS_ACTION',
    args: { id: '1409931481552543749', user_fields: ['created_at'], pagination_token: 'abc' },
    calls: [{ method: 'GET', path: '/2/tweets/1409931481552543749/retweeted_by', query: { 'user.fields': 'created_at', pagination_token: 'abc' } }],
  },
  {
    tool: 'TWITTER_LIST_POST_LIKERS',
    args: { id: '1409931481552543749', max_results: 1 },
    calls: [{ method: 'GET', path: '/2/tweets/1409931481552543749/liking_users', query: { max_results: '1' } }],
  },
  {
    tool: 'TWITTER_RETURNS_POST_OBJECTS_LIKED_BY_THE_PROVIDED_USER_ID',
    args: { id: '2244994945', max_results: 5, expansions: ['author_id'] },
    calls: [{ method: 'GET', path: '/2/users/2244994945/liked_tweets', query: { max_results: '5', expansions: 'author_id' } }],
  },
  {
    tool: 'TWITTER_USER_LIKE_POST',
    args: { id: '2244994945', tweet_id: '1228393702244134912' },
    calls: [{ method: 'POST', path: '/2/users/2244994945/likes', body: { tweet_id: '1228393702244134912' } }],
    replies: [{ body: { data: { liked: true } } }],
  },
  {
    tool: 'TWITTER_UNLIKE_POST',
    args: { id: '2244994945', tweet_id: '1228393702244134912' },
    calls: [{ method: 'DELETE', path: '/2/users/2244994945/likes/1228393702244134912' }],
    replies: [{ body: { data: { liked: false } } }],
  },
  {
    tool: 'TWITTER_RETWEET_POST',
    args: { tweet_id: '1228393702244134912' },
    me: '2244994945',
    calls: [{ method: 'POST', path: '/2/users/2244994945/retweets', body: { tweet_id: '1228393702244134912' } }],
    replies: [{ body: { data: { retweeted: true } } }],
  },
  {
    tool: 'TWITTER_UNRETWEET_POST',
    args: { id: '2244994945', source_tweet_id: '1228393702244134912' },
    calls: [{ method: 'DELETE', path: '/2/users/2244994945/retweets/1228393702244134912' }],
    replies: [{ body: { data: { retweeted: false } } }],
  },
  {
    tool: 'TWITTER_UNRETWEET_POST',
    label: 'id "me"',
    args: { id: 'me', source_tweet_id: '1228393702244134912' },
    me: '42',
    calls: [{ method: 'DELETE', path: '/2/users/42/retweets/1228393702244134912' }],
  },
  {
    tool: 'TWITTER_HIDE_REPLIES',
    args: { tweet_id: '1232720193182412800', hidden: true },
    calls: [{ method: 'PUT', path: '/2/tweets/1232720193182412800/hidden', body: { hidden: true } }],
    replies: [{ body: { data: { hidden: true } } }],
  },
  {
    tool: 'TWITTER_GET_USER_BY_ID',
    args: { id: '2244994945', user_fields: ['description'], expansions: ['pinned_tweet_id'], tweet_fields: ['lang'] },
    calls: [
      { method: 'GET', path: '/2/users/2244994945', query: { 'user.fields': 'description', expansions: 'pinned_tweet_id', 'tweet.fields': 'lang' } },
    ],
  },
  {
    tool: 'TWITTER_GET_USERS_BY_IDS',
    args: { ids: ['2244994945', '6253282'] },
    calls: [{ method: 'GET', path: '/2/users', query: { ids: '2244994945,6253282' } }],
  },
  {
    tool: 'TWITTER_USER_LOOKUP_BY_USERNAME',
    args: { username: 'XDevelopers' },
    calls: [{ method: 'GET', path: '/2/users/by/username/XDevelopers' }],
  },
  {
    tool: 'TWITTER_USER_LOOKUP_BY_USERNAMES',
    args: { usernames: ['XDevelopers', 'X'], user_fields: ['verified'] },
    calls: [{ method: 'GET', path: '/2/users/by', query: { usernames: 'XDevelopers,X', 'user.fields': 'verified' } }],
  },
  {
    tool: 'TWITTER_USER_LOOKUP_ME',
    args: { user_fields: ['created_at'] },
    calls: [{ method: 'GET', path: '/2/users/me', query: { 'user.fields': 'created_at' } }],
  },
];
