import { MemoryTokenStore } from '../../src/auth/store.js';
import { freeLoopbackPort, TEST_SECRETS } from '../helpers.js';
import type { ContractCase } from './types.js';

const PORT = await freeLoopbackPort();
export const OAUTH_ENV = {
  ...TEST_SECRETS,
  X_OAUTH2_CLIENT_ID: 'test-client-id',
  X_OAUTH2_REDIRECT_URI: `http://127.0.0.1:${PORT}/callback`,
};

export const authCases: ContractCase[] = [
  {
    tool: 'X_AUTH_STATUS',
    env: OAUTH_ENV,
    args: {},
    calls: [],
    verify(s) {
      const data = s.data as { oauth_configured: boolean; accounts: unknown[]; persistent_storage: boolean };
      if (!data.oauth_configured || data.accounts.length !== 0 || data.persistent_storage) throw new Error(JSON.stringify(data));
    },
  },
  {
    tool: 'X_AUTH_CONNECT',
    env: OAUTH_ENV,
    args: { tools: ['TWITTER_RECENT_SEARCH'], persistent: false },
    calls: [],
    verify(s) {
      const data = s.data as { authorization_url: string; scopes: string[] };
      const url = new URL(data.authorization_url);
      if (url.origin + url.pathname !== 'https://x.com/i/oauth2/authorize') throw new Error(data.authorization_url);
      if (data.scopes.join(' ') !== 'tweet.read users.read') throw new Error(data.scopes.join(' '));
    },
  },
  {
    tool: 'X_AUTH_DISCONNECT',
    env: OAUTH_ENV,
    args: {},
    async setup({ accounts }) {
      await (accounts.store as MemoryTokenStore).put({
        userId: '2244994945',
        username: 'XDevelopers',
        scopes: ['tweet.read', 'users.read', 'offline.access'],
        accessToken: 'access-token-value-1',
        refreshToken: 'refresh-token-value-1',
        expiresAt: 1_800_000_000_000 + 3_600_000,
        clientId: 'test-client-id',
        updatedAt: 0,
      });
    },
    calls: [
      { method: 'POST', path: '/2/oauth2/revoke', body: { token: 'refresh-token-value-1', token_type_hint: 'refresh_token', client_id: 'test-client-id' }, auth: 'none' },
      { method: 'POST', path: '/2/oauth2/revoke', body: { token: 'access-token-value-1', token_type_hint: 'access_token', client_id: 'test-client-id' }, auth: 'none' },
    ],
    replies: [{ body: { revoked: true } }, { body: { revoked: true } }],
    verify(s) {
      const data = s.data as { disconnected: boolean; user_id: string; revoked: { refresh_token: boolean; access_token: boolean } };
      if (!data.disconnected || data.user_id !== '2244994945' || !data.revoked.refresh_token || !data.revoked.access_token) throw new Error(JSON.stringify(data));
      if (JSON.stringify(s).includes('token-value')) throw new Error('token leaked into tool result');
    },
  },
];
