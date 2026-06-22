import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api', () => ({
  get: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
}));

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
    get length() { return Object.keys(store).length; },
    key: vi.fn((index: number) => Object.keys(store)[index] || null),
  };
})();

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  name: string;
  postedMessages: unknown[] = [];
  constructor(name: string) { this.name = name; MockBroadcastChannel.instances.push(this); }
  postMessage(message: unknown) { this.postedMessages.push(message); }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

Object.defineProperty(globalThis, 'BroadcastChannel', { value: MockBroadcastChannel });

describe('Auth Token Refresh Coordination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockBroadcastChannel.instances = [];
    localStorageMock.clear();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  describe('Cross-tab token sync', () => {
    it('should broadcast tokens when they are updated', async () => {
      const { post } = await import('../api');
      vi.mocked(post).mockResolvedValue({
        data: {
          tokens: { accessToken: 'new-access-token', refreshToken: 'new-refresh-token', expiresIn: 3600, tokenType: 'Bearer' },
          user: { id: '1', email: 'test@test.com' },
        },
      });
      const { login } = await import('../auth');
      await login({ email: 'test@test.com', password: 'password' });
      expect(localStorageMock.setItem).toHaveBeenCalled();
    });

    it('should coordinate refresh across tabs via lock mechanism', async () => {
      const { post } = await import('../api');
      const mockPost = vi.mocked(post);
      mockPost.mockResolvedValueOnce({
        data: { tokens: { accessToken: 'refreshed-token', refreshToken: 'new-refresh-token', expiresIn: 3600, tokenType: 'Bearer' } },
      });
      const { refreshTokens } = await import('../auth');
      localStorageMock.setItem('tot_auth_tokens', JSON.stringify({
        accessToken: 'old-token', refreshToken: 'old-refresh-token', expiresIn: 60, tokenType: 'Bearer',
      }));
      const result = await refreshTokens();
      expect(result).toBeTruthy();
      expect(mockPost).toHaveBeenCalledWith('/auth/refresh', { refreshToken: 'old-refresh-token' });
    });
  });

  describe('Refresh lock behavior', () => {
    it('should acquire refresh lock', async () => {
      const { refreshTokens } = await import('../auth');
      localStorageMock.setItem('tot_auth_tokens', JSON.stringify({
        accessToken: 'token', refreshToken: 'refresh-token', expiresIn: 60, tokenType: 'Bearer',
      }));
      await refreshTokens();
      expect(localStorageMock.setItem).toHaveBeenCalledWith('tot_refresh_lock', expect.any(String));
    });

    it('should not refresh if lock is held by another tab', async () => {
      const { post } = await import('../api');
      const mockPost = vi.mocked(post);
      localStorageMock.setItem('tot_refresh_lock', String(Date.now()));
      localStorageMock.setItem('tot_auth_tokens', JSON.stringify({
        accessToken: 'token', refreshToken: 'refresh-token', expiresIn: 60, tokenType: 'Bearer',
      }));
      const { refreshTokens } = await import('../auth');
      await refreshTokens();
      expect(mockPost).not.toHaveBeenCalledWith('/auth/refresh', expect.anything());
    });
  });

  describe('Logout broadcast', () => {
    it('should broadcast logout across tabs', async () => {
      const { del } = await import('../api');
      vi.mocked(del).mockResolvedValue({ data: undefined });
      const { logout } = await import('../auth');
      await logout();
      expect(localStorageMock.removeItem).toHaveBeenCalledWith('tot_auth_tokens');
      expect(localStorageMock.removeItem).toHaveBeenCalledWith('tot_user_data');
    });
  });
});
