import { z } from 'zod';
import { invalidInput } from '../x/errors.js';
import { httpTool, type ToolDefinition } from './framework.js';
import {
  expansions,
  fields,
  idList,
  maxResults,
  meId,
  paginationToken,
  postExpansionFields,
  searchQuery,
  timeBounds,
  userExpansionFields,
  xId,
} from './schemas.js';

const USER_CONTEXT = ['oauth2_user', 'oauth1_user'] as const;
const ANY_AUTH = ['oauth2_user', 'oauth1_user', 'app_bearer'] as const;
const scope = 'posts-users' as const;

const replySettings = z.enum(['following', 'mentionedUsers', 'subscribers', 'verified']);
const excludeTypes = z
  .array(z.enum(['replies', 'retweets']))
  .min(1)
  .optional()
  .describe('Post types to exclude.');

/**
 * Composio documents that time bounds and id bounds cannot be combined for recent search and
 * full-archive counts (the X spec does not state it), so only those two tools enforce it.
 */
function checkExclusiveBounds(args: { start_time?: string; end_time?: string; since_id?: string; until_id?: string }) {
  const hasTime = args.start_time !== undefined || args.end_time !== undefined;
  const hasId = args.since_id !== undefined || args.until_id !== undefined;
  if (hasTime && hasId) throw invalidInput('start_time/end_time cannot be combined with since_id/until_id');
}

const searchShape = (maxLimit: number) => ({
  query: searchQuery(4096),
  ...timeBounds,
  max_results: maxResults(10, maxLimit),
  next_token: paginationToken,
  pagination_token: paginationToken,
  sort_order: z.enum(['recency', 'relevancy']).optional().describe('Result ordering.'),
  ...postExpansionFields,
});

const countsShape = {
  query: searchQuery(4096),
  ...timeBounds,
  granularity: z.enum(['minute', 'hour', 'day']).optional().describe('Count bucket size (default hour).'),
  next_token: paginationToken,
  pagination_token: paginationToken,
  search_count_fields: fields('Search count'),
};

const userListShape = (max: number) => ({
  id: xId('Post id'),
  max_results: maxResults(1, max),
  pagination_token: paginationToken,
  ...userExpansionFields,
});

