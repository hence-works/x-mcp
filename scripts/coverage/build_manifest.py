#!/usr/bin/env python3
"""Build coverage/manifest.json: Composio Twitter tools mapped to official X API v2 operations.

Inputs (downloaded separately; treat as untrusted data, run with `python3 -I`):
  --composio  coverage/sources/composio-twitter-<version>.json  (from parse_composio_docs.py)
  --openapi   X OpenAPI spec, https://api.x.com/2/openapi.json
  --ratelimits X rate-limit page, https://docs.x.com/x-api/fundamentals/rate-limits.md
  --out       coverage/manifest.json

The script fails if any Composio tool lacks a mapping, a mapped operation is missing from the spec,
or a Composio parameter cannot be placed on the X request (unless explicitly declared below).
"""
import argparse
import json
import re
import sys

# Composio slug (without TWITTER_ prefix) -> X operationId(s), implementation scope.
MAP = {
    # scope: posts-users
    'CREATION_OF_A_POST': ('createPosts', 'posts-users'),
    'POST_DELETE_BY_POST_ID': ('deletePosts', 'posts-users'),
    'POST_LOOKUP_BY_POST_ID': ('getPostsById', 'posts-users'),
    'POST_LOOKUP_BY_POST_IDS': ('getPostsByIds', 'posts-users'),
    'RECENT_SEARCH': ('searchPostsRecent', 'posts-users'),
    'FULL_ARCHIVE_SEARCH': ('searchPostsAll', 'posts-users'),
    'SEARCH_RECENT_COUNTS': ('getPostsCountsRecent', 'posts-users'),
    'SEARCH_FULL_ARCHIVE_COUNTS': ('getPostsCountsAll', 'posts-users'),
    'GET_USER_POSTS': ('getUsersPosts', 'posts-users'),
    'GET_USER_MENTIONS': ('getUsersMentions', 'posts-users'),
    'USER_HOME_TIMELINE_BY_USER_ID': ('getUsersTimeline', 'posts-users'),
    'RETRIEVE_POSTS_THAT_QUOTE_A_POST': ('getPostsQuotedPosts', 'posts-users'),
    'GET_POST_RETWEETS': ('getPostsReposts', 'posts-users'),
    'GET_POST_RETWEETERS_ACTION': ('getPostsRepostedBy', 'posts-users'),
    'LIST_POST_LIKERS': ('getPostsLikingUsers', 'posts-users'),
    'RETURNS_POST_OBJECTS_LIKED_BY_THE_PROVIDED_USER_ID': ('getUsersLikedPosts', 'posts-users'),
    'USER_LIKE_POST': ('likePost', 'posts-users'),
    'UNLIKE_POST': ('unlikePost', 'posts-users'),
    'RETWEET_POST': ('repostPost', 'posts-users'),
    'UNRETWEET_POST': ('unrepostPost', 'posts-users'),
    'HIDE_REPLIES': ('hidePostsReply', 'posts-users'),
    'GET_USER_BY_ID': ('getUsersById', 'posts-users'),
    'GET_USERS_BY_IDS': ('getUsersByIds', 'posts-users'),
    'USER_LOOKUP_BY_USERNAME': ('getUsersByUsername', 'posts-users'),
    'USER_LOOKUP_BY_USERNAMES': ('getUsersByUsernames', 'posts-users'),
    'USER_LOOKUP_ME': ('getUsersMe', 'posts-users'),
    # scope: lists-bookmarks-relationships
    'CREATE_LIST': ('createLists', 'lists-bookmarks-relationships'),
    'UPDATE_LIST': ('updateLists', 'lists-bookmarks-relationships'),
    'DELETE_LIST': ('deleteLists', 'lists-bookmarks-relationships'),
    'GET_LIST': ('getListsById', 'lists-bookmarks-relationships'),
    'GET_LIST_MEMBERS': ('getListsMembers', 'lists-bookmarks-relationships'),
    'GET_LIST_FOLLOWERS': ('getListsFollowers', 'lists-bookmarks-relationships'),
    'LIST_POSTS_TIMELINE_BY_LIST_ID': ('getListsPosts', 'lists-bookmarks-relationships'),
    'ADD_LIST_MEMBER': ('addListsMember', 'lists-bookmarks-relationships'),
    'REMOVE_LIST_MEMBER': ('removeListsMemberByUserId', 'lists-bookmarks-relationships'),
    'FOLLOW_LIST': ('followList', 'lists-bookmarks-relationships'),
    'UNFOLLOW_LIST': ('unfollowList', 'lists-bookmarks-relationships'),
    'PIN_LIST': ('pinList', 'lists-bookmarks-relationships'),
    'UNPIN_LIST': ('unpinList', 'lists-bookmarks-relationships'),
    'GET_USER_OWNED_LISTS': ('getUsersOwnedLists', 'lists-bookmarks-relationships'),
    'GET_USER_FOLLOWED_LISTS': ('getUsersFollowedLists', 'lists-bookmarks-relationships'),
    'GET_USER_LIST_MEMBERSHIPS': ('getUsersListMemberships', 'lists-bookmarks-relationships'),
    'GET_USER_PINNED_LISTS': ('getUsersPinnedLists', 'lists-bookmarks-relationships'),
    'BOOKMARKS_BY_USER': ('getUsersBookmarks', 'lists-bookmarks-relationships'),
    'ADD_POST_TO_BOOKMARKS': ('createUsersBookmark', 'lists-bookmarks-relationships'),
    'REMOVE_POST_FROM_BOOKMARKS': ('deleteUsersBookmark', 'lists-bookmarks-relationships'),
    'FOLLOW_USER': ('followUser', 'lists-bookmarks-relationships'),
    'UNFOLLOW_USER': ('unfollowUser', 'lists-bookmarks-relationships'),
    'FOLLOWERS_BY_USER_ID': ('getUsersFollowers', 'lists-bookmarks-relationships'),
    'FOLLOWING_BY_USER_ID': ('getUsersFollowing', 'lists-bookmarks-relationships'),
    'MUTE_USER': ('muteUser', 'lists-bookmarks-relationships'),
    'UNMUTE_USER': ('unmuteUser', 'lists-bookmarks-relationships'),
    'GET_MUTED_USERS': ('getUsersMuting', 'lists-bookmarks-relationships'),
    'GET_BLOCKED_USERS': ('getUsersBlocking', 'lists-bookmarks-relationships'),
    # scope: direct-messages
    'CREATE_DM_CONVERSATION': ('createDirectMessagesConversation', 'direct-messages'),
    'SEND_A_NEW_MESSAGE_TO_A_USER': ('createDirectMessagesByParticipantId', 'direct-messages'),
    'SEND_DM_TO_CONVERSATION': ('createDirectMessagesByConversationId', 'direct-messages'),
    'DELETE_DM': ('deleteDirectMessagesEvents', 'direct-messages'),
    'GET_DM_EVENT': ('getDirectMessagesEventsById', 'direct-messages'),
    'GET_RECENT_DM_EVENTS': ('getDirectMessagesEvents', 'direct-messages'),
    'GET_DM_CONVERSATION_EVENTS': ('getDirectMessagesEventsByParticipantId', 'direct-messages'),
    'RETRIEVE_DM_CONVERSATION_EVENTS': ('getDirectMessagesEventsByConversationId', 'direct-messages'),
    # scope: spaces-media
    'GET_SPACE_BY_ID': ('getSpacesById', 'spaces-media'),
    'GET_SPACES_BY_IDS': ('getSpacesByIds', 'spaces-media'),
    'GET_SPACES_BY_CREATORS': ('getSpacesByCreatorIds', 'spaces-media'),
    'SEARCH_SPACES': ('searchSpaces', 'spaces-media'),
    'GET_SPACE_POSTS': ('getSpacesPosts', 'spaces-media'),
    'GET_SPACE_TICKET_BUYERS': ('getSpacesBuyers', 'spaces-media'),
    'UPLOAD_MEDIA': ('mediaUpload', 'spaces-media'),
    'UPLOAD_LARGE_MEDIA': (['initializeMediaUpload', 'appendMediaUpload', 'finalizeMediaUpload', 'getMediaUploadStatus'], 'spaces-media'),
    'INITIALIZE_MEDIA_UPLOAD': ('initializeMediaUpload', 'spaces-media'),
    'APPEND_MEDIA_UPLOAD': ('appendMediaUpload', 'spaces-media'),
    'GET_MEDIA_UPLOAD_STATUS': ('getMediaUploadStatus', 'spaces-media'),
    # scope: platform (analytics / compliance / activity / chat / news / utility)
    'CREATE_COMPLIANCE_JOB': ('createComplianceJobs', 'platform'),
    'GET_COMPLIANCE_JOB': ('getComplianceJobsById', 'platform'),
    'GET_COMPLIANCE_JOBS': ('getComplianceJobs', 'platform'),
    'GET_POST_ANALYTICS': ('getPostsAnalytics', 'platform'),
    'GET_POST_USAGE': ('getUsage', 'platform'),
    'STREAM_POST_LABELS': ('streamLabelsCompliance', 'platform'),
    'CREATE_ACTIVITY_SUBSCRIPTION': ('createActivitySubscription', 'platform'),
    'LIST_CHAT_CONVERSATIONS': ('getChatConversations', 'platform'),
    'GET_USER_PUBLIC_KEYS': ('getUsersPublicKey', 'platform'),
    'SEARCH_NEWS': ('searchNews', 'platform'),
    'GET_OPENAPI_SPEC': ('getOpenApiSpec', 'platform'),
}

