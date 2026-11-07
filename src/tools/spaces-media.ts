import { z } from 'zod';
import { decodeBase64, mediaInputSchema } from '../media.js';
import type { XResponse } from '../x/client.js';
import { invalidInput, XApiError } from '../x/errors.js';
import { customTool, httpTool, success, type ToolContext, type ToolDefinition } from './framework.js';
import { expansions, fields, idList, maxResults, paginationToken, postExpansionFields, userExpansionFields, xId } from './schemas.js';

const scope = 'spaces-media' as const;
const SPACES_AUTH = ['oauth2_user', 'app_bearer'] as const;
const MEDIA_AUTH = ['oauth2_user', 'oauth1_user'] as const;

const spaceId = z
  .string()
  .regex(/^[a-zA-Z0-9]{1,13}$/, 'Space ids are 1-13 alphanumeric characters')
  .describe('Space id (1-13 alphanumeric characters).');

const spaceFields = {
  expansions,
  user_fields: fields('User'),
  space_fields: fields('Space'),
  topic_fields: fields('Topic'),
};

export const spaceTools: ToolDefinition[] = [
  httpTool({
    name: 'TWITTER_GET_SPACE_BY_ID',
    title: 'Get a Space',
    description: 'Returns one Space by id.',
    scope,
    operationId: 'getSpacesById',
    method: 'GET',
    path: '/2/spaces/{id}',
    auth: SPACES_AUTH,
    input: { id: spaceId, ...spaceFields },
  }),
  httpTool({
    name: 'TWITTER_GET_SPACES_BY_IDS',
    title: 'Get Spaces by ids',
    description: 'Returns up to 100 Spaces by id.',
    scope,
    operationId: 'getSpacesByIds',
    method: 'GET',
    path: '/2/spaces',
    auth: SPACES_AUTH,
    input: { ids: z.array(spaceId).min(1).max(100).describe('Space ids (1-100).'), ...spaceFields },
  }),
  httpTool({
    name: 'TWITTER_GET_SPACES_BY_CREATORS',
    title: 'Get Spaces by creators',
    description: 'Returns live or scheduled Spaces created by up to 100 users.',
    scope,
    operationId: 'getSpacesByCreatorIds',
    method: 'GET',
    path: '/2/spaces/by/creator_ids',
    auth: SPACES_AUTH,
    input: { user_ids: idList('Creator user ids'), ...spaceFields },
  }),
  httpTool({
    name: 'TWITTER_SEARCH_SPACES',
    title: 'Search Spaces',
    description: 'Searches live and scheduled Spaces by title text.',
    scope,
    operationId: 'searchSpaces',
    method: 'GET',
    path: '/2/spaces/search',
    auth: SPACES_AUTH,
    input: {
      query: z.string().min(1).max(2048).describe('Text to match in Space titles.'),
      state: z.enum(['live', 'scheduled', 'all']).optional().describe('Space state filter (default all).'),
      max_results: maxResults(1, 100),
      ...spaceFields,
    },
  }),
  httpTool({
    name: 'TWITTER_GET_SPACE_POSTS',
    title: 'Get posts shared in a Space',
    description: 'Returns posts shared in a Space (1-100).',
    scope,
    operationId: 'getSpacesPosts',
    method: 'GET',
    path: '/2/spaces/{id}/tweets',
    auth: SPACES_AUTH,
    input: { id: spaceId, max_results: maxResults(1, 100), ...postExpansionFields },
  }),
  httpTool({
    name: 'TWITTER_GET_SPACE_TICKET_BUYERS',
    title: 'Get Space ticket buyers',
    description: 'Returns users who bought tickets to a ticketed Space created by the authenticated user. OAuth 2.0 user token required.',
    scope,
    operationId: 'getSpacesBuyers',
    method: 'GET',
    path: '/2/spaces/{id}/buyers',
    auth: ['oauth2_user'],
    input: { id: spaceId, max_results: maxResults(1, 100), pagination_token: paginationToken, ...userExpansionFields },
  }),
];

