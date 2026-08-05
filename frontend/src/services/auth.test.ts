// @ts-nocheck
/**
 * Unit tests for cross-tab token refresh coordination in the auth service.
 *
 * Covers the bounty acceptance criteria:
 *  - Concurrent refresh calls in the same tab share one in-flight request.
 *  - Cross-tab refresh attempts coordinate so only one tab performs the network
 *    refresh and the others adopt the resulting tokens.
 *  - A failed refresh does not clear valid tokens while another tab has stored
 *    newer tokens (i.e. a concurrent successful refresh is not clobbered).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Shared, hoisted mock for ./api so every fresh module instance (simulating a
// tab) talks to the same controllable `post` function.
// ---------------------------------------------------------------------------
const api = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
  put: vi.fn(),
}));

vi.mock('./api', () => ({
  get: api.get,
  post: api.post,
  del: api.del,
  put: api.put,
}));

// Must match the key used in auth.ts.
const TOKEN_KEY = 'tot_auth_tokens';

// ---------------------------------------------------------------------------
// Fake BroadcastChannel that delivers postMessage to OTHER channels with the
// same name (mimicking cross-tab delivery). Gives deterministic control over
// cross-tab coordination without depending on jsdom's BroadcastChannel quirks.
// ---------------------------------------------------------------------------
class FakeBroadcastChannel {
  private static channels = new Map<string, Set<FakeBroadcastChannel>>();
  public readonly name: string;
  private listeners = new Set<(event: { data: unknown }) => void>();

  constructor(name: string) {
    this.name = name;
    let set = FakeBroadcastChannel.channels.get(name);
    if (!set) {
      set = new Set();
      FakeBroadcastChannel.channels.set(name, set);
    }
    set.add(this);
  }

  postMessage(data: unknown): void {
    const set = FakeBroadcastChannel.channels.get(this.name);
    if (!set) return;
    for (const ch of set) {
      if (ch === this) continue;
      for (const listener of [...ch.listeners]) listener({ data });
    }
  }

  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    if (type === 'message') this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    if (type === 'message') this.listeners.delete(listener);
  }

  close(): void {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }

  static reset(): void {
    FakeBroadcastChannel.channels.clear();
  }
}

// ---------------------------------------------------------------------------
// Helpers to build JWT-like tokens and AuthTokens.
// ---------------------------------------------------------------------------
function makeJwt(secondsFromNow: number): string {
  const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsFromNow }));
  return `${header}.${payload}.sig`;
}

function makeTokens(refreshToken: string, expiresIn = 3600) {
  return {
    accessToken: makeJwt(expiresIn),
    refreshToken,
    expiresIn,
    tokenType: 'Bearer',
  };
}

/** Load a fresh module instance (simulates a new tab with its own state). */
async function loadAuth() {
  vi.resetModules();
  return await import('./auth');
}

let originalBroadcastChannel: unknown;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  FakeBroadcastChannel.reset();
  // Seed valid stored tokens so refreshTokens() has a refresh token to use.
  localStorage.setItem(TOKEN_KEY, JSON.stringify(makeTokens('refresh-1')));
  api.post.mockReset();
  api.get.mockReset();
  api.del.mockReset();
  vi.useFakeTimers();

  originalBroadcastChannel = (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
  (globalThis as { BroadcastChannel: unknown }).BroadcastChannel = FakeBroadcastChannel;
});

afterEach(() => {
  vi.useRealTimers();
  (globalThis as { BroadcastChannel: unknown }).BroadcastChannel = originalBroadcastChannel;
});

