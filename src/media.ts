import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ServerConfig } from './config.js';
import { invalidInput } from './x/errors.js';

/**
 * Media input. Replaces Composio's hosted file object: either inline base64 bytes, or a path
 * inside the operator-configured X_MCP_MEDIA_ROOT (path inputs are disabled when it is unset,
 * so a model cannot read arbitrary local files). URLs are not fetched.
 */
export const mediaInputSchema = z
  .object({
    base64: z.string().min(1).optional().describe('File contents, base64-encoded.'),
    path: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe('File path relative to (or inside) X_MCP_MEDIA_ROOT. Disabled when X_MCP_MEDIA_ROOT is unset.'),
    mime_type: z
      .string()
      .regex(/^[a-z]+\/[a-z0-9.+-]+$/, 'mime_type must look like type/subtype')
      .optional()
      .describe('MIME type, e.g. image/png or video/mp4. Inferred from filename/path extension when omitted.'),
    filename: z.string().max(255).optional().describe('Original filename, used only for MIME type inference.'),
  })
  .describe('Media file: provide exactly one of `base64` or `path`.');

export type MediaInput = z.infer<typeof mediaInputSchema>;

export interface LoadedMedia {
  bytes: Buffer;
  mimeType?: string;
}

const EXTENSION_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ts': 'video/mp2t',
  '.srt': 'text/srt',
  '.vtt': 'text/vtt',
};

export function inferMimeType(input: Pick<MediaInput, 'mime_type' | 'filename' | 'path'>): string | undefined {
  if (input.mime_type && input.mime_type !== 'application/octet-stream') return input.mime_type;
  const name = input.filename ?? input.path;
  return name ? EXTENSION_MIME[path.extname(name).toLowerCase()] : undefined;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function decodeBase64(value: string, maxBytes: number, what = 'media.base64'): Buffer {
  const compact = value.replace(/\s+/g, '');
  if (!BASE64.test(compact) || compact.length % 4 === 1) throw invalidInput(`${what} is not valid base64`);
  if (Math.floor((compact.length * 3) / 4) > maxBytes + 2) {
    throw invalidInput(`${what} exceeds the ${maxBytes}-byte limit`);
  }
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.length === 0) throw invalidInput(`${what} is empty`);
  if (bytes.length > maxBytes) throw invalidInput(`${what} exceeds the ${maxBytes}-byte limit`);
  return bytes;
}

export class MediaReader {
  constructor(private readonly config: Pick<ServerConfig, 'mediaRoot' | 'maxMediaBytes'>) {}

  async load(input: MediaInput, maxBytes = this.config.maxMediaBytes): Promise<LoadedMedia> {
    const limit = Math.min(maxBytes, this.config.maxMediaBytes);
    if ((input.base64 === undefined) === (input.path === undefined)) {
      throw invalidInput('media requires exactly one of `base64` or `path`');
    }
    const mimeType = inferMimeType(input);
    if (input.base64 !== undefined) return { bytes: decodeBase64(input.base64, limit), mimeType };
    return { bytes: await this.readFromRoot(input.path!, limit), mimeType };
  }

  private async readFromRoot(requested: string, limit: number): Promise<Buffer> {
    if (!this.config.mediaRoot) {
      throw invalidInput('media.path is disabled: the server operator has not set X_MCP_MEDIA_ROOT; send base64 instead');
    }
    let root: string;
    try {
      root = await realpath(this.config.mediaRoot);
    } catch {
      throw invalidInput('X_MCP_MEDIA_ROOT does not exist');
    }
    let resolved: string;
    try {
      resolved = await realpath(path.resolve(root, requested));
    } catch {
      throw invalidInput('media.path does not exist inside X_MCP_MEDIA_ROOT');
    }
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw invalidInput('media.path must resolve inside X_MCP_MEDIA_ROOT');
    }
    const info = await stat(resolved);
    if (!info.isFile()) throw invalidInput('media.path is not a regular file');
    if (info.size === 0) throw invalidInput('media.path is empty');
    if (info.size > limit) throw invalidInput(`media.path exceeds the ${limit}-byte limit`);
    return readFile(resolved);
  }
}