/** X v2 media upload enums (OpenAPI 2.174). */
const MEDIA_TYPES = [
  'video/mp4', 'video/webm', 'video/mp2t', 'video/quicktime', 'text/srt', 'text/vtt', 'image/jpeg', 'image/gif',
  'image/bmp', 'image/png', 'image/webp', 'image/pjpeg', 'image/tiff', 'model/gltf-binary', 'model/vnd.usdz+zip',
] as const;
const CHUNKED_CATEGORIES = ['amplify_video', 'tweet_gif', 'tweet_image', 'tweet_video', 'dm_gif', 'dm_image', 'dm_video', 'subtitles'] as const;
const SIMPLE_CATEGORIES = ['tweet_image', 'tweet_video', 'tweet_gif', 'dm_image', 'dm_video', 'dm_gif', 'subtitles'] as const;

/** One-shot upload limit stated by the Composio baseline for TWITTER_UPLOAD_MEDIA (images/subtitles). */
const SIMPLE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
/** Chunk size for TWITTER_UPLOAD_LARGE_MEDIA appends. */
export const APPEND_CHUNK_BYTES = 4 * 1024 * 1024;

const additionalOwners = idList('User ids allowed to use the media id', 100).optional();
const mediaId = xId('Media id');

function inferSimpleCategory(mime: string | undefined): (typeof SIMPLE_CATEGORIES)[number] {
  if (mime === 'text/srt' || mime === 'text/vtt') return 'subtitles';
  if (mime?.startsWith('image/') && mime !== 'image/gif') return 'tweet_image';
  throw invalidInput('media_category is required unless media is a non-GIF image or an SRT/VTT subtitle file');
}

export function inferChunkedCategory(mime: string): (typeof CHUNKED_CATEGORIES)[number] {
  if (mime === 'image/gif') return 'tweet_gif';
  if (mime.startsWith('video/')) return 'tweet_video';
  if (mime === 'text/srt' || mime === 'text/vtt') return 'subtitles';
  if (mime.startsWith('image/')) return 'tweet_image';
  throw invalidInput(`Cannot infer media_category for ${mime}; set media_category explicitly`);
}

function dataId(res: XResponse, step: string): string {
  const id = (res.data as { data?: { id?: unknown } } | undefined)?.data?.id;
  if (typeof id !== 'string' || !/^\d{1,19}$/.test(id)) {
    throw new XApiError('unexpected_response', `${step} response did not include a media id`);
  }
  return id;
}

interface ProcessingInfo {
  state?: string;
  check_after_secs?: number;
  progress_percent?: number;
}

function processingInfo(res: XResponse): ProcessingInfo | undefined {
  const info = (res.data as { data?: { processing_info?: unknown } } | undefined)?.data?.processing_info;
  return typeof info === 'object' && info !== null ? (info as ProcessingInfo) : undefined;
}

function appendForm(chunk: Uint8Array, segmentIndex: number): FormData {
  const form = new FormData();
  form.append('media', new Blob([Uint8Array.from(chunk)]), 'chunk');
  form.append('segment_index', String(segmentIndex));
  return form;
}

async function finalize(ctx: ToolContext, id: string): Promise<XResponse> {
  return ctx.client.request({ method: 'POST', path: `/2/media/upload/${id}/finalize`, auth: MEDIA_AUTH, signal: ctx.signal });
}

async function status(ctx: ToolContext, id: string): Promise<XResponse> {
  return ctx.client.request({
    method: 'GET',
    path: '/2/media/upload',
    query: { media_id: id, command: 'STATUS' },
    auth: MEDIA_AUTH,
    signal: ctx.signal,
  });
}

/** Polls STATUS while processing is pending, bounded by X_MCP_MEDIA_PROCESSING_TIMEOUT_MS. */
async function awaitProcessing(ctx: ToolContext, id: string, finalized: XResponse) {
  let latest = finalized;
  let info = processingInfo(latest);
  let waited = 0;
  const polls: ProcessingInfo[] = [];
  while (info && (info.state === 'pending' || info.state === 'in_progress')) {
    const delayMs = Math.max(1, Math.min(info.check_after_secs ?? 5, 60)) * 1000;
    if (waited + delayMs > ctx.config.mediaProcessingTimeoutMs) {
      throw new XApiError(
        'media_processing',
        `Media ${id} is still ${info.state} after ${Math.round(waited / 1000)}s; poll TWITTER_GET_MEDIA_UPLOAD_STATUS before attaching it.`,
      );
    }
    await ctx.client.wait(delayMs);
    waited += delayMs;
    latest = await status(ctx, id);
    info = processingInfo(latest);
    if (info) polls.push(info);
  }
  if (info?.state === 'failed') {
    throw new XApiError('media_processing', `X failed to process media ${id}; upload it again.`, {
      detail: JSON.stringify(info),
    });
  }
  return { latest, polls };
}