# Field-selection params: X's documented wire name (docs.x.com/x-api/fundamentals/fields).
FIELD_PARAM = {
    'tweet_fields': 'tweet.fields', 'user_fields': 'user.fields', 'media_fields': 'media.fields',
    'place_fields': 'place.fields', 'poll_fields': 'poll.fields', 'list_fields': 'list.fields',
    'space_fields': 'space.fields', 'topic_fields': 'topic.fields', 'dm_event_fields': 'dm_event.fields',
    'compliance_job_fields': 'compliance_job.fields', 'usage_fields': 'usage.fields',
    'search_count_fields': 'search_count.fields', 'news_fields': 'news.fields',
    'public_key_fields': 'public_key.fields', 'chat_conversation_fields': 'chat_conversation.fields',
    'analytics.fields': 'analytics.fields',
}

# Parameters that do not map 1:1 onto an X request parameter. Values are (location, target, note).
SPECIAL = {
    'CREATION_OF_A_POST': {
        'media_media_ids': ('body', 'media.media_ids', 'Flattened Composio field mapped to nested X body.'),
        'media_tagged_user_ids': ('body', 'media.tagged_user_ids', 'Flattened Composio field mapped to nested X body.'),
        'poll_options': ('body', 'poll.options', 'Flattened Composio field mapped to nested X body.'),
        'poll_duration_minutes': ('body', 'poll.duration_minutes', 'Flattened Composio field mapped to nested X body.'),
        'poll_reply_settings': ('body', 'poll.reply_settings', 'X spec 2.174 states poll.reply_settings is accepted for compatibility but dropped before the mutation.'),
        'reply_in_reply_to_tweet_id': ('body', 'reply.in_reply_to_tweet_id', 'Flattened Composio field mapped to nested X body.'),
        'reply_exclude_reply_user_ids': ('body', 'reply.exclude_reply_user_ids', 'Flattened Composio field mapped to nested X body.'),
        'geo_place_id': ('body', 'geo.place_id', 'Flattened Composio field mapped to nested X body.'),
    },
    'BOOKMARKS_BY_USER': {
        'composio_execution_message': ('ignored', None, 'Composio-internal field; accepted for drop-in compatibility, never forwarded to X.'),
    },
    'UPLOAD_MEDIA': {
        'media': ('body', 'media', 'Composio file object replaced by {base64|path, mime_type, filename}; bytes are sent base64-encoded in a JSON body.'),
        'shared': ('rejected', None, 'X MediaUploadRequest (additionalProperties=false) has no `shared`; setting it returns a validation error pointing to TWITTER_UPLOAD_LARGE_MEDIA.'),
        'media_type': ('local', None, 'Not part of X MediaUploadRequest; used locally to infer media_category (image/* -> tweet_image, text/srt|text/vtt -> subtitles).'),
    },
    'UPLOAD_LARGE_MEDIA': {
        'media': ('composite', None, 'Read locally, then INITIALIZE (media_type,total_bytes) -> APPEND chunks (base64, segment_index) -> FINALIZE -> poll STATUS.'),
    },
}

