import { z } from 'zod';

/** Numeric X identifier (users, posts, lists, media, DM events). */
export const xId = (what: string) =>
  z
    .string()
    .regex(/^[0-9]{1,19}$/, `${what} must be a numeric id of 1-19 digits`)
    .describe(`${what} (numeric string).`);

/** Path user id that defaults to the authenticated user. */
export const meId = (what = 'User id') =>
  z
    .union([z.literal('me'), z.string().regex(/^[0-9]{1,19}$/, `${what} must be a numeric id or "me"`)])
    .optional()
    .describe(`${what}. Omit or pass "me" to use the authenticated user (resolved via GET /2/users/me).`);

export const idList = (what: string, max = 100) =>
  z
    .array(z.string().regex(/^[0-9]{1,19}$/, `${what} entries must be numeric ids`))
    .min(1)
    .max(max)
    .describe(`${what} (1-${max} numeric ids).`);

const fieldToken = z.string().regex(/^[a-z0-9_.]{1,64}$/, 'field names are lowercase identifiers');

export const fields = (objectName: string) =>
  z
    .array(fieldToken)
    .min(1)
    .optional()
    .describe(`${objectName} fields to include (sent as a comma-separated list).`);

export const expansions = z
  .array(z.string().regex(/^[a-z0-9_.]{1,64}$/, 'expansions are dotted lowercase identifiers'))
  .min(1)
  .optional()
  .describe('Expansions to hydrate into `includes` (e.g. author_id, attachments.media_keys).');

export const paginationToken = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,512}$/, 'pagination tokens are opaque alphanumeric strings from meta.next_token')
  .optional()
  .describe('Opaque token from `meta.next_token` (or `meta.previous_token`) of a previous response.');

export const maxResults = (min: number, max: number) =>
  z.number().int().min(min).max(max).optional().describe(`Results per page (${min}-${max}).`);

export const timestamp = (what: string) =>
  z.iso
    .datetime({ offset: true })
    .optional()
    .describe(`${what} as an RFC 3339 UTC timestamp, e.g. 2026-11-01T00:00:00Z.`);

export const searchQuery = (maxLength: number) =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .describe(`X search query using X query operators (max ${maxLength} characters).`);

/** Shared field-selection shapes. */
export const postExpansionFields = {
  expansions,
  tweet_fields: fields('Post'),
  user_fields: fields('User'),
  media_fields: fields('Media'),
  place_fields: fields('Place'),
  poll_fields: fields('Poll'),
};

export const userExpansionFields = {
  expansions,
  user_fields: fields('User'),
  tweet_fields: fields('Post'),
};

export const timeBounds = {
  start_time: timestamp('Oldest time (inclusive)'),
  end_time: timestamp('Newest time (exclusive)'),
  since_id: xId('Return results newer than this post id').optional(),
  until_id: xId('Return results older than this post id').optional(),
};
