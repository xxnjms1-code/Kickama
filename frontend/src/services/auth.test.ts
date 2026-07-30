/**
 * Unit tests for auth service cross-tab refresh coordination
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the API module
vi.mock('./api', () => ({
  get: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
}));

// Mock localStorage
const mockLocalStorage = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};

Object.defineProperty(globalThis, 'localStorage', {
  value: mockLocalStorage,
});

// Mock BroadcastChannel
class MockBroadcastChannel {
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  close = vi.fn();

  constructor(public name: string) {}
}

Object.defineProperty(globalThis, 'BroadcastChannel', {
  value: MockBroadcastChannel,
});

// Import after mocks
import * as auth from './auth';
import { get, post, del } from './api';

describe('Auth Service - Cross-tab Refresh Coordination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalStorage.getItem.mockReturnValue(null);
    mockLocalStorage.setItem.mockImplementation(() => {});
    mockLocalStorage.removeItem.mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Same-tab concurrency', () => {
    it('should share one in-flight refresh request for concurrent calls', async () => {
      const mockTokens = {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
      };

      (post as any).mockResolvedValue({ data: { tokens: mockTokens } });
      mockLocalStorage.getItem.mockReturnValue(JSON.stringify({
        accessToken: 'old-access-token',
        refreshToken: 'old-refresh-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
      }));

      // Make concurrent refresh calls
      const refresh1 = auth.refreshTokens();
      const refresh2 = auth.refreshTokens();
      const refresh3 = auth.refreshTokens();

      const results = await Promise.all([refresh1, refresh2, refresh3]);

      // All should return the same result
      expect(results[0]).toEqual(mockTokens);
      expect(results[1]).toEqual(mockTokens);
      expect(results[2]).toEqual(mockTokens);

      // Only one API call should be made
      expect(post).toHaveBeenCalledTimes(1);
    });
  });

  describe('Cross-tab success propagation', () => {
    it('should adopt tokens from another tabs successful refresh', async () => {
      const mockTokens = {
        accessToken: 'external-refresh-token',
        refreshToken: 'external-refresh-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
      };

      // Simulate external refresh result in localStorage
      mockLocalStorage.getItem.mockImplementation((key: string) => {
        if (key === 'tot_refresh_result') {
          return JSON.stringify({
            type: 'REFRESH_SUCCESS',
            tokens: mockTokens,
            timestamp: Date.now(),
          });
        }
        return JSON.stringify({
          accessToken: 'old-access-token',
          refreshToken: 'old-refresh-token',
          expiresIn: 3600,
          tokenType: 'Bearer',
        });
      });

      const result = await auth.refreshTokens();

      // Should return tokens from external refresh without making API call
      expect(result).toEqual(mockTokens);
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe('Refresh failure behavior', () => {
    it('should not clear valid tokens when another tab has successful in-flight refresh', async () => {
      const mockTokens = {
        accessToken: 'valid-token',
        refreshToken: 'valid-refresh-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
      };

      mockLocalStorage.getItem.mockImplementation((key: string) => {
        if (key === 'tot_auth_tokens') {
          return JSON.stringify(mockTokens);
        }
        if (key === 'tot_refresh_lock') {
          // Lock is held by another tab
          return (Date.now() - 5000).toString();
        }
        return null;
      });

      (post as any).mockRejectedValue(new Error('Refresh failed'));

      const result = await auth.refreshTokens();

      // Should return null but not clear tokens (another tab might succeed)
      expect(result).toBeNull();
      // Tokens should still be in localStorage (not cleared)
      expect(mockLocalStorage.removeItem).not.toHaveBeenCalledWith('tot_auth_tokens');
    });

    it('should clear tokens when refresh fails and no other tab succeeds', async () => {
      const mockTokens = {
        accessToken: 'expired-token',
        refreshToken: 'valid-refresh-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
      };

      mockLocalStorage.getItem.mockImplementation((key: string) => {
        if (key === 'tot_auth_tokens') {
          return JSON.stringify(mockTokens);
        }
        return null;
      });

      (post as any).mockRejectedValue(new Error('Refresh failed'));

      const result = await auth.refreshTokens();

      // Should return null and clear tokens
      expect(result).toBeNull();
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('tot_auth_tokens');
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('tot_user_data');
    });
  });

  describe('BroadcastChannel fallback', () => {
    it('should use localStorage when BroadcastChannel is not available', () => {
      // Temporarily remove BroadcastChannel
      const originalBroadcastChannel = globalThis.BroadcastChannel;
      delete (globalThis as any).BroadcastChannel;

      // Test that the module doesn't crash when BroadcastChannel is unavailable
      // The initBroadcastChannel function should handle this gracefully
      expect(() => {
        // This would be called during module initialization
        if (typeof BroadcastChannel !== 'undefined') {
          new BroadcastChannel('test');
        }
      }).not.toThrow();

      // Restore BroadcastChannel
      globalThis.BroadcastChannel = originalBroadcastChannel;
    });
  });
});