export const postTools: ToolDefinition[] = [
  httpTool({
    name: 'TWITTER_CREATION_OF_A_POST',
    title: 'Create a post',
    description:
      'Publishes a post (tweet) for the authenticated user: text, reply, quote, poll, media (upload first and pass media ids), place, or reply settings. Creates real public content and is billable; never retried automatically.',
    scope,
    operationId: 'createPosts',
    method: 'POST',
    path: '/2/tweets',
    auth: USER_CONTEXT,
    input: {
      text: z.string().max(25_000).optional().describe('Post text. Required unless media, a poll, a quote or a card is provided.'),
      card_uri: z.string().min(1).optional().describe('Card URI to attach (mutually exclusive with media, poll and quote).'),
      nullcast: z.boolean().optional().describe('Promoted-only post that does not appear on the public timeline.'),
      geo_place_id: z.string().min(1).optional().describe('Place id to tag.'),
      poll_options: z.array(z.string().min(1).max(25)).min(2).max(4).optional().describe('Poll choices (2-4, 1-25 characters each).'),
      poll_duration_minutes: z.number().int().min(5).max(10_080).optional().describe('Poll duration in minutes (5-10080).'),
      poll_reply_settings: replySettings
        .optional()
        .describe('Poll reply settings. The X spec states this is accepted but dropped before the post is created.'),
      quote_tweet_id: xId('Post id to quote').optional(),
      reply_settings: replySettings.optional().describe('Who can reply to the post.'),
      media_media_ids: idList('Media ids to attach', 4).optional(),
      media_tagged_user_ids: idList('User ids to tag in the media', 10).optional(),
      direct_message_deep_link: z.string().url().optional().describe('Link to a DM conversation with the author.'),
      for_super_followers_only: z.boolean().optional().describe('Restrict the post to super followers.'),
      reply_in_reply_to_tweet_id: xId('Post id being replied to').optional(),
      reply_exclude_reply_user_ids: idList('User ids to exclude from the reply', 50).optional(),
    },
    params: {
      geo_place_id: { in: 'body', as: 'geo.place_id' },
      poll_options: { in: 'body', as: 'poll.options' },
      poll_duration_minutes: { in: 'body', as: 'poll.duration_minutes' },
      poll_reply_settings: { in: 'body', as: 'poll.reply_settings' },
      media_media_ids: { in: 'body', as: 'media.media_ids' },
      media_tagged_user_ids: { in: 'body', as: 'media.tagged_user_ids' },
      reply_in_reply_to_tweet_id: { in: 'body', as: 'reply.in_reply_to_tweet_id' },
      reply_exclude_reply_user_ids: { in: 'body', as: 'reply.exclude_reply_user_ids' },
    },
    check(args) {
      const hasPoll = args.poll_options !== undefined || args.poll_duration_minutes !== undefined;
      if (hasPoll && (args.poll_options === undefined || args.poll_duration_minutes === undefined)) {
        throw invalidInput('poll_options and poll_duration_minutes must be provided together');
      }
      if (args.poll_reply_settings !== undefined && !hasPoll) throw invalidInput('poll_reply_settings requires a poll');
      if (args.media_tagged_user_ids !== undefined && args.media_media_ids === undefined) {
        throw invalidInput('media_tagged_user_ids requires media_media_ids');
      }
      if (args.reply_exclude_reply_user_ids !== undefined && args.reply_in_reply_to_tweet_id === undefined) {
        throw invalidInput('reply_exclude_reply_user_ids requires reply_in_reply_to_tweet_id');
      }
      const present = {
        card_uri: args.card_uri !== undefined,
        poll: hasPoll,
        media: args.media_media_ids !== undefined,
        quote_tweet_id: args.quote_tweet_id !== undefined,
        direct_message_deep_link: args.direct_message_deep_link !== undefined,
      };
      // Mutually exclusive pairs documented by the Composio baseline (the X spec states none).
      const exclusive: [keyof typeof present, keyof typeof present][] = [
        ['card_uri', 'quote_tweet_id'],
        ['card_uri', 'poll'],
        ['card_uri', 'media'],
        ['card_uri', 'direct_message_deep_link'],
        ['quote_tweet_id', 'poll'],
        ['quote_tweet_id', 'direct_message_deep_link'],
      ];
      for (const [a, b] of exclusive) {
        if (present[a] && present[b]) throw invalidInput(`${a} cannot be combined with ${b}`);
      }
      if (!args.text && !(present.card_uri || present.poll || present.media || present.quote_tweet_id)) {
        throw invalidInput('text is required unless media, a poll, a quote or a card is attached');
      }
    },
  }),
  httpTool({
    name: 'TWITTER_POST_DELETE_BY_POST_ID',
    title: 'Delete a post',
    description: 'Deletes a post owned by the authenticated user. Irreversible.',
    scope,
    operationId: 'deletePosts',
    method: 'DELETE',
    path: '/2/tweets/{id}',
    auth: USER_CONTEXT,
    input: { id: xId('Post id to delete') },
  }),
  httpTool({
    name: 'TWITTER_POST_LOOKUP_BY_POST_ID',
    title: 'Get a post by id',
    description: 'Returns one post with optional fields and expansions.',
    scope,
    operationId: 'getPostsById',
    method: 'GET',
    path: '/2/tweets/{id}',
    auth: ANY_AUTH,
    input: { id: xId('Post id'), ...postExpansionFields },
  }),
  httpTool({
    name: 'TWITTER_POST_LOOKUP_BY_POST_IDS',
    title: 'Get posts by ids',
    description: 'Returns up to 100 posts by id with optional fields and expansions.',
    scope,
    operationId: 'getPostsByIds',
    method: 'GET',
    path: '/2/tweets',
    auth: ANY_AUTH,
    input: { ids: idList('Post ids'), ...postExpansionFields },
  }),
  httpTool({
    name: 'TWITTER_RECENT_SEARCH',
    title: 'Search recent posts',
    description:
      'Searches posts from the last 7 days with X query syntax. Returns one page (10-100 results); continue with pagination.next_token. Time bounds and id bounds cannot be combined.',
    scope,
    operationId: 'searchPostsRecent',
    method: 'GET',
    path: '/2/tweets/search/recent',
    auth: ANY_AUTH,
    input: searchShape(100),
    check: checkExclusiveBounds,
  }),
  httpTool({
    name: 'TWITTER_FULL_ARCHIVE_SEARCH',
    title: 'Search the full post archive',
    description:
      'Searches the complete post archive since 2006 with X query syntax. Returns one page (10-500 results); continue with pagination.next_token.',
    scope,
    operationId: 'searchPostsAll',
    method: 'GET',
    path: '/2/tweets/search/all',
    auth: ANY_AUTH,
    input: searchShape(500),
  }),
  httpTool({
    name: 'TWITTER_SEARCH_RECENT_COUNTS',
    title: 'Count recent posts',
    description: 'Returns post volume for a query over the last 7 days, bucketed by minute, hour or day.',
    scope,
    operationId: 'getPostsCountsRecent',
    method: 'GET',
    path: '/2/tweets/counts/recent',
    auth: ['oauth2_user', 'app_bearer'],
    input: countsShape,
  }),
  httpTool({
    name: 'TWITTER_SEARCH_FULL_ARCHIVE_COUNTS',
    title: 'Count posts across the full archive',
    description: 'Returns post volume for a query across the full archive, bucketed by minute, hour or day. App-only bearer token required.',
    scope,
    operationId: 'getPostsCountsAll',
    method: 'GET',
    path: '/2/tweets/counts/all',
    auth: ['app_bearer'],
    input: countsShape,
    check: checkExclusiveBounds,
  }),
  httpTool({
    name: 'TWITTER_GET_USER_POSTS',
    title: "Get a user's posts",
    description: 'Returns posts authored by a user, newest first (5-100 per page).',
    scope,
    operationId: 'getUsersPosts',
    method: 'GET',
    path: '/2/users/{id}/tweets',
    auth: ANY_AUTH,
    input: {
      id: xId('User id'),
      exclude: excludeTypes,
      ...timeBounds,
      max_results: maxResults(5, 100),
      pagination_token: paginationToken,
      ...postExpansionFields,
    },
  }),
  httpTool({
    name: 'TWITTER_GET_USER_MENTIONS',
    title: "Get a user's mentions",
    description: 'Returns posts mentioning a user, newest first (5-100 per page).',
    scope,
    operationId: 'getUsersMentions',
    method: 'GET',
    path: '/2/users/{id}/mentions',
    auth: ANY_AUTH,
    input: {
      id: xId('User id'),
      ...timeBounds,
      max_results: maxResults(5, 100),
      pagination_token: paginationToken,
      ...postExpansionFields,
    },
  }),
  httpTool({
    name: 'TWITTER_USER_HOME_TIMELINE_BY_USER_ID',
    title: 'Get the home timeline',
    description: "Returns the authenticated user's reverse-chronological home timeline (1-100 per page).",
    scope,
    operationId: 'getUsersTimeline',
    method: 'GET',
    path: '/2/users/{id}/timelines/reverse_chronological',
    auth: USER_CONTEXT,
    input: {
      id: meId('Authenticated user id'),
      exclude: excludeTypes,
      ...timeBounds,
      max_results: maxResults(1, 100),
      pagination_token: paginationToken,
      ...postExpansionFields,
    },
    meParams: ['id'],
  }),
  httpTool({
    name: 'TWITTER_RETRIEVE_POSTS_THAT_QUOTE_A_POST',
    title: 'Get quote posts',
    description: 'Returns posts that quote a given post (10-100 per page).',
    scope,
    operationId: 'getPostsQuotedPosts',
    method: 'GET',
    path: '/2/tweets/{id}/quote_tweets',
    auth: ANY_AUTH,
    input: {
      id: xId('Quoted post id'),
      exclude: excludeTypes,
      max_results: maxResults(10, 100),
      pagination_token: paginationToken,
      ...postExpansionFields,
    },
  }),
  httpTool({
    name: 'TWITTER_GET_POST_RETWEETS',
    title: 'Get reposts of a post',
    description: 'Returns repost (retweet) posts of a given post (1-100 per page).',
    scope,
    operationId: 'getPostsReposts',
    method: 'GET',
    path: '/2/tweets/{id}/retweets',
    auth: ANY_AUTH,
    input: { id: xId('Post id'), max_results: maxResults(1, 100), pagination_token: paginationToken, ...postExpansionFields },
  }),
  httpTool({
    name: 'TWITTER_GET_POST_RETWEETERS_ACTION',
    title: 'Get users who reposted a post',
    description: 'Returns users who reposted (retweeted) a post (1-100 per page).',
    scope,
    operationId: 'getPostsRepostedBy',
    method: 'GET',
    path: '/2/tweets/{id}/retweeted_by',
    auth: ANY_AUTH,
    input: userListShape(100),
  }),
  httpTool({
    name: 'TWITTER_LIST_POST_LIKERS',
    title: 'Get users who liked a post',
    description: 'Returns users who liked a post (1-100 per page). User context required.',
    scope,
    operationId: 'getPostsLikingUsers',
    method: 'GET',
    path: '/2/tweets/{id}/liking_users',
    auth: USER_CONTEXT,
    input: userListShape(100),
  }),
  httpTool({
    name: 'TWITTER_RETURNS_POST_OBJECTS_LIKED_BY_THE_PROVIDED_USER_ID',
    title: 'Get posts liked by a user',
    description: 'Returns posts liked by a user (5-100 per page). User context required.',
    scope,
    operationId: 'getUsersLikedPosts',
    method: 'GET',
    path: '/2/users/{id}/liked_tweets',
    auth: USER_CONTEXT,
    input: { id: xId('User id'), max_results: maxResults(5, 100), pagination_token: paginationToken, ...postExpansionFields },
  }),
  httpTool({
    name: 'TWITTER_USER_LIKE_POST',
    title: 'Like a post',
    description: 'Likes a post on behalf of the authenticated user. `id` must be the authenticated user id.',
    scope,
    operationId: 'likePost',
    method: 'POST',
    path: '/2/users/{id}/likes',
    auth: USER_CONTEXT,
    input: { id: xId('Authenticated user id'), tweet_id: xId('Post id to like') },
  }),
  httpTool({
    name: 'TWITTER_UNLIKE_POST',
    title: 'Unlike a post',
    description: 'Removes a like from a post on behalf of the authenticated user.',
    scope,
    operationId: 'unlikePost',
    method: 'DELETE',
    path: '/2/users/{id}/likes/{tweet_id}',
    auth: USER_CONTEXT,
    input: { id: xId('Authenticated user id'), tweet_id: xId('Post id to unlike') },
  }),
  httpTool({
    name: 'TWITTER_RETWEET_POST',
    title: 'Repost a post',
    description: 'Reposts (retweets) a post as the authenticated user (user id resolved via GET /2/users/me).',
    scope,
    operationId: 'repostPost',
    method: 'POST',
    path: '/2/users/{id}/retweets',
    auth: USER_CONTEXT,
    input: { tweet_id: xId('Post id to repost') },
    meParams: ['id'],
  }),
  httpTool({
    name: 'TWITTER_UNRETWEET_POST',
    title: 'Undo a repost',
    description: 'Removes a repost (retweet) made by the authenticated user.',
    scope,
    operationId: 'unrepostPost',
    method: 'DELETE',
    path: '/2/users/{id}/retweets/{source_tweet_id}',
    auth: USER_CONTEXT,
    input: { id: meId('Authenticated user id'), source_tweet_id: xId('Original post id') },
    meParams: ['id'],
  }),
  httpTool({
    name: 'TWITTER_HIDE_REPLIES',
    title: 'Hide or unhide a reply',
    description: 'Hides or unhides a reply to a conversation started by the authenticated user.',
    scope,
    operationId: 'hidePostsReply',
    method: 'PUT',
    path: '/2/tweets/{tweet_id}/hidden',
    auth: USER_CONTEXT,
    input: { tweet_id: xId('Reply post id'), hidden: z.boolean().describe('true to hide, false to unhide.') },
  }),
];

