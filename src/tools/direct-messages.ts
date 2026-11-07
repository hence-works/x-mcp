import { z } from 'zod';
import { invalidInput } from '../x/errors.js';
import { httpTool, type ToolDefinition } from './framework.js';
import { expansions, fields, idList, maxResults, paginationToken, xId } from './schemas.js';

const USER_CONTEXT = ['oauth2_user', 'oauth1_user'] as const;
const scope = 'direct-messages' as const;

const attachments = z
  .array(z.strictObject({ media_id: xId('Media id (upload with a dm_* media category first)') }))
  .min(1)
  .max(1)
  .optional()
  .describe('Media attachment as [{ "media_id": "..." }]. Upload first with a dm_image, dm_gif or dm_video category.');

const dmText = z.string().min(1).max(10_000).optional().describe('Message text.');

/** DM conversation id: "<user>-<user>" for one-to-one, or a numeric group id. */
const dmConversationId = (what: string) =>
  z
    .string()
    .regex(/^([0-9]{1,19}-[0-9]{1,19}|[0-9]{15,19})$/, `${what} must be "<userId>-<userId>" or a numeric group conversation id`)
    .describe(`${what}: "<userId>-<userId>" for one-to-one conversations or a numeric group conversation id.`);

const eventTypes = z
  .array(z.enum(['MessageCreate', 'ParticipantsJoin', 'ParticipantsLeave']))
  .min(1)
  .optional()
  .describe('DM event types to return.');

const dmEventFields = {
  expansions,
  dm_event_fields: fields('DM event'),
  user_fields: fields('User'),
  media_fields: fields('Media'),
  tweet_fields: fields('Post'),
};

const dmPage = {
  event_types: eventTypes,
  max_results: maxResults(1, 100),
  pagination_token: paginationToken,
  ...dmEventFields,
};

function requireTextOrAttachment(args: { text?: string; attachments?: unknown[] }) {
  if (args.text === undefined && args.attachments === undefined) throw invalidInput('Provide text and/or attachments');
}

export const directMessageTools: ToolDefinition[] = [
  httpTool({
    name: 'TWITTER_CREATE_DM_CONVERSATION',
    title: 'Create a group DM conversation',
    description:
      'Creates a group Direct Message conversation with 2-49 other participants and sends the first message. Sends a real message; never retried automatically.',
    scope,
    operationId: 'createDirectMessagesConversation',
    method: 'POST',
    path: '/2/dm_conversations',
    auth: USER_CONTEXT,
    input: {
      conversation_type: z.literal('Group').describe('Must be "Group".'),
      participant_ids: idList('Participant user ids, excluding the authenticated user', 49).min(2),
      message: z
        .strictObject({ text: dmText, attachments })
        .describe('First message: { "text": "...", "attachments": [{ "media_id": "..." }] }.'),
    },
    check(args) {
      requireTextOrAttachment(args.message);
    },
  }),
  httpTool({
    name: 'TWITTER_SEND_A_NEW_MESSAGE_TO_A_USER',
    title: 'Send a DM to a user',
    description: 'Sends a Direct Message to a user (one-to-one conversation). Sends a real message; never retried automatically.',
    scope,
    operationId: 'createDirectMessagesByParticipantId',
    method: 'POST',
    path: '/2/dm_conversations/with/{participant_id}/messages',
    auth: USER_CONTEXT,
    input: { participant_id: xId('Recipient user id'), text: dmText, attachments },
    check: requireTextOrAttachment,
  }),
  httpTool({
    name: 'TWITTER_SEND_DM_TO_CONVERSATION',
    title: 'Send a DM to a conversation',
    description: 'Sends a Direct Message to an existing conversation. Sends a real message; never retried automatically.',
    scope,
    operationId: 'createDirectMessagesByConversationId',
    method: 'POST',
    path: '/2/dm_conversations/{dm_conversation_id}/messages',
    auth: USER_CONTEXT,
    input: { dm_conversation_id: dmConversationId('Conversation id'), text: dmText, attachments },
    check: requireTextOrAttachment,
  }),
  httpTool({
    name: 'TWITTER_DELETE_DM',
    title: 'Delete a DM event',
    description: 'Deletes a Direct Message event sent by the authenticated user. Irreversible.',
    scope,
    operationId: 'deleteDirectMessagesEvents',
    method: 'DELETE',
    path: '/2/dm_events/{event_id}',
    auth: USER_CONTEXT,
    input: { event_id: xId('DM event id') },
  }),
  httpTool({
    name: 'TWITTER_GET_DM_EVENT',
    title: 'Get a DM event',
    description: 'Returns one Direct Message event by id.',
    scope,
    operationId: 'getDirectMessagesEventsById',
    method: 'GET',
    path: '/2/dm_events/{event_id}',
    auth: USER_CONTEXT,
    input: { event_id: xId('DM event id'), ...dmEventFields },
  }),
  httpTool({
    name: 'TWITTER_GET_RECENT_DM_EVENTS',
    title: 'Get recent DM events',
    description: "Returns recent Direct Message events across the authenticated user's conversations (1-100 per page).",
    scope,
    operationId: 'getDirectMessagesEvents',
    method: 'GET',
    path: '/2/dm_events',
    auth: USER_CONTEXT,
    input: dmPage,
  }),
  httpTool({
    name: 'TWITTER_GET_DM_CONVERSATION_EVENTS',
    title: 'Get DM events with a user',
    description: 'Returns Direct Message events in the one-to-one conversation with a user (1-100 per page).',
    scope,
    operationId: 'getDirectMessagesEventsByParticipantId',
    method: 'GET',
    path: '/2/dm_conversations/with/{participant_id}/dm_events',
    auth: USER_CONTEXT,
    input: { participant_id: xId('Other participant user id'), ...dmPage },
  }),
  httpTool({
    name: 'TWITTER_RETRIEVE_DM_CONVERSATION_EVENTS',
    title: 'Get DM events in a conversation',
    description: 'Returns Direct Message events in a conversation by conversation id (1-100 per page).',
    scope,
    operationId: 'getDirectMessagesEventsByConversationId',
    method: 'GET',
    path: '/2/dm_conversations/{id}/dm_events',
    auth: USER_CONTEXT,
    input: { id: dmConversationId('Conversation id'), ...dmPage },
  }),
];