# Per-tool notes and discrepancies resolved against official X documentation.
NOTES = {
    'RECENT_SEARCH': ['Composio auto-paginates max_results up to 2000; this server returns one page and validates X bounds (10-100). Continue with meta.next_token.'],
    'FULL_ARCHIVE_SEARCH': ['Composio auto-paginates; this server returns one page and validates X bounds (10-500, per docs.x.com rate-limit page).'],
    'BOOKMARKS_BY_USER': ['`id` optional: resolved via GET /2/users/me when omitted (one extra billable request, cached per process).'],
    'FOLLOW_USER': ['`id` optional: resolved via GET /2/users/me when omitted.'],
    'MUTE_USER': ['`id` optional: resolved via GET /2/users/me when omitted.'],
    'UNMUTE_USER': ['No source user parameter in Composio: source_user_id resolved via GET /2/users/me.'],
    'UNFOLLOW_USER': ['`source_user_id` optional: resolved via GET /2/users/me when omitted.'],
    'REMOVE_POST_FROM_BOOKMARKS': ['`id` optional: resolved via GET /2/users/me when omitted.'],
    'UNPIN_LIST': ['`id` optional: resolved via GET /2/users/me when omitted.'],
    'UNRETWEET_POST': ['`id` optional: resolved via GET /2/users/me when omitted.'],
    'RETWEET_POST': ['No user id parameter in Composio: path id resolved via GET /2/users/me.'],
    'USER_HOME_TIMELINE_BY_USER_ID': ['`id` optional: resolved via GET /2/users/me when omitted.'],
    'ADD_POST_TO_BOOKMARKS': ['X also accepts folder_id/tweet_ids; not exposed because the Composio baseline does not include them.'],
    'CREATION_OF_A_POST': ['X body also has community_id, edit_options, made_with_ai, paid_partnership, share_with_followers; not exposed (outside Composio baseline).',
                           'Non-idempotent write: never retried automatically.'],
    'UPLOAD_LARGE_MEDIA': ['Composite operation; no automatic retry of APPEND/FINALIZE.'],
    'INITIALIZE_MEDIA_UPLOAD': ['Composio has no FINALIZE tool, so INITIALIZE/APPEND alone cannot complete an upload. This server adds extra tool X_FINALIZE_MEDIA_UPLOAD (finalizeMediaUpload); it is not counted toward Composio coverage.'],
    'APPEND_MEDIA_UPLOAD': ['See INITIALIZE_MEDIA_UPLOAD note about the missing FINALIZE tool.'],
    'GET_MEDIA_UPLOAD_STATUS': ['Sends command=STATUS.'],
    'STREAM_POST_LABELS': ['Streaming endpoint: the tool reads a bounded window (max_events / timeout_seconds extensions) and then closes the connection. Composio states Enterprise access + app-only auth is required.'],
    'GET_POST_ANALYTICS': ['Composio states an Enterprise plan is required (403 otherwise). docs.x.com reference does not state a plan restriction; unverified live.'],
    'GET_USER_PUBLIC_KEYS': ['X also exposes batch GET /2/users/public_keys; Composio requires a single id so /2/users/{id}/public_keys is used.'],
    'LIST_CHAT_CONVERSATIONS': ['max_results follows the X bound (1-1000) rather than Composio\'s 1-100.', 'X exposes extra filters (is_archived, is_muted, participant_ids, participant_query, start_time, end_time, type, unread_only); not exposed (outside Composio baseline).'],
    'CREATE_ACTIVITY_SUBSCRIPTION': ['X spec event_type enum is a superset of Composio\'s; the official X enum is used for validation. X `expires_at` is not exposed (outside Composio baseline).'],
    'GET_OPENAPI_SPEC': ['Unauthenticated; returns a large (~1.3 MB) document.'],
    'GET_POST_USAGE': ['App-only bearer token required.'],
    'GET_SPACE_POSTS': ['X supports pagination_token on this endpoint but the Composio baseline does not expose it; not exposed.'],
    'UPLOAD_MEDIA': ['Single-request upload capped at 5 MiB (Composio guidance); media_category inferred from MIME type when omitted.'],
    'GET_COMPLIANCE_JOBS': ['Composio status enum includes `expired`, which is absent from the X spec enum; it is rejected locally.'],
}

