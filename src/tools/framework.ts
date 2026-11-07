import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import type { AuthKind, HttpMethod, XClient, XResponse } from '../x/client.js';
import { invalidInput, type RateLimitInfo } from '../x/errors.js';
import type { MediaReader } from '../media.js';
import type { CallbackListener } from '../auth/callback.js';
import type { AccountManager } from '../auth/manager.js';

export type ToolScope = 'posts-users' | 'lists-bookmarks-relationships' | 'direct-messages' | 'spaces-media' | 'platform' | 'auth';

export interface ToolContext {
  client: XClient;
  config: ServerConfig;
  media: MediaReader;
  signal?: AbortSignal;
  accounts?: AccountManager;
  callback?: CallbackListener;
}

/** Structured success payload returned as `structuredContent`. */
export interface ToolSuccess {
  /** Parsed X response body, unmodified. */
  data: unknown;
  rate_limit?: RateLimitInfo;
  pagination?: { next_token?: string; previous_token?: string };
  /** Auth type the X request used (oauth2_user, oauth1_user or app_bearer). */
  auth?: string;
  [key: string]: unknown;
}

export interface ToolAnnotationsLite {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  scope: ToolScope;
  /** `true` for tools counted toward Composio baseline coverage. */
  composio: boolean;
  /** Primary X operationId(s), used by the coverage test against coverage/manifest.json. */
  operationIds: readonly string[];
  /** Auth types accepted by the primary X operation (official spec security). */
  auth: readonly AuthKind[];
  /**
   * Input naming the acting user, which X requires to be the authenticated user. With a connected
   * account, any other value is rejected locally.
   */
  actingUserParam?: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  annotations: ToolAnnotationsLite;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolSuccess>;
}

/** Composio field-selection parameter -> X wire name (docs.x.com/x-api/fundamentals/fields). */
export const FIELD_PARAMS: Record<string, string> = {
  tweet_fields: 'tweet.fields',
  user_fields: 'user.fields',
  media_fields: 'media.fields',
  place_fields: 'place.fields',
  poll_fields: 'poll.fields',
  list_fields: 'list.fields',
  space_fields: 'space.fields',
  topic_fields: 'topic.fields',
  dm_event_fields: 'dm_event.fields',
  compliance_job_fields: 'compliance_job.fields',
  usage_fields: 'usage.fields',
  search_count_fields: 'search_count.fields',
  news_fields: 'news.fields',
  public_key_fields: 'public_key.fields',
  chat_conversation_fields: 'chat_conversation.fields',
  'analytics.fields': 'analytics.fields',
};

export interface ParamSpec {
  in: 'path' | 'query' | 'body' | 'ignored';
  /** Wire name; for body params a dotted path places the value in a nested object. */
  as?: string;
}

export interface HttpToolSpec<S extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  scope: ToolScope;
  operationId: string;
  method: HttpMethod;
  /** Official path template, e.g. `/2/users/{id}/tweets`. */
  path: string;
  auth: readonly AuthKind[];
  input: S;
  /** Overrides for parameter placement; defaults are inferred (see `placeParam`). */
  params?: Partial<Record<keyof S & string, ParamSpec>>;
  /**
   * Path parameters that default to the authenticated user's id when omitted or `me`
   * (may name a path parameter that is not an input at all).
   */
  meParams?: readonly string[];
  /** Constant query parameters, e.g. `command=STATUS`. */
  constQuery?: Record<string, string>;
  /** Cross-field validation that a flat Zod object cannot express (throws invalidInput). */
  check?: (args: z.infer<z.ZodObject<S>>) => void;
  /** Destructive per MCP annotations (deletes/removals). Defaults to DELETE method. */
  destructive?: boolean;
  /** Counted toward Composio baseline coverage (default true). */
  composio?: boolean;
  /** See ToolDefinition.actingUserParam; defaults to the first `meParams` entry. */
  actingUserParam?: keyof S & string;
}

function setPath(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (typeof next !== 'object' || next === null) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
}

function queryValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(',');
  return String(value);
}

export function placeParam(name: string, method: HttpMethod, pathParams: Set<string>, override?: ParamSpec): ParamSpec {
  if (override) return override;
  if (pathParams.has(name)) return { in: 'path', as: name };
  if (FIELD_PARAMS[name]) return { in: 'query', as: FIELD_PARAMS[name] };
  return method === 'GET' || method === 'DELETE' ? { in: 'query', as: name } : { in: 'body', as: name };
}