// ---------------------------------------------------------------------------
// 1. Same-tab concurrency: concurrent callers share one in-flight request.
// ---------------------------------------------------------------------------
describe('refreshTokens – same-tab concurrency', () => {
  it('concurrent calls in the same tab share a single in-flight refresh request', async () => {
    let resolvePost!: (value: { data: { tokens: ReturnType<typeof makeTokens> } }) => void;
    api.post.mockReturnValue(
      new Promise((resolve) => {
        resolvePost = resolve;
      }),
    );

    const auth = await loadAuth();

    // Two concurrent refresh attempts before the network call resolves.
    const p1 = auth.refreshTokens();
    const p2 = auth.refreshTokens();

    // Only one network request should have been issued.
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith('/auth/refresh', { refreshToken: 'refresh-1' });

    const newTokens = makeTokens('refresh-2');
    resolvePost({ data: { tokens: newTokens } });

    const [r1, r2] = await Promise.all([p1, p2]);

    // Both callers receive the same refreshed tokens.
    expect(r1).toEqual(newTokens);
    expect(r2).toEqual(newTokens);
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('returns null without calling the API when no refresh token is available', async () => {
    localStorage.removeItem(TOKEN_KEY);
    const auth = await loadAuth();
    const result = await auth.refreshTokens();
    expect(result).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Cross-tab coordination: only the leader performs the network refresh and
//    followers adopt the resulting tokens.
// ---------------------------------------------------------------------------
describe('refreshTokens – cross-tab coordination', () => {
  it('only the leader performs the network refresh and the follower adopts the result', async () => {
    let resolvePost!: (value: { data: { tokens: ReturnType<typeof makeTokens> } }) => void;
    api.post.mockReturnValue(
      new Promise((resolve) => {
        resolvePost = resolve;
      }),
    );

    // Two independent module instances = two tabs sharing localStorage.
    const authA = await loadAuth();
    const authB = await loadAuth();

    // Tab A starts first and wins leadership; Tab B becomes a follower.
    const pA = authA.refreshTokens();
    const pB = authB.refreshTokens();

    // Only the leader issued a network request.
    expect(api.post).toHaveBeenCalledTimes(1);

    const newTokens = makeTokens('refresh-2');
    resolvePost({ data: { tokens: newTokens } });

    const [rA, rB] = await Promise.all([pA, pB]);

    // Both tabs end up with the same refreshed tokens.
    expect(rA).toEqual(newTokens);
    expect(rB).toEqual(newTokens);
    // Still only one network request across both tabs.
    expect(api.post).toHaveBeenCalledTimes(1);

    // Both tabs persisted the new tokens to the shared localStorage.
    const stored = JSON.parse(localStorage.getItem(TOKEN_KEY)!);
    expect(stored.refreshToken).toBe('refresh-2');
  });
});

// ---------------------------------------------------------------------------
// 3. Refresh failure behavior: failed refresh must not wipe tokens stored by a
//    concurrent successful refresh.
// ---------------------------------------------------------------------------
describe('refreshTokens – failure behavior', () => {
  it('clears tokens when the leader refresh fails and no other tab updated them', async () => {
    let rejectPost!: (error: Error) => void;
    api.post.mockReturnValue(
      new Promise((_, reject) => {
        rejectPost = reject;
      }),
    );

    const auth = await loadAuth();
    const p = auth.refreshTokens();

    rejectPost(new Error('refresh failed'));
    await expect(p).resolves.toBeNull();

    // No other tab updated tokens, so the failed refresh clears local state.
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('does not clear tokens when another tab stored newer tokens during the refresh', async () => {
    let rejectPost!: (error: Error) => void;
    api.post.mockReturnValue(
      new Promise((_, reject) => {
        rejectPost = reject;
      }),
    );

    const auth = await loadAuth();
    const p = auth.refreshTokens();

    // Simulate another tab completing a successful refresh while this one is
    // still in flight: newer tokens are persisted to the shared storage.
    const newerTokens = makeTokens('refresh-2');
    localStorage.setItem(TOKEN_KEY, JSON.stringify(newerTokens));

    rejectPost(new Error('refresh failed'));
    await expect(p).resolves.toBeNull();

    // The newer tokens must survive – the failed refresh did not clobber them.
    const stored = JSON.parse(localStorage.getItem(TOKEN_KEY)!);
    expect(stored.refreshToken).toBe('refresh-2');
  });
});