GLOBAL_DISCREPANCIES = [
    'X OpenAPI 2.174 names the post field-selection parameter `post.fields` (PostFieldsParameter) on most endpoints, while docs.x.com/x-api/fundamentals/fields, inline stream parameters in the same spec, and Composio use `tweet.fields`. This server sends `tweet.fields` (documented wire name); unverified against the live API.',
    'X uses pay-per-usage pricing (docs.x.com/x-api/getting-started/pricing): every live call is billable. Official reference pages do not state per-endpoint plan restrictions; Composio descriptions claim Enterprise-only access for some tools (recorded per tool, unverified).',
    'Numeric bounds, id patterns and required fields follow the X spec where Composio descriptions differ.',
    'Where Composio and X enums differ (see x_enum per parameter), input validation uses the official X enum.',
    'Composio input `max_results` descriptions advertise automatic multi-page fetching; this server returns a single page and surfaces meta.next_token.',
]

SEC = {'BearerToken': 'app_bearer', 'OAuth2UserToken': 'oauth2_user', 'UserToken': 'oauth1_user'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--composio', required=True)
    ap.add_argument('--openapi', required=True)
    ap.add_argument('--ratelimits', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()

    comp = json.load(open(a.composio))
    spec = json.load(open(a.openapi))
    S = spec['components']['schemas']
    P = spec['components']['parameters']
    rl_md = open(a.ratelimits).read()

    ops = {}
    for path, item in spec['paths'].items():
        for m, op in item.items():
            if isinstance(op, dict) and 'operationId' in op:
                ops[op['operationId']] = (m.upper(), path, op)

    def resolve(s):
        while isinstance(s, dict) and '$ref' in s:
            s = S[s['$ref'].split('/')[-1]]
        return s

    def params_of(op):
        out = {}
        for x in op.get('parameters', []):
            if '$ref' in x:
                x = P[x['$ref'].split('/')[-1]]
            out[x['name']] = x
        return out

    def body_props(op):
        for ct, v in op.get('requestBody', {}).get('content', {}).items():
            return ct, resolve(v['schema']).get('properties', {})
        return None, {}

    def norm(p):
        return re.sub(r'\{[^}]+\}|:[a-z_]+', '{}', p)

    rate = {}
    for row in re.finditer(r'^\| (GET|POST|PUT|DELETE) \| `([^`]+)` \| ([^|]*) \| ([^|]*) \|', rl_md, re.M):
        rate[(row.group(1), norm(row.group(2)))] = {'per_app': row.group(3).strip(), 'per_user': row.group(4).strip()}

    errors = []
    tools = []
    slugs = [t['slug'] for t in comp['tools']]
    for t in comp['tools']:
        key = t['slug'][len('TWITTER_'):]
        if key not in MAP:
            errors.append(f'unmapped tool {t["slug"]}')
            continue
        oids, scope = MAP[key]
        oid_list = oids if isinstance(oids, list) else [oids]
        endpoints = []
        for oid in oid_list:
            if oid not in ops:
                errors.append(f'{t["slug"]}: operation {oid} missing from spec')
                continue
            m, path, op = ops[oid]
            auth, scopes = [], set()
            for req in op.get('security', spec.get('security', [])):
                for k, v in req.items():
                    if SEC.get(k) and SEC[k] not in auth:
                        auth.append(SEC[k])
                    if k == 'OAuth2UserToken':
                        scopes.update(v)
            endpoints.append({'operationId': oid, 'method': m, 'path': path, 'auth': auth,
                              'oauth2_scopes': sorted(scopes), 'rate_limit': rate.get((m, norm(path)))})
        if not endpoints:
            continue
        m, path, op = ops[oid_list[0]]
        qp = params_of(op)
        ct, bp = body_props(op)
        mapped = []
        for prm in t['params']:
            n = prm['name']
            special = SPECIAL.get(key, {}).get(n)
            entry = {'composio': n, 'type': prm['type'], 'required': prm['required']}
            if prm['enum']:
                entry['composio_enum'] = prm['enum']
            if special:
                entry.update({'in': special[0], 'x': special[1], 'note': special[2]})
            elif n in qp:
                entry.update({'in': qp[n]['in'], 'x': n})
            elif n in FIELD_PARAM:
                xname = FIELD_PARAM[n]
                alt = 'post.fields' if n == 'tweet_fields' else xname
                if xname in qp or alt in qp:
                    entry.update({'in': 'query', 'x': xname})
                else:
                    errors.append(f'{t["slug"]}: field param {n} not on {oid_list[0]}')
            elif n in bp:
                entry.update({'in': 'body', 'x': n})
            else:
                errors.append(f'{t["slug"]}: param {n} cannot be placed on {oid_list[0]}')
            # enum drift against the official spec
            xs = None
            if entry.get('in') == 'body' and entry.get('x') in bp:
                xs = resolve(bp[entry['x']])
            elif entry.get('in') in ('query', 'path') and entry.get('x') in qp:
                xs = qp[entry['x']].get('schema', {})
                xs = resolve(xs)
            if xs and prm['enum'] and xs.get('enum') and set(prm['enum']) != set(xs['enum']):
                entry['x_enum'] = xs['enum']
            mapped.append(entry)
        pagination = None
        exposed = {p['name'] for p in t['params']}
        x_paginates = 'pagination_token' in qp or 'next_token' in qp
        token_params = [n for n in ('pagination_token', 'next_token') if n in qp and n in exposed]
        if token_params:
            pagination = {'request_param': token_params[0], 'response_field': 'meta.next_token'}
        tools.append({
            'name': t['slug'],
            'title': t['title'],
            'scope': scope,
            'kind': 'composite' if len(endpoints) > 1 else 'http',
            'mutation': any(e['method'] != 'GET' for e in endpoints),
            'endpoints': endpoints,
            'request_body': ct,
            'params': mapped,
            'pagination': pagination,
            'x_supports_pagination': x_paginates,
            'notes': NOTES.get(key, []),
            'composio_description': t['description'],
        })

    extra_keys = set(MAP) - {s[len('TWITTER_'):] for s in slugs}
    if extra_keys:
        errors.append(f'mapping has unknown tools: {sorted(extra_keys)}')
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        sys.exit(1)

    by_auth = lambda pred: sorted(t['name'] for t in tools if pred(t['endpoints']))
    oauth_summary = {
        'oauth2_user_capable': len(by_auth(lambda eps: all('oauth2_user' in e['auth'] for e in eps))),
        'app_only': by_auth(lambda eps: eps[0]['auth'] == ['app_bearer']),
        'unauthenticated': by_auth(lambda eps: eps[0]['auth'] == []),
        'oauth1_user_only': by_auth(lambda eps: any(e['auth'] == ['oauth1_user'] for e in eps)),
        'note': 'Every user-context tool accepts OAuth 2.0 user tokens, so no 3-legged OAuth 1.0a authorization flow is required; OAuth 1.0a remains available via environment credentials. App-only tools require X_BEARER_TOKEN and never receive user tokens.',
    }
    manifest = {
        'schema_version': 1,
        'baseline': {'provider': 'composio', 'toolkit': comp['toolkit'], 'version': comp['version'],
                     'source': comp['source'], 'retrieved': comp['retrieved'], 'tool_count': len(comp['tools'])},
        'x_api': {'openapi_title': spec['info']['title'], 'openapi_version': spec['info']['version'],
                  'source': 'https://api.x.com/2/openapi.json',
                  'rate_limits_source': 'https://docs.x.com/x-api/fundamentals/rate-limits.md'},
        'global_discrepancies': GLOBAL_DISCREPANCIES,
        'extra_tools': [
            {'name': 'X_FINALIZE_MEDIA_UPLOAD', 'operationId': 'finalizeMediaUpload',
             'reason': 'Completes the chunked upload lifecycle that Composio exposes only partially; not counted as Composio coverage.'},
            {'name': 'X_AUTH_CONNECT', 'operationId': None,
             'reason': 'Starts OAuth 2.0 Authorization Code with PKCE (S256) for an X account; returns the authorize URL only.'},
            {'name': 'X_AUTH_STATUS', 'operationId': None,
             'reason': 'Lists connected accounts, granted scopes and expiry without exposing tokens.'},
            {'name': 'X_AUTH_DISCONNECT', 'operationId': None,
             'reason': 'Revokes (POST /2/oauth2/revoke) and deletes the active connected account.'},
        ],
        'oauth': oauth_summary,
        'tools': sorted(tools, key=lambda x: x['name']),
    }
    with open(a.out, 'w') as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print(f'{len(tools)} tools written to {a.out}')


if __name__ == '__main__':
    main()
