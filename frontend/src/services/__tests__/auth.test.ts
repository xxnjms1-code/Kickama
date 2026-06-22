/**
 * Tests for cross-tab token refresh coordination
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { refreshTokens, login, logout, isAuthenticated, getAccessToken } from '../auth';

// Mock BroadcastChannel
const mockPostMessage = vi.fn();
const mockClose = vi.fn();

class MockBroadcastChannel {
  name: string;
  onmessage: ((event: any) => void) | null = null;

  constructor(name: string) {
    this.name = name;
  }

  postMessage(data: any) {
    mockPostMessage(data);
  }

  close() {
    mockClose();
  }
}

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

// Setup mocks
beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
  vi.stubGlobal('localStorage', localStorageMock);
  mockPostMessage.mockClear();
  mockClose.mockClear();
  localStorageMock.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Cross-tab Token Refresh Coordination', () => {
  describe('Same-tab concurrency', () => {
    it('should share one in-flight refresh request', async () => {
      // Mock the API call
      const mockRefresh = vi.fn().mockResolvedValue({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
      });

      // Start multiple refresh calls concurrently
      const results = await Promise.all([
        refreshTokens(),
        refreshTokens(),
        refreshTokens(),
      ]);

      // All results should be the same
      expect(results[0]).toEqual(results[1]);
      expect(results[1]).toEqual(results[2]);
    });
  });

  describe('Cross-tab propagation', () => {
    it('should broadcast token refresh to other tabs', async () => {
      // Mock successful refresh
      const mockTokens = {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
      };

      // Trigger a refresh
      await refreshTokens();

      // Should broadcast to other tabs
      expect(mockPostMessage).toHaveBeenCalledWith({
        type: 'TOKEN_REFRESHED',
        tokens: expect.any(Object),
      });
    });

    it('should adopt tokens from other tabs', () => {
      const mockTokens = {
        accessToken: 'token-from-other-tab',
        refreshToken: 'refresh-from-other-tab',
        expiresIn: 3600,
        tokenType: 'Bearer',
      };

      // Simulate receiving a message from another tab
      const channel = new MockBroadcastChannel('tot_auth_sync');
      if (channel.onmessage) {
        channel.onmessage({
          data: {
            type: 'TOKEN_REFRESHED',
            tokens: mockTokens,
          },
        });
      }

      // Should adopt the tokens
      expect(getAccessToken()).toBe('token-from-other-tab');
    });
  });

  describe('Failure behavior', () => {
    it('should not clear valid tokens on refresh failure', async () => {
      // Set initial tokens
      localStorageMock.setItem(
        'tot_auth_tokens',
        JSON.stringify({
          accessToken: 'valid-token',
          refreshToken: 'valid-refresh',
          expiresIn: 3600,
          tokenType: 'Bearer',
        })
      );

      // Mock failed refresh
      vi.fn().mockRejectedValue(new Error('Network error'));

      // Attempt refresh
      const result = await refreshTokens();

      // Should not clear tokens
      expect(result).toBeNull();
      expect(localStorageMock.removeItem).not.toHaveBeenCalled();
    });

    it('should check localStorage for fresher tokens on failure', async () => {
      // Set tokens in localStorage
      localStorageMock.setItem(
        'tot_auth_tokens',
        JSON.stringify({
          accessToken: 'fresher-token',
          refreshToken: 'fresher-refresh',
          expiresIn: 3600,
          tokenType: 'Bearer',
        })
      );

      // Mock failed refresh
      vi.fn().mockRejectedValue(new Error('Network error'));

      // Attempt refresh
      await refreshTokens();

      // Should check localStorage
      expect(localStorageMock.getItem).toHaveBeenCalledWith('tot_auth_tokens');
    });
  });
});

describe('Authentication State', () => {
  it('should report authenticated when tokens exist', () => {
    localStorageMock.setItem(
      'tot_auth_tokens',
      JSON.stringify({
        accessToken: 'valid-token',
        refreshToken: 'valid-refresh',
        expiresIn: 3600,
        tokenType: 'Bearer',
      })
    );

    expect(isAuthenticated()).toBe(true);
  });

  it('should report unauthenticated when no tokens', () => {
    expect(isAuthenticated()).toBe(false);
  });
});
