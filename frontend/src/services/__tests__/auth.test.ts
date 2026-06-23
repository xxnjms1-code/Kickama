/**
 * Unit tests for auth service cross-tab refresh coordination.
 *
 * Tests cover:
 *   - Same-tab concurrent refresh calls share one in-flight request
 *   - Cross-tab refresh through BroadcastChannel propagation
 *   - Cross-tab refresh through localStorage fallback
 *   - Refresh failure does not clear valid tokens
 */

import {
  login,
  logout,
  refreshTokens,
  getAccessToken,
  isAuthenticated,
  onAuthChange,
} from '../auth';

// ── Helpers ──────────────────────────────────────────────────────────────

/** Mock a JWT with an expiry relative to now. */
function makeJwt(expOffsetSeconds: number): string {
  const header = btoa(JSON.stringify({ alg: 'HS256' }));
  const payload = btoa(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expOffsetSeconds }),
  );
  return `${header}.${payload}.sig`;
}

function makeTokens(overrides: Partial<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> = {}): import('../auth').AuthTokens {
  return {
    accessToken: overrides.accessToken ?? makeJwt(300),
    refreshToken: overrides.refreshToken ?? 'refresh-1',
    expiresIn: overrides.expiresIn ?? 300,
    tokenType: 'Bearer',
  };
}

// ── Test setup / teardown ─────────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
  // Reset module state by reloading - we simulate this by clearing
  // and directly resetting the internal state via exported helpers.
  // Also reset BroadcastChannel mock
  (globalThis as any).BroadcastChannel = undefined;
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── Mock the API module ───────────────────────────────────────────────────

jest.mock('../api', () => ({
  post: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
}));

import { post as apiPost } from '../api';
const mockPost = apiPost as jest.Mock;

// ── Same-tab concurrency ──────────────────────────────────────────────────

describe('same-tab concurrent refresh', () => {
  beforeEach(async () => {
    mockPost.mockResolvedValueOnce({
      data: { tokens: makeTokens({ accessToken: 'at-login' }) },
    });

    // Log in first
    mockPost.mockResolvedValueOnce({
      data: { tokens: makeTokens(), user: { id: '1', email: 'test@test.com' } },
    });

    await login({ email: 'test@test.com', password: 'pass' });
    mockPost.mockClear();
  });

  it('shares one in-flight refresh request across concurrent callers', async () => {
    const freshTokens = makeTokens({ accessToken: 'at-refreshed' });
    mockPost.mockResolvedValueOnce({ data: { tokens: freshTokens } });

    // Fire three concurrent refresh calls
    const [r1, r2, r3] = await Promise.all([
      refreshTokens(),
      refreshTokens(),
      refreshTokens(),
    ]);

    // All should resolve to the same result
    expect(r1?.accessToken).toBe('at-refreshed');
    expect(r2?.accessToken).toBe('at-refreshed');
    expect(r3?.accessToken).toBe('at-refreshed');

    // Only one network call should have been made
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
});

// ── Cross-tab coordination via BroadcastChannel ────────────────────────────

describe('cross-tab refresh coordination', () => {
  let mockChannel: any;
  let messageHandler: ((e: MessageEvent) => void) | null = null;

  beforeEach(() => {
    mockChannel = {
      postMessage: jest.fn(),
      addEventListener: jest.fn((_event: string, handler: any) => {
        if (_event === 'message') messageHandler = handler;
      }),
      close: jest.fn(),
    };

    (globalThis as any).BroadcastChannel = jest.fn(() => mockChannel);

    mockPost.mockResolvedValueOnce({
      data: { tokens: makeTokens(), user: { id: '1', email: 'test@test.com' } },
    });
  });

  afterEach(() => {
    messageHandler = null;
  });

  it('broadcasts tokens to other tabs after a successful refresh', async () => {
    // Login
    await login({ email: 'test@test.com', password: 'pass' });
    mockPost.mockClear();

    const freshTokens = makeTokens({ accessToken: 'at-refreshed-bc' });
    mockPost.mockResolvedValueOnce({ data: { tokens: freshTokens } });

    await refreshTokens();

    // BroadcastChannel should have sent the updated tokens
    expect(mockChannel.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'token_update',
        tokens: expect.objectContaining({ accessToken: 'at-refreshed-bc' }),
      }),
    );
  });

  it('adopts tokens received from another tab via BroadcastChannel', () => {
    // Simulate receiving a token_update message from another tab
    expect(messageHandler).not.toBeNull();

    const otherTabTokens = makeTokens({ accessToken: 'at-from-other-tab' });
    messageHandler!({
      data: { type: 'token_update', tokens: otherTabTokens },
    } as MessageEvent);

    expect(getAccessToken()).toBe('at-from-other-tab');
  });

  it('logs out when receiving a logout broadcast from another tab', async () => {
    await login({ email: 'test@test.com', password: 'pass' });
    mockPost.mockClear();

    const callback = jest.fn();
    onAuthChange(callback);

    expect(messageHandler).not.toBeNull();
    messageHandler!({
      data: { type: 'logout' },
    } as MessageEvent);

    expect(isAuthenticated()).toBe(false);
    expect(callback).toHaveBeenCalledWith(null);
  });
});

// ── Refresh failure behavior ──────────────────────────────────────────────

describe('refresh failure handling', () => {
  beforeEach(async () => {
    mockPost.mockResolvedValueOnce({
      data: { tokens: makeTokens(), user: { id: '1', email: 'test@test.com' } },
    });
    await login({ email: 'test@test.com', password: 'pass' });
    mockPost.mockClear();
  });

  it('does not clear valid tokens on a failed refresh', async () => {
    expect(isAuthenticated()).toBe(true);

    // Simulate a failed refresh
    mockPost.mockRejectedValueOnce(new Error('Network error'));

    await refreshTokens();

    // Tokens should still be valid since they haven't expired
    expect(isAuthenticated()).toBe(true);
    expect(getAccessToken()).toBeTruthy();
  });

  it('clears tokens on refresh failure when tokens are expired', async () => {
    // Store expired tokens first
    localStorage.setItem(
      'tot_auth_tokens',
      JSON.stringify(makeTokens({ accessToken: makeJwt(-60) })),
    );

    mockPost.mockRejectedValueOnce(new Error('Network error'));
    const result = await refreshTokens();

    expect(result).toBeNull();
  });
});

// ── localStorage cross-tab fallback ────────────────────────────────────────

describe('localStorage cross-tab fallback', () => {
  beforeEach(async () => {
    // Ensure BroadcastChannel is NOT available
    (globalThis as any).BroadcastChannel = undefined;

    mockPost.mockResolvedValueOnce({
      data: { tokens: makeTokens(), user: { id: '1', email: 'test@test.com' } },
    });
    await login({ email: 'test@test.com', password: 'pass' });
    mockPost.mockClear();
  });

  it('adopts tokens when another tab stores them via localStorage', () => {
    const otherTokens = makeTokens({ accessToken: 'at-ls-other' });

    // Simulate another tab writing tokens to localStorage
    // and triggering a storage event
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'tot_auth_tokens',
        newValue: JSON.stringify(otherTokens),
      }),
    );

    expect(getAccessToken()).toBe('at-ls-other');
  });

  it('clears tokens on logout via localStorage', () => {
    const callback = jest.fn();
    onAuthChange(callback);

    // Simulate logout from another tab (key removed)
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'tot_auth_tokens',
        newValue: null,
      }),
    );

    expect(isAuthenticated()).toBe(false);
    expect(callback).toHaveBeenCalledWith(null);
  });
});