export const mediaTools: ToolDefinition[] = [
    customTool({
      name: 'TWITTER_UPLOAD_MEDIA',
      title: 'Upload media (single request)',
      description:
        'Uploads one image or SRT/VTT subtitle file up to 5 MiB in a single request and returns its media id. Use TWITTER_UPLOAD_LARGE_MEDIA for GIFs, videos or larger files.',
      scope,
      operationIds: ['mediaUpload'],
      auth: MEDIA_AUTH,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      input: {
        media: mediaInputSchema,
        media_type: z
          .string()
          .regex(/^[a-z]+\/[a-z0-9.+-]+$/)
          .optional()
          .describe('MIME type used to infer media_category (text/srt or text/vtt for subtitles). Not sent to X.'),
        media_category: z.enum(SIMPLE_CATEGORIES).optional().describe('Media category; inferred from the MIME type when omitted.'),
        shared: z
          .boolean()
          .optional()
          .describe('Not supported by the single-request endpoint; true is rejected (use TWITTER_UPLOAD_LARGE_MEDIA).'),
        additional_owners: additionalOwners,
      },
      async run(args, ctx) {
        if (args.shared === true) {
          throw invalidInput('shared is not supported by POST /2/media/upload; use TWITTER_UPLOAD_LARGE_MEDIA');
        }
        const loaded = await ctx.media.load(args.media, SIMPLE_UPLOAD_MAX_BYTES);
        const mime = args.media_type ?? loaded.mimeType;
        const category = args.media_category ?? inferSimpleCategory(mime);
        const body: Record<string, unknown> = { media: loaded.bytes.toString('base64'), media_category: category };
        if (args.additional_owners) body.additional_owners = args.additional_owners.join(',');
        const res = await ctx.client.request({
          method: 'POST',
          path: '/2/media/upload',
          body: { kind: 'json', value: body },
          auth: MEDIA_AUTH,
          signal: ctx.signal,
        });
        return success(res);
      },
    }),
    customTool({
      name: 'TWITTER_UPLOAD_LARGE_MEDIA',
      title: 'Upload media (chunked)',
      description:
        'Uploads a GIF, video, image or subtitle file with the chunked flow: INITIALIZE, APPEND in 4 MiB chunks, FINALIZE, then polls STATUS until processing succeeds (bounded by X_MCP_MEDIA_PROCESSING_TIMEOUT_MS). No step is retried automatically.',
      scope,
      operationIds: ['initializeMediaUpload', 'appendMediaUpload', 'finalizeMediaUpload', 'getMediaUploadStatus'],
      auth: MEDIA_AUTH,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      input: {
        media: mediaInputSchema,
        media_category: z.enum(CHUNKED_CATEGORIES).optional().describe('Media category; inferred from the MIME type when omitted. Use amplify_video for videos over 140 seconds.'),
        shared: z.boolean().optional().describe('Whether the media may be shared.'),
        additional_owners: additionalOwners,
      },
      async run(args, ctx) {
        const loaded = await ctx.media.load(args.media);
        const mime = loaded.mimeType;
        if (!mime || !(MEDIA_TYPES as readonly string[]).includes(mime)) {
          throw invalidInput(`media MIME type must be one of ${MEDIA_TYPES.join(', ')}; set media.mime_type`);
        }
        const category = args.media_category ?? inferChunkedCategory(mime);
        const init: Record<string, unknown> = { media_type: mime, total_bytes: loaded.bytes.length, media_category: category };
        if (args.shared !== undefined) init.shared = args.shared;
        if (args.additional_owners) init.additional_owners = args.additional_owners;
        const initialized = await ctx.client.request({
          method: 'POST',
          path: '/2/media/upload/initialize',
          body: { kind: 'json', value: init },
          auth: MEDIA_AUTH,
          signal: ctx.signal,
        });
        const id = dataId(initialized, 'INITIALIZE');
        let segments = 0;
        for (let offset = 0; offset < loaded.bytes.length; offset += APPEND_CHUNK_BYTES) {
          if (segments > 9999) throw invalidInput('media needs more than 10000 segments');
          await ctx.client.request({
            method: 'POST',
            path: `/2/media/upload/${id}/append`,
            body: { kind: 'multipart', value: appendForm(loaded.bytes.subarray(offset, offset + APPEND_CHUNK_BYTES), segments) },
            auth: MEDIA_AUTH,
            signal: ctx.signal,
          });
          segments++;
        }
        const finalized = await finalize(ctx, id);
        const { latest, polls } = await awaitProcessing(ctx, id, finalized);
        return success(latest, { media_id: id, segments, media_category: category, status_polls: polls.length });
      },
    }),
    httpTool({
      name: 'TWITTER_INITIALIZE_MEDIA_UPLOAD',
      title: 'Initialize a chunked media upload',
      description:
        'Starts a chunked upload session and returns the media id. Continue with TWITTER_APPEND_MEDIA_UPLOAD, then X_FINALIZE_MEDIA_UPLOAD.',
      scope,
      operationId: 'initializeMediaUpload',
      method: 'POST',
      path: '/2/media/upload/initialize',
      auth: MEDIA_AUTH,
      input: {
        media_type: z.enum(MEDIA_TYPES).describe('MIME type of the file.'),
        total_bytes: z.number().int().min(0).max(17_179_869_184).describe('Total file size in bytes.'),
        media_category: z.enum(CHUNKED_CATEGORIES).optional().describe('Media category.'),
        shared: z.boolean().optional().describe('Whether the media may be shared.'),
        additional_owners: additionalOwners,
      },
    }),
    customTool({
      name: 'TWITTER_APPEND_MEDIA_UPLOAD',
      title: 'Append a media chunk',
      description: 'Uploads one base64-encoded chunk (segment) of a chunked upload session. Not retried automatically.',
      scope,
      operationIds: ['appendMediaUpload'],
      auth: MEDIA_AUTH,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      input: {
        id: mediaId.describe('Media id returned by INITIALIZE.'),
        media: z.string().min(1).describe('Chunk bytes, base64-encoded.'),
        segment_index: z.number().int().min(0).max(9999).describe('Zero-based segment index (0-9999).'),
      },
      async run(args, ctx) {
        const chunk = decodeBase64(args.media, ctx.config.maxMediaBytes, 'media');
        const res = await ctx.client.request({
          method: 'POST',
          path: `/2/media/upload/${args.id}/append`,
          body: { kind: 'multipart', value: appendForm(chunk, args.segment_index) },
          auth: MEDIA_AUTH,
          signal: ctx.signal,
        });
        return success(res, { media_id: args.id, segment_index: args.segment_index, bytes: chunk.length });
      },
    }),
    httpTool({
      name: 'X_FINALIZE_MEDIA_UPLOAD',
      title: 'Finalize a chunked media upload',
      description:
        'Completes a chunked upload session after all APPEND calls. If the response includes processing_info, poll TWITTER_GET_MEDIA_UPLOAD_STATUS until state is succeeded. Extra tool: Composio exposes no FINALIZE step.',
      scope,
      composio: false,
      operationId: 'finalizeMediaUpload',
      method: 'POST',
      path: '/2/media/upload/{id}/finalize',
      auth: MEDIA_AUTH,
      input: { id: mediaId.describe('Media id returned by INITIALIZE.') },
    }),
    httpTool({
      name: 'TWITTER_GET_MEDIA_UPLOAD_STATUS',
      title: 'Get media processing status',
      description:
        'Returns processing status for an uploaded video or GIF. Poll no faster than processing_info.check_after_secs; attach the media only once state is succeeded.',
      scope,
      operationId: 'getMediaUploadStatus',
      method: 'GET',
      path: '/2/media/upload',
      auth: MEDIA_AUTH,
      input: { media_id: mediaId },
      constQuery: { command: 'STATUS' },
    }),
  ];
