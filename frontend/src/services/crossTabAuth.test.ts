// @ts-nocheck - TODO: Fix types for v2. See V2-619.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  coordinateRefresh,
  initCrossTabAuth,
  broadcastRefreshComplete,
  broadcastRefreshFailed,
  cleanup,
  getTabId,
} from './crossTabAuth';

// ---------------------------------------------------------------------------
// MOCKS
// ---------------------------------------------------------------------------

// Mock BroadcastChannel
class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  name: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  postedMessages: unknown[] = [];

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.postedMessages.push(message);
    // Deliver to other instances (simulating cross-tab)
    for (const instance of MockBroadcastChannel.instances) {
      if (instance !== this && instance.onmessage) {
        instance.onmessage({ data: message } as MessageEvent);
      }
    }
  }

  close(): void {
    const idx = MockBroadcastChannel.instances.indexOf(this);
    if (idx >= 0) MockBroadcastChannel.instances.splice(idx, 1);
  }

  static reset(): void {
    MockBroadcastChannel.instances = [];
  }
}

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
  };
})();

// ---------------------------------------------------------------------------
// SETUP
// ---------------------------------------------------------------------------

beforeEach(() => {
  MockBroadcastChannel.reset();
  localStorageMock.clear();
  vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
  vi.stubGlobal('localStorage', localStorageMock);
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe('crossTabAuth', () => {
  describe('coordinateRefresh', () => {
    it('should perform refresh when no lock is held', async () => {
      const mockTokens = {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
      };

      const performRefresh = vi.fn().mockResolvedValue(mockTokens);

      const result = await coordinateRefresh(performRefresh);

      expect(result).toEqual(mockTokens);
      expect(performRefresh).toHaveBeenCalledTimes(1);
    });

    it('should return null when refresh fails', async () => {
      const performRefresh = vi.fn().mockResolvedValue(null);

      const result = await coordinateRefresh(performRefresh);

      expect(result).toBeNull();
    });

    it('should only allow one concurrent refresh in the same tab', async () => {
      let resolveFirst: (value: unknown) => void;
      const firstCall = new Promise((resolve) => {
        resolveFirst = resolve;
      });

      const mockTokens = {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
      };

      const performRefresh = vi.fn()
        .mockImplementationOnce(() => firstCall.then(() => mockTokens))
        .mockResolvedValue(mockTokens);

      // Start two concurrent refreshes
      const promise1 = coordinateRefresh(performRefresh);
      const promise2 = coordinateRefresh(performRefresh);

      // Both should resolve to the same result
      // Complete the first refresh
      resolveFirst!(undefined);

      const [result1, result2] = await Promise.all([promise1, promise2]);
      expect(result1).toEqual(mockTokens);
      expect(result2).toEqual(mockTokens);

      // performRefresh should only be called once
      expect(performRefresh).toHaveBeenCalledTimes(1);
    });

    it('should broadcast refresh-complete to other tabs', async () => {
      const mockTokens = {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
      };

      const performRefresh = vi.fn().mockResolvedValue(mockTokens);

      await coordinateRefresh(performRefresh);

      // Check that a broadcast was made
      const channels = MockBroadcastChannel.instances;
      expect(channels.length).toBeGreaterThan(0);

      const lastMessage = channels[0].postedMessages[channels[0].postedMessages.length - 1] as Record<string, unknown>;
      expect(lastMessage.type).toBe('refresh-complete');
      expect(lastMessage.tokens).toEqual(mockTokens);
    });

    it('should broadcast refresh-failed when refresh throws', async () => {
      const performRefresh = vi.fn().mockRejectedValue(new Error('Network error'));

      await expect(coordinateRefresh(performRefresh)).rejects.toThrow('Network error');

      const channels = MockBroadcastChannel.instances;
      expect(channels.length).toBeGreaterThan(0);

      const lastMessage = channels[0].postedMessages[channels[0].postedMessages.length - 1] as Record<string, unknown>;
      expect(lastMessage.type).toBe('refresh-failed');
    });

    it('should adopt tokens from another tab when lock is held', async () => {
      const currentTabId = getTabId();

      // Simulate another tab holding the lock
      localStorageMock.setItem('tot_refresh_lock', JSON.stringify({
        tabId: 'other-tab-id',
        timestamp: Date.now(),
      }));

      const mockTokens = {
        accessToken: 'refreshed-token',
        refreshToken: 'refreshed-refresh',
        expiresIn: 3600,
        tokenType: 'Bearer',
      };

      let callbackCalled = false;
      const cleanupFn = initCrossTabAuth((tokens) => {
        callbackCalled = true;
        expect(tokens).toEqual(mockTokens);
      });

      const performRefresh = vi.fn();

      // Start coordinateRefresh — it should wait for the other tab
      const refreshPromise = coordinateRefresh(performRefresh);

      // Simulate the other tab completing via BroadcastChannel
      const channels = MockBroadcastChannel.instances;
      expect(channels.length).toBeGreaterThan(0);

      // Find a channel that's not the one created by coordinateRefresh's lock attempt
      // and trigger its onmessage
      for (const ch of channels) {
        if (ch.onmessage) {
          ch.onmessage({
            data: {
              type: 'refresh-complete',
              tabId: 'other-tab',
              tokens: mockTokens,
              timestamp: Date.now(),
            },
          } as MessageEvent);
          break;
        }
      }

      const result = await refreshPromise;

      // Should NOT have called performRefresh (other tab did it)
      expect(performRefresh).not.toHaveBeenCalled();

      // Should have received the other tab's tokens
      expect(result).toEqual(mockTokens);
      expect(callbackCalled).toBe(true);

      cleanupFn();
    });

    it('should handle timeout when other tab does not respond', async () => {
      // Simulate another tab holding the lock
      localStorageMock.setItem('tot_refresh_lock', JSON.stringify({
        tabId: 'other-tab-id',
        timestamp: Date.now(),
      }));

      const performRefresh = vi.fn();

      const refreshPromise = coordinateRefresh(performRefresh);

      // Fast-forward time past the timeout
      vi.advanceTimersByTime(16000);

      await expect(refreshPromise).rejects.toThrow('Timeout waiting for cross-tab refresh');
    });
  });

  describe('initCrossTabAuth', () => {
    it('should return a cleanup function', () => {
      const cleanupFn = initCrossTabAuth(() => {});
      expect(typeof cleanupFn).toBe('function');
    });

    it('should call callback when refresh-complete message is received', async () => {
      const mockTokens = {
        accessToken: 'token-from-other-tab',
        refreshToken: 'refresh-from-other-tab',
        expiresIn: 3600,
        tokenType: 'Bearer',
      };

      const callback = vi.fn();
      const cleanupFn = initCrossTabAuth(callback);

      // Simulate another tab broadcasting
      const channels = MockBroadcastChannel.instances;
      expect(channels.length).toBeGreaterThan(0);

      channels[0].onmessage?.({
        data: {
          type: 'refresh-complete',
          tabId: 'other-tab',
          tokens: mockTokens,
          timestamp: Date.now(),
        },
      } as MessageEvent);

      expect(callback).toHaveBeenCalledWith(mockTokens);
      cleanupFn();
    });

    it('should ignore messages from the same tab', async () => {
      const currentTabId = getTabId();
      const callback = vi.fn();
      const cleanupFn = initCrossTabAuth(callback);

      const channels = MockBroadcastChannel.instances;
      channels[0].onmessage?.({
        data: {
          type: 'refresh-complete',
          tabId: currentTabId, // Same tab ID
          tokens: {},
          timestamp: Date.now(),
        },
      } as MessageEvent);

      expect(callback).not.toHaveBeenCalled();
      cleanupFn();
    });
  });

  describe('broadcastRefreshComplete', () => {
    it('should broadcast tokens to other tabs', () => {
      const mockTokens = {
        accessToken: 'broadcast-token',
        refreshToken: 'broadcast-refresh',
        expiresIn: 3600,
        tokenType: 'Bearer',
      };

      // Create two channel instances to simulate two tabs
      const channel1 = new MockBroadcastChannel('tot-auth-refresh');
      const channel2 = new MockBroadcastChannel('tot-auth-refresh');
      const receivedMessages: unknown[] = [];

      channel2.onmessage = (event) => {
        receivedMessages.push(event.data);
      };

      broadcastRefreshComplete(mockTokens);

      expect(receivedMessages).toHaveLength(1);
      expect((receivedMessages[0] as Record<string, unknown>).type).toBe('refresh-complete');
    });
  });

  describe('getTabId', () => {
    it('should return a non-empty tab ID', () => {
      const id = getTabId();
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    });
  });
});