export function paginationOf(data: unknown): ToolSuccess['pagination'] {
  if (typeof data !== 'object' || data === null) return undefined;
  const meta = (data as { meta?: unknown }).meta;
  if (typeof meta !== 'object' || meta === null) return undefined;
  const { next_token, previous_token } = meta as Record<string, unknown>;
  const out: NonNullable<ToolSuccess['pagination']> = {};
  if (typeof next_token === 'string') out.next_token = next_token;
  if (typeof previous_token === 'string') out.previous_token = previous_token;
  return Object.keys(out).length ? out : undefined;
}

export function success(res: XResponse, extra: Record<string, unknown> = {}): ToolSuccess {
  const out: ToolSuccess = { data: res.data ?? null, ...extra };
  const pagination = paginationOf(res.data);
  if (pagination) out.pagination = pagination;
  if (res.rateLimit) out.rate_limit = res.rateLimit;
  if (res.auth) out.auth = res.auth;
  return out;
}

export function annotationsFor(method: HttpMethod, destructive?: boolean): ToolAnnotationsLite {
  return {
    readOnlyHint: method === 'GET',
    destructiveHint: destructive ?? method === 'DELETE',
    idempotentHint: method === 'GET' || method === 'PUT' || method === 'DELETE',
    openWorldHint: true,
  };
}

/** Builds the X request for an HTTP tool from validated arguments. Exported for contract tests. */
export async function buildHttpRequest<S extends z.ZodRawShape>(
  spec: HttpToolSpec<S>,
  args: Record<string, unknown>,
  ctx: Pick<ToolContext, 'client'>,
) {
  const pathParams = new Set([...spec.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!));
  const pathValues: Record<string, string> = {};
  const query: Record<string, string> = { ...(spec.constQuery ?? {}) };
  let body: Record<string, unknown> | undefined;
  for (const meParam of spec.meParams ?? []) {
    const value = args[meParam];
    if (value === undefined || value === 'me') pathValues[meParam] = await ctx.client.getMeId();
  }
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const place = placeParam(name, spec.method, pathParams, spec.params?.[name as keyof S & string]);
    const wire = place.as ?? name;
    switch (place.in) {
      case 'ignored':
        break;
      case 'path':
        if (!(wire in pathValues)) pathValues[wire] = String(value);
        break;
      case 'query':
        query[wire] = queryValue(value);
        break;
      case 'body':
        body ??= {};
        setPath(body, wire, value);
        break;
    }
  }
  const path = spec.path.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = pathValues[key];
    if (value === undefined) throw invalidInput(`Missing path parameter ${key}`);
    return encodeURIComponent(value);
  });
  return {
    method: spec.method,
    path,
    query,
    body: body === undefined ? undefined : ({ kind: 'json', value: body } as const),
    auth: spec.auth,
  };
}

export function httpTool<S extends z.ZodRawShape>(spec: HttpToolSpec<S>): ToolDefinition {
  const schema = z.strictObject(spec.input);
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    scope: spec.scope,
    composio: spec.composio ?? true,
    operationIds: [spec.operationId],
    auth: spec.auth,
    actingUserParam: spec.actingUserParam ?? (spec.meParams?.[0] && spec.meParams[0] in spec.input ? spec.meParams[0] : undefined),
    inputSchema: schema as unknown as z.ZodObject<z.ZodRawShape>,
    annotations: annotationsFor(spec.method, spec.destructive),
    async run(args, ctx) {
      spec.check?.(args as z.infer<z.ZodObject<S>>);
      const req = await buildHttpRequest(spec, args, ctx);
      const res = await ctx.client.request({ ...req, signal: ctx.signal });
      return success(res);
    },
  };
}

export interface CustomToolSpec<S extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  scope: ToolScope;
  operationIds: readonly string[];
  auth: readonly AuthKind[];
  input: S;
  annotations: ToolAnnotationsLite;
  composio?: boolean;
  actingUserParam?: keyof S & string;
  run(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<ToolSuccess>;
}

/** Tool with a hand-written handler (multipart bodies, multi-step flows, streams). */
export function customTool<S extends z.ZodRawShape>(spec: CustomToolSpec<S>): ToolDefinition {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    scope: spec.scope,
    composio: spec.composio ?? true,
    operationIds: spec.operationIds,
    auth: spec.auth,
    actingUserParam: spec.actingUserParam,
    inputSchema: z.strictObject(spec.input) as unknown as z.ZodObject<z.ZodRawShape>,
    annotations: spec.annotations,
    run: (args, ctx) => spec.run(args as z.infer<z.ZodObject<S>>, ctx),
  };
}
