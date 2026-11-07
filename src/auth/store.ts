import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { XApiError } from '../x/errors.js';

/** One connected X account, bound to the user id X returned for its own access token. */
export interface StoredAccount {
  userId: string;
  username: string;
  scopes: string[];
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** OAuth client the grant belongs to; a different configured client cannot use it. */
  clientId: string;
  updatedAt: number;
}

export interface TokenStore {
  readonly persistent: boolean;
  list(): Promise<string[]>;
  get(userId: string): Promise<StoredAccount | undefined>;
  put(account: StoredAccount): Promise<void>;
  delete(userId: string): Promise<void>;
}

const USER_ID = /^\d{1,19}$/;

function assertUserId(userId: string): void {
  if (!USER_ID.test(userId)) throw new Error('invalid account id');
}

/** Process-lifetime store used when no X_MCP_TOKEN_KEY is configured. */
export class MemoryTokenStore implements TokenStore {
  readonly persistent = false;
  private readonly accounts = new Map<string, StoredAccount>();

  async list(): Promise<string[]> {
    return [...this.accounts.keys()].sort();
  }
  async get(userId: string): Promise<StoredAccount | undefined> {
    const account = this.accounts.get(userId);
    return account ? { ...account, scopes: [...account.scopes] } : undefined;
  }
  async put(account: StoredAccount): Promise<void> {
    assertUserId(account.userId);
    this.accounts.set(account.userId, { ...account, scopes: [...account.scopes] });
  }
  async delete(userId: string): Promise<void> {
    this.accounts.delete(userId);
  }
}

interface Envelope {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

/**
 * One AES-256-GCM encrypted file per account (`<userId>.json`, mode 0600, directory 0700).
 * The account id is bound as additional authenticated data, so a file copied or renamed to
 * another account's name fails to decrypt instead of granting that account's identity.
 */
export class EncryptedFileTokenStore implements TokenStore {
  readonly persistent = true;

  constructor(
    private readonly dir: string,
    private readonly key: Buffer,
  ) {
    if (key.length !== 32) throw new Error('token key must be 32 bytes');
  }

  private file(userId: string): string {
    assertUserId(userId);
    return path.join(this.dir, `${userId}.json`);
  }

  private aad(userId: string): Buffer {
    return Buffer.from(`x-mcp-account:${userId}`);
  }

  async list(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length))
      .filter((id) => USER_ID.test(id))
      .sort();
  }

  async get(userId: string): Promise<StoredAccount | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.file(userId), 'utf8');
    } catch {
      return undefined;
    }
    try {
      const env = JSON.parse(raw) as Envelope;
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(env.iv, 'base64'));
      decipher.setAAD(this.aad(userId));
      decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(env.data, 'base64')), decipher.final()]);
      const account = JSON.parse(plain.toString('utf8')) as StoredAccount;
      if (account.userId !== userId) throw new Error('account id mismatch');
      return account;
    } catch {
      throw new XApiError(
        'reauthorization_required',
        `Stored credentials for account ${userId} cannot be decrypted (wrong X_MCP_TOKEN_KEY or tampered file); connect the account again.`,
      );
    }
  }

  async put(account: StoredAccount): Promise<void> {
    const target = this.file(account.userId);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad(account.userId));
    const data = Buffer.concat([cipher.update(JSON.stringify(account), 'utf8'), cipher.final()]);
    const env: Envelope = { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(env), { mode: 0o600 });
    await rename(tmp, target);
  }

  async delete(userId: string): Promise<void> {
    await rm(this.file(userId), { force: true });
  }
}
