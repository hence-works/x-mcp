import type { ContractCase } from './types.js';

const U = '2244994945';
const CONV = '1582103724607971328';
const EVENT = '1580705921830768643';

export const directMessageCases: ContractCase[] = [
  {
    tool: 'TWITTER_CREATE_DM_CONVERSATION',
    args: {
      conversation_type: 'Group',
      participant_ids: ['944480690', '906948460078698496'],
      message: { text: 'Hello to you two', attachments: [{ media_id: '1583157113245011970' }] },
    },
    calls: [
      {
        method: 'POST',
        path: '/2/dm_conversations',
        body: {
          conversation_type: 'Group',
          participant_ids: ['944480690', '906948460078698496'],
          message: { text: 'Hello to you two', attachments: [{ media_id: '1583157113245011970' }] },
        },
      },
    ],
    replies: [{ status: 201, body: { data: { dm_conversation_id: CONV, dm_event_id: EVENT } } }],
  },
  {
    tool: 'TWITTER_SEND_A_NEW_MESSAGE_TO_A_USER',
    args: { participant_id: U, text: 'hi' },
    calls: [{ method: 'POST', path: `/2/dm_conversations/with/${U}/messages`, body: { text: 'hi' } }],
    replies: [{ status: 201, body: { data: { dm_conversation_id: `1-${U}`, dm_event_id: EVENT } } }],
  },
  {
    tool: 'TWITTER_SEND_DM_TO_CONVERSATION',
    label: 'attachment only, one-to-one id',
    args: { dm_conversation_id: `123-${U}`, attachments: [{ media_id: '1583157113245011970' }] },
    calls: [
      {
        method: 'POST',
        path: `/2/dm_conversations/123-${U}/messages`,
        body: { attachments: [{ media_id: '1583157113245011970' }] },
      },
    ],
  },
  {
    tool: 'TWITTER_DELETE_DM',
    args: { event_id: EVENT },
    calls: [{ method: 'DELETE', path: `/2/dm_events/${EVENT}` }],
    replies: [{ body: { data: { deleted: true } } }],
  },
  {
    tool: 'TWITTER_GET_DM_EVENT',
    args: { event_id: EVENT, dm_event_fields: ['created_at', 'sender_id'], expansions: ['sender_id'] },
    calls: [{ method: 'GET', path: `/2/dm_events/${EVENT}`, query: { 'dm_event.fields': 'created_at,sender_id', expansions: 'sender_id' } }],
  },
  {
    tool: 'TWITTER_GET_RECENT_DM_EVENTS',
    args: { event_types: ['MessageCreate'], max_results: 100, pagination_token: 'abcdefghijklmnopq' },
    calls: [
      { method: 'GET', path: '/2/dm_events', query: { event_types: 'MessageCreate', max_results: '100', pagination_token: 'abcdefghijklmnopq' } },
    ],
  },
  {
    tool: 'TWITTER_GET_DM_CONVERSATION_EVENTS',
    args: { participant_id: U, media_fields: ['url'], tweet_fields: ['text'] },
    calls: [{ method: 'GET', path: `/2/dm_conversations/with/${U}/dm_events`, query: { 'media.fields': 'url', 'tweet.fields': 'text' } }],
  },
  {
    tool: 'TWITTER_RETRIEVE_DM_CONVERSATION_EVENTS',
    args: { id: CONV, event_types: ['ParticipantsJoin', 'ParticipantsLeave'], user_fields: ['username'] },
    calls: [
      { method: 'GET', path: `/2/dm_conversations/${CONV}/dm_events`, query: { event_types: 'ParticipantsJoin,ParticipantsLeave', 'user.fields': 'username' } },
    ],
  },
];
