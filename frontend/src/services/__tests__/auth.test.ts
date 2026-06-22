import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api', () => ({
  get: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
  put: vi.fn(),
}));

let authModule: typeof import('../auth');

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  localStorage.clear();
  authModule = await import('../auth');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createMockJWT(exp: number): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ exp, iat: exp - 3600 }));
  return `${header}.${payload}.mock-sig`;
}

describe('refreshTokens same-tab concurrency', () => {
  it('concurrent refreshTokens calls share one in-flight request', async () => {
    const { post } = await import('../api');
    const tokens = {
      accessToken: createMockJWT(Date.now() / 1000 + 3600),
      refreshToken: 'refresh-1',
      expiresIn: 3600,
      tokenType: 'Bearer',
    };
    const newTokens = {
      accessToken: createMockJWT(Date.now() / 1000 + 7200),
      refreshToken: 'refresh-2',
      expiresIn: 7200,
      tokenType: 'Bearer',
    };

    localStorage.setItem('tot_auth_tokens', JSON.stringify(tokens));

    let resolveRefresh: (v: any) => void;
    (post as any).mockImplementation(
      () => new Promise((resolve) => { resolveRefresh = resolve; })
    );

    const p1 = authModule.refreshTokens();
    const p2 = authModule.refreshTokens();

    expect(post).toHaveBeenCalledTimes(1);

    resolveRefresh!({ data: { tokens: newTokens } });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(newTokens);
    expect(r2).toEqual(newTokens);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('does not start a refresh if no tokens exist', async () => {
    const { post } = await import('../api');
    localStorage.clear();

    const result = await authModule.refreshTokens();
    expect(result).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });
});

describe('cross-tab token propagation', () => {
  it('BroadcastChannel messages update tokens if fresher', async () => {
    const oldTokens = {
      accessToken: createMockJWT(Date.now() / 1000 + 100),
      refreshToken: 'refresh-old',
      expiresIn: 100,
      tokenType: 'Bearer',
    };
    const fresherTokens = {
      accessToken: createMockJWT(Date.now() / 1000 + 5000),
      refreshToken: 'refresh-new',
      expiresIn: 5000,
      tokenType: 'Bearer',
    };

    localStorage.setItem('tot_auth_tokens', JSON.stringify(oldTokens));

    const channel = new BroadcastChannel('tot_auth_refresh');
    channel.postMessage({ type: 'tokens_updated', tokens: fresherTokens });

    await new Promise((r) => setTimeout(r, 0));

    const stored = JSON.parse(localStorage.getItem('tot_auth_tokens')!);
    expect(stored.refreshToken).toBe('refresh-new');
    channel.close();
  });

  it('does not overwrite with older tokens', async () => {
    const currentTokens = {
      accessToken: createMockJWT(Date.now() / 1000 + 5000),
      refreshToken: 'refresh-current',
      expiresIn: 5000,
      tokenType: 'Bearer',
    };
    const olderTokens = {
      accessToken: createMockJWT(Date.now() / 100 + 100),
      refreshToken: 'refresh-old',
      expiresIn: 100,
      tokenType: 'Bearer',
    };

    localStorage.setItem('tot_auth_tokens', JSON.stringify(currentTokens));

    const channel = new BroadcastChannel('tot_auth_refresh');
    channel.postMessage({ type: 'tokens_updated', tokens: olderTokens });

    await new Promise((r) => setTimeout(r, 0));

    const stored = JSON.parse(localStorage.getItem('tot_auth_tokens')!);
    expect(stored.refreshToken).toBe('refresh-current');
    channel.close();
  });
});

describe('refresh failure behavior', () => {
  it('adopts fresher tokens from localStorage on failure', async () => {
    const { post } = await import('../api');
    const currentTokens = {
      accessToken: createMockJWT(Date.now() / 1000 + 100),
      refreshToken: 'refresh-old',
      expiresIn: 100,
      tokenType: 'Bearer',
    };
    const fresherTokens = {
      accessToken: createMockJWT(Date.now() / 1000 + 5000),
      refreshToken: 'refresh-new',
      expiresIn: 5000,
      tokenType: 'Bearer',
    };

    localStorage.setItem('tot_auth_tokens', JSON.stringify(currentTokens));
    (post as any).mockRejectedValueOnce(new Error('network error'));

    const call = authModule.refreshTokens();
    localStorage.setItem('tot_auth_tokens', JSON.stringify(fresherTokens));

    const result = await call;
    expect(result).toEqual(fresherTokens);
  });

  it('clears tokens when no other tab has refreshed', async () => {
    const { post } = await import('../api');
    const tokens = {
      accessToken: createMockJWT(Date.now() / 1000 + 100),
      refreshToken: 'refresh-1',
      expiresIn: 100,
      tokenType: 'Bearer',
    };

    localStorage.setItem('tot_auth_tokens', JSON.stringify(tokens));
    (post as any).mockRejectedValue(new Error('network error'));

    const result = await authModule.refreshTokens();
    expect(result).toBeNull();
    expect(localStorage.getItem('tot_auth_tokens')).toBeNull();
  });
});

describe('logout', () => {
  it('clears tokens and notifies listeners', async () => {
    const { del } = await import('../api');
    const tokens = {
      accessToken: createMockJWT(Date.now() / 1000 + 3600),
      refreshToken: 'refresh-1',
      expiresIn: 3600,
      tokenType: 'Bearer',
    };

    localStorage.setItem('tot_auth_tokens', JSON.stringify(tokens));
    (del as any).mockResolvedValue({});

    const listener = vi.fn();
    authModule.onAuthChange(listener);

    await authModule.logout();

    expect(localStorage.getItem('tot_auth_tokens')).toBeNull();
    expect(listener).toHaveBeenCalledWith(null);
  });
});

describe('login', () => {
  it('stores tokens and broadcasts', async () => {
    const { post } = await import('../api');
    const tokens = {
      accessToken: createMockJWT(Date.now() / 1000 + 3600),
      refreshToken: 'refresh-1',
      expiresIn: 3600,
      tokenType: 'Bearer',
    };
    const user = {
      id: '1', email: 'test@example.com', name: 'Test User',
      role: 'trader', permissions: [], mfaEnabled: false, emailVerified: true,
      createdAt: '2024-01-01', updatedAt: '2024-01-01',
      preferences: {
        theme: 'dark', language: 'en', timezone: 'UTC',
        notifications: {
          email: true, push: true, sms: false, inApp: true,
          tradeConfirmations: true, priceAlerts: false, accountUpdates: true, marketing: false,
        },
      },
    };

    (post as any).mockResolvedValue({ data: { tokens, user } });

    const result = await authModule.login({ email: 'test@example.com', password: 'password' });
    expect(result).toEqual(tokens);
    expect(localStorage.getItem('tot_auth_tokens')).toBeTruthy();
  });
});
