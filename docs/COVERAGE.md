# Tool coverage

Generated from `coverage/manifest.json` by `scripts/coverage/render_coverage.py`. Baseline: Composio `TWITTER` toolkit version `20261101_00` (84 tools, retrieved 2026-11-07). Endpoints: X API v2 OpenAPI `2.174`. Rate limits: [X rate-limit page](https://docs.x.com/x-api/fundamentals/rate-limits).

All 84 baseline tools are implemented, registered and covered by mocked HTTP contract tests (`test/contracts/`). None is a stub. Live behavior against api.x.com has not been exercised (see README).

## Resolved discrepancies

- X OpenAPI 2.174 names the post field-selection parameter `post.fields` (PostFieldsParameter) on most endpoints, while docs.x.com/x-api/fundamentals/fields, inline stream parameters in the same spec, and Composio use `tweet.fields`. This server sends `tweet.fields` (documented wire name); unverified against the live API.
- X uses pay-per-usage pricing (docs.x.com/x-api/getting-started/pricing): every live call is billable. Official reference pages do not state per-endpoint plan restrictions; Composio descriptions claim Enterprise-only access for some tools (recorded per tool, unverified).
- Numeric bounds, id patterns and required fields follow the X spec where Composio descriptions differ.
- Where Composio and X enums differ (see x_enum per parameter), input validation uses the official X enum.
- Composio input `max_results` descriptions advertise automatic multi-page fetching; this server returns a single page and surfaces meta.next_token.

## User authorization

- 77 of 84 tools accept OAuth 2.0 user tokens; per-tool scopes are listed below and in `src/auth/tool-scopes.ts`.
- App-only (X_BEARER_TOKEN required): `TWITTER_CREATE_COMPLIANCE_JOB`, `TWITTER_GET_COMPLIANCE_JOB`, `TWITTER_GET_COMPLIANCE_JOBS`, `TWITTER_GET_POST_USAGE`, `TWITTER_SEARCH_FULL_ARCHIVE_COUNTS`, `TWITTER_STREAM_POST_LABELS`.
- Unauthenticated: `TWITTER_GET_OPENAPI_SPEC`.
- OAuth 1.0a-only: none. Every user-context tool accepts OAuth 2.0 user tokens, so no 3-legged OAuth 1.0a authorization flow is required; OAuth 1.0a remains available via environment credentials. App-only tools require X_BEARER_TOKEN and never receive user tokens.

## Extra tools (not counted toward coverage)

- `X_FINALIZE_MEDIA_UPLOAD` (`finalizeMediaUpload`): Completes the chunked upload lifecycle that Composio exposes only partially; not counted as Composio coverage.
- `X_AUTH_CONNECT`: Starts OAuth 2.0 Authorization Code with PKCE (S256) for an X account; returns the authorize URL only.
- `X_AUTH_STATUS`: Lists connected accounts, granted scopes and expiry without exposing tokens.
- `X_AUTH_DISCONNECT`: Revokes (POST /2/oauth2/revoke) and deletes the active connected account.

## posts-users

| Tool | X endpoint(s) | Auth | OAuth 2.0 scopes | Rate limit (app / user) | Pagination | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `TWITTER_CREATION_OF_A_POST` | `POST /2/tweets` | OAuth2 user, OAuth1a user | `tweet.read`, `tweet.write`, `users.read` | 10,000/24hrs / 100/15min | - | X body also has community_id, edit_options, made_with_ai, paid_partnership, share_with_followers; not exposed (outside Composio baseline). Non-idempotent write: never retried automatically. |
| `TWITTER_FULL_ARCHIVE_SEARCH` | `GET /2/tweets/search/all` | OAuth2 user, OAuth1a user, App bearer | `tweet.read`, `users.read` | 1/sec, 300/15min / 1/sec | `next_token` | Composio auto-paginates; this server returns one page and validates X bounds (10-500, per docs.x.com rate-limit page). |
| `TWITTER_GET_POST_RETWEETERS_ACTION` | `GET /2/tweets/{id}/retweeted_by` | OAuth2 user, OAuth1a user, App bearer | `tweet.read`, `users.read` | 75/15min / 75/15min | `pagination_token` | - |
| `TWITTER_GET_POST_RETWEETS` | `GET /2/tweets/{id}/retweets` | OAuth2 user, OAuth1a user, App bearer | `tweet.read`, `users.read` | 75/15min / 75/15min | `pagination_token` | - |
| `TWITTER_GET_USERS_BY_IDS` | `GET /2/users` | OAuth2 user, OAuth1a user, App bearer | `tweet.read`, `users.read` | 300/15min / 900/15min | - | - |
| `TWITTER_GET_USER_BY_ID` | `GET /2/users/{id}` | OAuth2 user, OAuth1a user, App bearer | `tweet.read`, `users.read` | 300/15min / 900/15min | - | - |
| `TWITTER_GET_USER_MENTIONS` | `GET /2/users/{id}/mentions` | OAuth2 user, OAuth1a user, App bearer | `tweet.read`, `users.read` | 450/15min / 300/15min | `pagination_token` | - |
| `TWITTER_GET_USER_POSTS` | `GET /2/users/{id}/tweets` | OAuth2 user, OAuth1a user, App bearer | `tweet.read`, `users.read` | 10,000/15min / 900/15min | `pagination_token` | - |
| `TWITTER_HIDE_REPLIES` | `PUT /2/tweets/{tweet_id}/hidden` | OAuth2 user, OAuth1a user | `tweet.moderate.write`, `tweet.read`, `users.read` | — / 50/15min | - | - |
| `TWITTER_LIST_POST_LIKERS` | `GET /2/tweets/{id}/liking_users` | OAuth2 user, OAuth1a user | `like.read`, `tweet.read`, `users.read` | 75/15min / 75/15min | `pagination_token` | - |
| `TWITTER_POST_DELETE_BY_POST_ID` | `DELETE /2/tweets/{id}` | OAuth2 user, OAuth1a user | `tweet.read`, `tweet.write`, `users.read` | — / 50/15min | - | - |
| `TWITTER_POST_LOOKUP_BY_POST_ID` | `GET /2/tweets/{id}` | OAuth2 user, OAuth1a user, App bearer | `tweet.read`, `users.read` | 450/15min / 900/15min | - | - |
| `TWITTER_POST_LOOKUP_BY_POST_IDS` | `GET /2/tweets` | OAuth2 user, OAuth1a user, App bearer | `tweet.read`, `users.read` | 3,500/15min / 5,000/15min | - | - |
| `TWITTER_RECENT_SEARCH` | `GET /2/tweets/search/recent` | OAuth2 user, OAuth1a user, App bearer | `tweet.read`, `users.read` | 450/15min / 300/15min | `pagination_token` | Composio auto-paginates max_results up to 2000; this server returns one page and validates X bounds (10-100). Continue with meta.next_token. |
| `TWITTER_RETRIEVE_POSTS_THAT_QUOTE_A_POST` | `GET /2/tweets/{id}/quote_tweets` | OAuth2 user, OAuth1a user, App bearer | `tweet.read`, `users.read` | 75/15min / 75/15min | `pagination_token` | - |
| `TWITTER_RETURNS_POST_OBJECTS_LIKED_BY_THE_PROVIDED_USER_ID` | `GET /2/users/{id}/liked_tweets` | OAuth2 user, OAuth1a user | `like.read`, `tweet.read`, `users.read` | 75/15min / 75/15min | `pagination_token` | - |
| `TWITTER_RETWEET_POST` | `POST /2/users/{id}/retweets` | OAuth2 user, OAuth1a user | `tweet.read`, `tweet.write`, `users.read` | — / 50/15min | - | No user id parameter in Composio: path id resolved via GET /2/users/me. |
| `TWITTER_SEARCH_FULL_ARCHIVE_COUNTS` | `GET /2/tweets/counts/all` | App bearer | - | 300/15min / — | `pagination_token` | - |
| `TWITTER_SEARCH_RECENT_COUNTS` | `GET /2/tweets/counts/recent` | OAuth2 user, App bearer | - | 300/15min / — | `pagination_token` | - |
| `TWITTER_UNLIKE_POST` | `DELETE /2/users/{id}/likes/{tweet_id}` | OAuth2 user, OAuth1a user | `like.write`, `tweet.read`, `users.read` | — / 50/15min, 1,000/24hrs | - | - |
| `TWITTER_UNRETWEET_POST` | `DELETE /2/users/{id}/retweets/{source_tweet_id}` | OAuth2 user, OAuth1a user | `tweet.read`, `tweet.write`, `users.read` | — / 50/15min | - | `id` optional: resolved via GET /2/users/me when omitted. |
| `TWITTER_USER_HOME_TIMELINE_BY_USER_ID` | `GET /2/users/{id}/timelines/reverse_chronological` | OAuth2 user, OAuth1a user | `tweet.read`, `users.read` | — / 180/15min | `pagination_token` | `id` optional: resolved via GET /2/users/me when omitted. |
| `TWITTER_USER_LIKE_POST` | `POST /2/users/{id}/likes` | OAuth2 user, OAuth1a user | `like.write`, `tweet.read`, `users.read` | — / 50/15min, 1,000/24hrs | - | - |
| `TWITTER_USER_LOOKUP_BY_USERNAME` | `GET /2/users/by/username/{username}` | OAuth2 user, OAuth1a user, App bearer | `tweet.read`, `users.read` | 300/15min / 900/15min | - | - |
| `TWITTER_USER_LOOKUP_BY_USERNAMES` | `GET /2/users/by` | OAuth2 user, OAuth1a user, App bearer | `tweet.read`, `users.read` | 300/15min / 900/15min | - | - |
| `TWITTER_USER_LOOKUP_ME` | `GET /2/users/me` | OAuth2 user, OAuth1a user | `tweet.read`, `users.read` | — / 75/15min | - | - |

## lists-bookmarks-relationships

| Tool | X endpoint(s) | Auth | OAuth 2.0 scopes | Rate limit (app / user) | Pagination | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `TWITTER_ADD_LIST_MEMBER` | `POST /2/lists/{id}/members` | OAuth2 user, OAuth1a user | `list.write`, `tweet.read`, `users.read` | — / 300/15min | - | - |
| `TWITTER_ADD_POST_TO_BOOKMARKS` | `POST /2/users/{id}/bookmarks` | OAuth2 user | `bookmark.write`, `tweet.read`, `users.read` | — / 50/15min | - | X also accepts folder_id/tweet_ids; not exposed because the Composio baseline does not include them. |
| `TWITTER_BOOKMARKS_BY_USER` | `GET /2/users/{id}/bookmarks` | OAuth2 user, OAuth1a user | `bookmark.read`, `tweet.read`, `users.read` | — / 180/15min | `pagination_token` | `id` optional: resolved via GET /2/users/me when omitted (one extra billable request, cached per process). |
| `TWITTER_CREATE_LIST` | `POST /2/lists` | OAuth2 user, OAuth1a user | `list.read`, `list.write`, `tweet.read`, `users.read` | — / 300/15min | - | - |
| `TWITTER_DELETE_LIST` | `DELETE /2/lists/{id}` | OAuth2 user, OAuth1a user | `list.write`, `tweet.read`, `users.read` | — / 300/15min | - | - |
| `TWITTER_FOLLOWERS_BY_USER_ID` | `GET /2/users/{id}/followers` | OAuth2 user, OAuth1a user, App bearer | `follows.read`, `tweet.read`, `users.read` | 300/15min / 300/15min | `pagination_token` | - |
| `TWITTER_FOLLOWING_BY_USER_ID` | `GET /2/users/{id}/following` | OAuth2 user, OAuth1a user, App bearer | `follows.read`, `tweet.read`, `users.read` | 300/15min / 300/15min | `pagination_token` | - |
| `TWITTER_FOLLOW_LIST` | `POST /2/users/{id}/followed_lists` | OAuth2 user, OAuth1a user | `list.write`, `tweet.read`, `users.read` | — / 50/15min | - | - |
| `TWITTER_FOLLOW_USER` | `POST /2/users/{id}/following` | OAuth2 user, OAuth1a user | `follows.write`, `tweet.read`, `users.read` | — / 50/15min | - | `id` optional: resolved via GET /2/users/me when omitted. |
| `TWITTER_GET_BLOCKED_USERS` | `GET /2/users/{id}/blocking` | OAuth2 user, OAuth1a user | `block.read`, `tweet.read`, `users.read` | — / 15/15min | `pagination_token` | - |
| `TWITTER_GET_LIST` | `GET /2/lists/{id}` | OAuth2 user, OAuth1a user, App bearer | `list.read`, `tweet.read`, `users.read` | 75/15min / 75/15min | - | - |
| `TWITTER_GET_LIST_FOLLOWERS` | `GET /2/lists/{id}/followers` | OAuth2 user, OAuth1a user, App bearer | `list.read`, `tweet.read`, `users.read` | not listed | `pagination_token` | - |
| `TWITTER_GET_LIST_MEMBERS` | `GET /2/lists/{id}/members` | OAuth2 user, OAuth1a user, App bearer | `list.read`, `tweet.read`, `users.read` | 900/15min / 900/15min | `pagination_token` | - |
| `TWITTER_GET_MUTED_USERS` | `GET /2/users/{id}/muting` | OAuth2 user, OAuth1a user | `mute.read`, `tweet.read`, `users.read` | — / 15/15min | `pagination_token` | - |
| `TWITTER_GET_USER_FOLLOWED_LISTS` | `GET /2/users/{id}/followed_lists` | OAuth2 user, OAuth1a user, App bearer | `list.read`, `tweet.read`, `users.read` | not listed | `pagination_token` | - |
| `TWITTER_GET_USER_LIST_MEMBERSHIPS` | `GET /2/users/{id}/list_memberships` | OAuth2 user, OAuth1a user, App bearer | `list.read`, `tweet.read`, `users.read` | 75/15min / 75/15min | `pagination_token` | - |
| `TWITTER_GET_USER_OWNED_LISTS` | `GET /2/users/{id}/owned_lists` | OAuth2 user, OAuth1a user, App bearer | `list.read`, `tweet.read`, `users.read` | 15/15min / 15/15min | `pagination_token` | - |
| `TWITTER_GET_USER_PINNED_LISTS` | `GET /2/users/{id}/pinned_lists` | OAuth2 user, OAuth1a user | `list.read`, `tweet.read`, `users.read` | 15/15min / 15/15min | - | - |
| `TWITTER_LIST_POSTS_TIMELINE_BY_LIST_ID` | `GET /2/lists/{id}/tweets` | OAuth2 user, OAuth1a user, App bearer | `list.read`, `tweet.read`, `users.read` | 900/15min / 900/15min | `pagination_token` | - |
| `TWITTER_MUTE_USER` | `POST /2/users/{id}/muting` | OAuth2 user, OAuth1a user | `mute.write`, `tweet.read`, `users.read` | — / 50/15min | - | `id` optional: resolved via GET /2/users/me when omitted. |
| `TWITTER_PIN_LIST` | `POST /2/users/{id}/pinned_lists` | OAuth2 user, OAuth1a user | `list.write`, `tweet.read`, `users.read` | — / 50/15min | - | - |
| `TWITTER_REMOVE_LIST_MEMBER` | `DELETE /2/lists/{id}/members/{user_id}` | OAuth2 user, OAuth1a user | `list.write`, `tweet.read`, `users.read` | — / 300/15min | - | - |
| `TWITTER_REMOVE_POST_FROM_BOOKMARKS` | `DELETE /2/users/{id}/bookmarks/{tweet_id}` | OAuth2 user | `bookmark.write`, `tweet.read`, `users.read` | — / 50/15min | - | `id` optional: resolved via GET /2/users/me when omitted. |
| `TWITTER_UNFOLLOW_LIST` | `DELETE /2/users/{id}/followed_lists/{list_id}` | OAuth2 user, OAuth1a user | `list.write`, `tweet.read`, `users.read` | — / 50/15min | - | - |
| `TWITTER_UNFOLLOW_USER` | `DELETE /2/users/{source_user_id}/following/{target_user_id}` | OAuth2 user, OAuth1a user | `follows.write`, `tweet.read`, `users.read` | — / 50/15min | - | `source_user_id` optional: resolved via GET /2/users/me when omitted. |
| `TWITTER_UNMUTE_USER` | `DELETE /2/users/{source_user_id}/muting/{target_user_id}` | OAuth2 user, OAuth1a user | `mute.write`, `tweet.read`, `users.read` | — / 50/15min | - | No source user parameter in Composio: source_user_id resolved via GET /2/users/me. |
| `TWITTER_UNPIN_LIST` | `DELETE /2/users/{id}/pinned_lists/{list_id}` | OAuth2 user, OAuth1a user | `list.write`, `tweet.read`, `users.read` | — / 50/15min | - | `id` optional: resolved via GET /2/users/me when omitted. |
| `TWITTER_UPDATE_LIST` | `PUT /2/lists/{id}` | OAuth2 user, OAuth1a user | `list.write`, `tweet.read`, `users.read` | — / 300/15min | - | - |

## direct-messages

| Tool | X endpoint(s) | Auth | OAuth 2.0 scopes | Rate limit (app / user) | Pagination | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `TWITTER_CREATE_DM_CONVERSATION` | `POST /2/dm_conversations` | OAuth2 user, OAuth1a user | `dm.write`, `tweet.read`, `users.read` | 1,440/24hrs / 15/15min, 1,440/24hrs | - | - |
| `TWITTER_DELETE_DM` | `DELETE /2/dm_events/{event_id}` | OAuth2 user, OAuth1a user | `dm.read`, `dm.write` | 4,000/24hrs / 300/15min, 1,500/24hrs | - | - |
| `TWITTER_GET_DM_CONVERSATION_EVENTS` | `GET /2/dm_conversations/with/{participant_id}/dm_events` | OAuth2 user, OAuth1a user | `dm.read`, `tweet.read`, `users.read` | — / 15/15min | `pagination_token` | - |
| `TWITTER_GET_DM_EVENT` | `GET /2/dm_events/{event_id}` | OAuth2 user, OAuth1a user | `dm.read`, `tweet.read`, `users.read` | — / 15/15min | - | - |
| `TWITTER_GET_RECENT_DM_EVENTS` | `GET /2/dm_events` | OAuth2 user, OAuth1a user | `dm.read`, `tweet.read`, `users.read` | — / 15/15min | `pagination_token` | - |
| `TWITTER_RETRIEVE_DM_CONVERSATION_EVENTS` | `GET /2/dm_conversations/{id}/dm_events` | OAuth2 user, OAuth1a user | `dm.read`, `tweet.read`, `users.read` | — / 15/15min | `pagination_token` | - |
| `TWITTER_SEND_A_NEW_MESSAGE_TO_A_USER` | `POST /2/dm_conversations/with/{participant_id}/messages` | OAuth2 user, OAuth1a user | `dm.write`, `tweet.read`, `users.read` | 1,440/24hrs / 15/15min, 1,440/24hrs | - | - |
| `TWITTER_SEND_DM_TO_CONVERSATION` | `POST /2/dm_conversations/{dm_conversation_id}/messages` | OAuth2 user, OAuth1a user | `dm.write`, `tweet.read`, `users.read` | 1,440/24hrs / 15/15min, 1,440/24hrs | - | - |

## spaces-media

| Tool | X endpoint(s) | Auth | OAuth 2.0 scopes | Rate limit (app / user) | Pagination | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `TWITTER_APPEND_MEDIA_UPLOAD` | `POST /2/media/upload/{id}/append` | OAuth2 user, OAuth1a user | `media.write` | 180,000/24hrs / 1,875/15min | - | See INITIALIZE_MEDIA_UPLOAD note about the missing FINALIZE tool. |
| `TWITTER_GET_MEDIA_UPLOAD_STATUS` | `GET /2/media/upload` | OAuth2 user, OAuth1a user | `media.write` | 100,000/24hrs / 1,000/15min | - | Sends command=STATUS. |
| `TWITTER_GET_SPACES_BY_CREATORS` | `GET /2/spaces/by/creator_ids` | OAuth2 user, App bearer | `space.read`, `tweet.read`, `users.read` | 300/15min, 1/sec / 300/15min, 1/sec | - | - |
| `TWITTER_GET_SPACES_BY_IDS` | `GET /2/spaces` | OAuth2 user, App bearer | `space.read`, `tweet.read`, `users.read` | 300/15min / 300/15min | - | - |
| `TWITTER_GET_SPACE_BY_ID` | `GET /2/spaces/{id}` | OAuth2 user, App bearer | `space.read`, `tweet.read`, `users.read` | 300/15min / 300/15min | - | - |
| `TWITTER_GET_SPACE_POSTS` | `GET /2/spaces/{id}/tweets` | OAuth2 user, App bearer | `space.read`, `tweet.read`, `users.read` | 300/15min / 300/15min | - | X supports pagination_token on this endpoint but the Composio baseline does not expose it; not exposed. |
| `TWITTER_GET_SPACE_TICKET_BUYERS` | `GET /2/spaces/{id}/buyers` | OAuth2 user | `space.read`, `tweet.read`, `users.read` | 300/15min / 300/15min | `pagination_token` | - |
| `TWITTER_INITIALIZE_MEDIA_UPLOAD` | `POST /2/media/upload/initialize` | OAuth2 user, OAuth1a user | `media.write` | 180,000/24hrs / 1,875/15min | - | Composio has no FINALIZE tool, so INITIALIZE/APPEND alone cannot complete an upload. This server adds extra tool X_FINALIZE_MEDIA_UPLOAD (finalizeMediaUpload); it is not counted toward Composio coverage. |
| `TWITTER_SEARCH_SPACES` | `GET /2/spaces/search` | OAuth2 user, App bearer | `space.read`, `tweet.read`, `users.read` | 300/15min / 300/15min | - | - |
| `TWITTER_UPLOAD_LARGE_MEDIA` | `POST /2/media/upload/initialize`<br>`POST /2/media/upload/{id}/append`<br>`POST /2/media/upload/{id}/finalize`<br>`GET /2/media/upload` | OAuth2 user, OAuth1a user | `media.write` | 180,000/24hrs / 1,875/15min | - | Composite operation; no automatic retry of APPEND/FINALIZE. |
| `TWITTER_UPLOAD_MEDIA` | `POST /2/media/upload` | OAuth2 user, OAuth1a user | `media.write` | 50,000/24hrs / 500/15min | - | Single-request upload capped at 5 MiB (Composio guidance); media_category inferred from MIME type when omitted. |

## platform

| Tool | X endpoint(s) | Auth | OAuth 2.0 scopes | Rate limit (app / user) | Pagination | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `TWITTER_CREATE_ACTIVITY_SUBSCRIPTION` | `POST /2/activity/subscriptions` | OAuth2 user, OAuth1a user, App bearer | - | 500/15min / — | - | X spec event_type enum is a superset of Composio's; the official X enum is used for validation. X `expires_at` is not exposed (outside Composio baseline). |
| `TWITTER_CREATE_COMPLIANCE_JOB` | `POST /2/compliance/jobs` | App bearer | - | 150/15min / — | - | - |
| `TWITTER_GET_COMPLIANCE_JOB` | `GET /2/compliance/jobs/{id}` | App bearer | - | 150/15min / — | - | - |
| `TWITTER_GET_COMPLIANCE_JOBS` | `GET /2/compliance/jobs` | App bearer | - | 150/15min / — | - | Composio status enum includes `expired`, which is absent from the X spec enum; it is rejected locally. |
| `TWITTER_GET_OPENAPI_SPEC` | `GET /2/openapi.json` | none | - | not listed | - | Unauthenticated; returns a large (~1.3 MB) document. |
| `TWITTER_GET_POST_ANALYTICS` | `GET /2/tweets/analytics` | OAuth2 user, OAuth1a user | `tweet.read`, `users.read` | 300/15min / 300/15min | - | Composio states an Enterprise plan is required (403 otherwise). docs.x.com reference does not state a plan restriction; unverified live. |
| `TWITTER_GET_POST_USAGE` | `GET /2/usage/tweets` | App bearer | - | 50/15min / — | - | App-only bearer token required. |
| `TWITTER_GET_USER_PUBLIC_KEYS` | `GET /2/users/{id}/public_keys` | OAuth2 user, OAuth1a user | `dm.read`, `tweet.read`, `users.read` | not listed | - | X also exposes batch GET /2/users/public_keys; Composio requires a single id so /2/users/{id}/public_keys is used. |
| `TWITTER_LIST_CHAT_CONVERSATIONS` | `GET /2/chat/conversations` | OAuth2 user, OAuth1a user | `dm.read`, `users.read` | not listed | `pagination_token` | max_results follows the X bound (1-1000) rather than Composio's 1-100. X exposes extra filters (is_archived, is_muted, participant_ids, participant_query, start_time, end_time, type, unread_only); not exposed (outside Composio baseline). |
| `TWITTER_SEARCH_NEWS` | `GET /2/news/search` | OAuth2 user, OAuth1a user, App bearer | `tweet.read`, `users.read` | 200/15min / 200/15min | - | - |
| `TWITTER_STREAM_POST_LABELS` | `GET /2/tweets/label/stream` | App bearer | - | not listed | - | Streaming endpoint: the tool reads a bounded window (max_events / timeout_seconds extensions) and then closes the connection. Composio states Enterprise access + app-only auth is required. |
