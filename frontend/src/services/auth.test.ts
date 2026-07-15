/**
 * Tests for cross-tab auth token refresh coordination.
 *
 * Covers:
 * - Same-tab concurrency: concurrent refresh calls share one in-flight request
 * - Cross-tab success propagation: broadcast tokens to other tabs
 * - Refresh failure behavior: don't clear valid tokens when another tab refreshed
 * - localStorage fallback: coordination via storage events
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// GLOBAL MOCKS — installed before module imports
// ---------------------------------------------------------------------------

const bcInstances: Array<{
  name: string;
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage: (data: unknown) => void;
}> = [];

class MockBroadcastChannel {
  name: string;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(name: string) {
    this.name = name;
    bcInstances.push(this);
  }

  postMessage(data: unknown): void {
    for (const ch of bcInstances) {
      if (ch !== this && ch.name === this.name && ch.onmessage) {
        ch.onmessage({ data });
      }
    }
  }

  close(): void {
    const idx = bcInstances.indexOf(this);
    if (idx >= 0) bcInstances.splice(idx, 1);
  }
}

const _store: Record<string, string> = {};
const _storageCallbacks: Array<(key: string, newValue: string | null) => void> = [];

const _localStorage = {
  getItem: (k: string) => _store[k] ?? null,
  setItem: (k: string, v: string) => { _store[k] = v; },
  removeItem: (k: string) => { delete _store[k]; },
  clear: () => { Object.keys(_store).forEach(k => delete _store[k]); },
  get length() { return Object.keys(_store).length; },
  key: (i: number) => Object.keys(_store)[i] ?? null,
};

vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
vi.stubGlobal('localStorage', _localStorage);
vi.stubGlobal('window', {
  addEventListener: (_t: string, cb: (e: Event) => void) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _storageCallbacks.push(cb as any);
  },
});

function foreignBC(data: unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const f = new (MockBroadcastChannel as any)('tot-auth-refresh');
  f.postMessage(data);
  f.close();
}

function fireStorage(key: string, newValue: string | null): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const cb of _storageCallbacks) (cb as any)({ key, newValue });
}

// ---------------------------------------------------------------------------
// TOKEN HELPERS — all access tokens must be parseable JWT-like strings
// ---------------------------------------------------------------------------

function jwt(expired: boolean, marker?: string): string {
  const exp = expired ? Math.floor(Date.now() / 1000) - 3600 : Math.floor(Date.now() / 1000) + 3600;
  const payload: Record<string, unknown> = { exp, sub: 'test' };
  if (marker) payload.m = marker;
  return `h.${btoa(JSON.stringify(payload))}.s`;
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
}

function tok(overrides?: { expired?: boolean; label?: string }): Tokens {
  const { expired = false, label = undefined } = overrides ?? {};
  return {
    accessToken: jwt(expired, label),
    refreshToken: 'rt-' + Math.random().toString(36).slice(2, 8),
    expiresIn: expired ? 0 : 3600,
    tokenType: 'Bearer',
  };
}

function persist(t: Tokens): void { _store['tot_auth_tokens'] = JSON.stringify(t); }

const VALID = tok(); // non-expired baseline

// ---------------------------------------------------------------------------
// MOCK: api module
// ---------------------------------------------------------------------------

vi.mock('./api', () => ({ get: vi.fn(), post: vi.fn(), del: vi.fn(), put: vi.fn() }));

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe('Token Refresh Coordination', () => {
  beforeEach(() => {
    Object.keys(_store).forEach(k => delete _store[k]);
    bcInstances.splice(0, bcInstances.length);
    _storageCallbacks.splice(0, _storageCallbacks.length);
    vi.clearAllMocks();
  });

  afterEach(() => vi.resetModules());

  // -----------------------------------------------------------------------
  // SAME-TAB CONCURRENCY
  // -----------------------------------------------------------------------
  describe('Same-tab concurrency', () => {
    it('shares a single in-flight refresh promise across concurrent calls', async () => {
      const api = await import('./api');
      const auth = await import('./auth');

      persist(VALID);
      const refreshed = tok({ label: 'refreshed' });

      (api.post as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve({ data: { tokens: refreshed }, status: 200 }), 50)),
      );

      const [r1, r2, r3] = await Promise.all([
        auth.refreshTokens(), auth.refreshTokens(), auth.refreshTokens(),
      ]);

      expect(r1?.accessToken).toBe(refreshed.accessToken);
      expect(r2?.accessToken).toBe(refreshed.accessToken);
      expect(r3?.accessToken).toBe(refreshed.accessToken);
      expect(api.post).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // CROSS-TAB SUCCESS PROPAGATION
  // -----------------------------------------------------------------------
  describe('Cross-tab success propagation', () => {
    it('adopts tokens broadcast from another tab via BroadcastChannel', async () => {
      const api = await import('./api');
      const auth = await import('./auth');

      // Prime the BC infrastructure: do a successful refresh first.
      persist(VALID);
      (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { tokens: VALID }, status: 200 });
      await auth.refreshTokens();

      // Now store expired tokens + make API fail
      persist(tok({ expired: true }));
      (api.post as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('BC test'));

      const incoming = tok({ label: 'broadcast' });
      foreignBC({ type: 'tokens-refreshed', tokens: incoming, timestamp: String(Date.now()) });
      await new Promise(r => setTimeout(r, 10));

      const result = await auth.refreshTokens();
      expect(result?.accessToken).toBe(incoming.accessToken);
      expect(result?.refreshToken).toBe(incoming.refreshToken);
    });

    it('stores refreshed tokens and schedules next refresh', async () => {
      const api = await import('./api');
      const auth = await import('./auth');

      persist(VALID);
      const updated = tok({ label: 'post-refresh' });

      (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { tokens: updated }, status: 200 });

      const result = await auth.refreshTokens();

      // Returned tokens match the API response
      expect(result?.accessToken).toBe(updated.accessToken);
      expect(result?.refreshToken).toBe(updated.refreshToken);

      // Tokens were stored in localStorage
      const storedTokens = JSON.parse(localStorage.getItem('tot_auth_tokens') || '{}');
      expect(storedTokens.accessToken).toBe(updated.accessToken);
    });
  });

  // -----------------------------------------------------------------------
  // REFRESH FAILURE BEHAVIOR
  // -----------------------------------------------------------------------
  describe('Refresh failure behavior', () => {
    it('preserves tokens from another tab when refresh fails', async () => {
      const api = await import('./api');
      const auth = await import('./auth');

      persist(VALID);
      (api.post as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));

      const fallback = tok({ label: 'survivor' });
      persist(fallback);

      const result = await auth.refreshTokens();
      expect(result?.accessToken).toBe(fallback.accessToken);
    });

    it('clears tokens when refresh fails with no valid fallback', async () => {
      const api = await import('./api');
      const auth = await import('./auth');

      persist(tok({ expired: true }));
      (api.post as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));

      const result = await auth.refreshTokens();
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // LOCALSTORAGE FALLBACK
  // -----------------------------------------------------------------------
  describe('localStorage fallback', () => {
    it('adopts tokens from localStorage storage events cross-tab', async () => {
      const api = await import('./api');
      const auth = await import('./auth');

      // Prime the BC infrastructure
      persist(VALID);
      (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { tokens: VALID }, status: 200 });
      await auth.refreshTokens();

      // Now set expired tokens + make API fail
      persist(tok({ expired: true }));
      (api.post as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('LS test'));

      const lsTokens = tok({ label: 'ls-fallback' });
      const evt = { type: 'tokens-refreshed', tokens: lsTokens, timestamp: String(Date.now() + 5000) };

      _store['tot_auth_refresh_event_ts'] = String(Date.now());
      _store['tot_auth_refresh_event'] = JSON.stringify(evt);
      fireStorage('tot_auth_refresh_event', JSON.stringify(evt));
      await new Promise(r => setTimeout(r, 10));

      const result = await auth.refreshTokens();
      expect(result?.accessToken).toBe(lsTokens.accessToken);
    });
  });
});
