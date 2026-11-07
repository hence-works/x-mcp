import type { MockReply } from '../helpers.js';

export type ExpectedAuth = 'oauth2_user' | 'oauth1_user' | 'app_bearer' | 'none';

export interface ExpectedRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  /** Exact query parameters (all of them). Defaults to none. */
  query?: Record<string, string>;
  /** Exact JSON body; `undefined` asserts no JSON body. */
  body?: unknown;
  /** Multipart field expectations (name -> string value or byte length). */
  multipart?: Record<string, string | { bytes: number }>;
  /** Defaults to oauth2_user. */
  auth?: ExpectedAuth;
}

export interface ContractCase {
  tool: string;
  /** Distinguishes several cases for one tool. */
  label?: string;
  args: Record<string, unknown>;
  /** When set, the server must first resolve GET /2/users/me, answered with this id. */
  me?: string;
  /** Expected X requests after the optional /2/users/me lookup, in order. */
  calls: ExpectedRequest[];
  /** Replies for `calls`, in order. Defaults to a generic JSON body per call. */
  replies?: MockReply[];
  env?: NodeJS.ProcessEnv;
  /** Assertion on structuredContent beyond the default `data` echo check. */
  verify?: (structured: Record<string, unknown>) => void;
}