export const userTools: ToolDefinition[] = [
  httpTool({
    name: 'TWITTER_GET_USER_BY_ID',
    title: 'Get a user by id',
    description: 'Returns one user by id with optional fields and expansions.',
    scope,
    operationId: 'getUsersById',
    method: 'GET',
    path: '/2/users/{id}',
    auth: ANY_AUTH,
    input: { id: xId('User id'), ...userExpansionFields },
  }),
  httpTool({
    name: 'TWITTER_GET_USERS_BY_IDS',
    title: 'Get users by ids',
    description: 'Returns up to 100 users by id.',
    scope,
    operationId: 'getUsersByIds',
    method: 'GET',
    path: '/2/users',
    auth: ANY_AUTH,
    input: { ids: idList('User ids'), ...userExpansionFields },
  }),
  httpTool({
    name: 'TWITTER_USER_LOOKUP_BY_USERNAME',
    title: 'Get a user by username',
    description: 'Returns one user by username (without @).',
    scope,
    operationId: 'getUsersByUsername',
    method: 'GET',
    path: '/2/users/by/username/{username}',
    auth: ANY_AUTH,
    input: {
      username: z.string().regex(/^[A-Za-z0-9_]{1,15}$/, 'username must be 1-15 letters, digits or underscores (no @)').describe('Username without @.'),
      ...userExpansionFields,
    },
  }),
  httpTool({
    name: 'TWITTER_USER_LOOKUP_BY_USERNAMES',
    title: 'Get users by usernames',
    description: 'Returns up to 100 users by username (without @).',
    scope,
    operationId: 'getUsersByUsernames',
    method: 'GET',
    path: '/2/users/by',
    auth: ANY_AUTH,
    input: {
      usernames: z
        .array(z.string().regex(/^[A-Za-z0-9_]{1,15}$/, 'usernames must be 1-15 letters, digits or underscores (no @)'))
        .min(1)
        .max(100)
        .describe('Usernames without @ (1-100).'),
      ...userExpansionFields,
    },
  }),
  httpTool({
    name: 'TWITTER_USER_LOOKUP_ME',
    title: 'Get the authenticated user',
    description: 'Returns the user that the configured user-context credentials belong to.',
    scope,
    operationId: 'getUsersMe',
    method: 'GET',
    path: '/2/users/me',
    auth: USER_CONTEXT,
    input: { expansions, user_fields: fields('User'), tweet_fields: fields('Post') },
  }),
];
