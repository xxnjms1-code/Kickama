// @ts-nocheck - TODO: Fix types for v2. See V2-619.
/**
 * Cross-tab authentication token refresh coordination.
 *
 * Uses BroadcastChannel (with localStorage fallback) to ensure that
 * when multiple tabs attempt to refresh tokens simultaneously, only
 * one tab performs the network request and others adopt the result.
 *
 * This prevents the race condition where multiple tabs send independent
 * /auth/refresh requests and overwrite each other's tokens.
 */

import type { AuthTokens } from './auth';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface RefreshRequestMessage {
  type: 'refresh-request';
  tabId: string;
  timestamp: number;
}

export interface RefreshCompleteMessage {
  type: 'refresh-complete';
  tabId: string;
  tokens: AuthTokens;
  timestamp: number;
}

export interface RefreshFailedMessage {
  type: 'refresh-failed';
  tabId: string;
  timestamp: number;
}

export interface RefreshLockMessage {
  type: 'refresh-lock';
  tabId: string;
  timestamp: number;
}

export type RefreshMessage =
  | RefreshRequestMessage
  | RefreshCompleteMessage
  | RefreshFailedMessage
  | RefreshLockMessage;

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

const CHANNEL_NAME = 'tot-auth-refresh';
const LOCK_KEY = 'tot_refresh_lock';
const LOCK_TTL_MS = 10000; // 10 seconds max lock duration
const REQUEST_TIMEOUT_MS = 15000; // 15 seconds to wait for refresh

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------

let tabId: string;
try {
  tabId = crypto.randomUUID();
} catch {
  tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

let channel: BroadcastChannel | null = null;
let refreshPromise: Promise<AuthTokens | null> | null = null;
let onTokensUpdated: ((tokens: AuthTokens) => void) | null = null;

// ---------------------------------------------------------------------------
// BROADCAST CHANNEL SETUP
// ---------------------------------------------------------------------------

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channel) {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
    } catch {
      return null;
    }
  }
  return channel;
}

// ---------------------------------------------------------------------------
// LOCALSTORAGE FALLBACK
// ---------------------------------------------------------------------------

function localStorageBroadcast(message: RefreshMessage): void {
  try {
    const key = `tot_auth_msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    localStorage.setItem(key, JSON.stringify(message));
    // Clean up old messages after a short delay
    setTimeout(() => {
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore
      }
    }, 1000);
  } catch {
    // localStorage unavailable
  }
}

function setupStorageListener(): void {
  if (typeof window === 'undefined') return;

  window.addEventListener('storage', (event) => {
    if (!event.key || !event.key.startsWith('tot_auth_msg_')) return;
    if (!event.newValue) return;

    try {
      const message = JSON.parse(event.newValue) as RefreshMessage;
      handleMessage(message);
    } catch {
      // ignore malformed messages
    }
  });
}

// ---------------------------------------------------------------------------
// LOCK MANAGEMENT
// ---------------------------------------------------------------------------

function acquireLock(): boolean {
  try {
    const existing = localStorage.getItem(LOCK_KEY);
    if (existing) {
      const lock = JSON.parse(existing) as { tabId: string; timestamp: number };
      // Check if lock is still valid
      if (Date.now() - lock.timestamp < LOCK_TTL_MS && lock.tabId !== tabId) {
        return false; // Another tab holds the lock
      }
    }
    // Acquire lock
    localStorage.setItem(LOCK_KEY, JSON.stringify({ tabId, timestamp: Date.now() }));
    return true;
  } catch {
    return true; // If localStorage fails, proceed anyway
  }
}

function releaseLock(): void {
  try {
    const existing = localStorage.getItem(LOCK_KEY);
    if (existing) {
      const lock = JSON.parse(existing) as { tabId: string };
      if (lock.tabId === tabId) {
        localStorage.removeItem(LOCK_KEY);
      }
    }
  } catch {
    // ignore
  }
}

function isLockValid(): boolean {
  try {
    const existing = localStorage.getItem(LOCK_KEY);
    if (!existing) return false;
    const lock = JSON.parse(existing) as { tabId: string; timestamp: number };
    return lock.tabId === tabId && Date.now() - lock.timestamp < LOCK_TTL_MS;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// MESSAGE HANDLING
// ---------------------------------------------------------------------------

const pendingResolvers: Map<string, {
  resolve: (tokens: AuthTokens) => void;
  reject: (error: Error) => void;
}> = new Map();

function handleMessage(message: RefreshMessage): void {
  if (message.tabId === tabId) return; // Ignore own messages

  switch (message.type) {
    case 'refresh-complete': {
      // Another tab completed the refresh — adopt its tokens
      const resolver = pendingResolvers.get('refresh');
      if (resolver) {
        resolver.resolve(message.tokens);
        pendingResolvers.delete('refresh');
      }
      if (onTokensUpdated) {
        onTokensUpdated(message.tokens);
      }
      break;
    }

    case 'refresh-failed': {
      // Another tab's refresh failed
      const resolver = pendingResolvers.get('refresh');
      if (resolver) {
        resolver.reject(new Error('Refresh failed in coordinating tab'));
        pendingResolvers.delete('refresh');
      }
      break;
    }

    case 'refresh-lock': {
      // Another tab is claiming the lock
      // If we were trying to acquire it, we should back off
      const resolver = pendingResolvers.get('lock');
      if (resolver) {
        resolver.reject(new Error('Lock acquired by another tab'));
        pendingResolvers.delete('lock');
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

export function initCrossTabAuth(tokensUpdater: (tokens: AuthTokens) => void): () => void {
  onTokensUpdated = tokensUpdater;

  const ch = getChannel();
  if (ch) {
    ch.onmessage = (event: MessageEvent<RefreshMessage>) => {
      handleMessage(event.data);
    };
  } else {
    setupStorageListener();
  }

  return () => {
    if (ch) {
      ch.onmessage = null;
    }
    onTokensUpdated = null;
  };
}

export function broadcastRefreshComplete(tokens: AuthTokens): void {
  const message: RefreshCompleteMessage = {
    type: 'refresh-complete',
    tabId,
    tokens,
    timestamp: Date.now(),
  };

  const ch = getChannel();
  if (ch) {
    ch.postMessage(message);
  } else {
    localStorageBroadcast(message);
  }
}

export function broadcastRefreshFailed(): void {
  const message: RefreshFailedMessage = {
    type: 'refresh-failed',
    tabId,
    timestamp: Date.now(),
  };

  const ch = getChannel();
  if (ch) {
    ch.postMessage(message);
  } else {
    localStorageBroadcast(message);
  }
}

export async function coordinateRefresh(
  performRefresh: () => Promise<AuthTokens | null>
): Promise<AuthTokens | null> {
  // If a refresh is already in-flight in this tab, wait for it
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      // Try to acquire the refresh lock
      if (!acquireLock()) {
        // Another tab has the lock — wait for the result
        return new Promise<AuthTokens>((resolve, reject) => {
          pendingResolvers.set('refresh', { resolve, reject });
          // Timeout: if we don't hear back, assume the other tab failed
          setTimeout(() => {
            if (pendingResolvers.has('refresh')) {
              pendingResolvers.delete('refresh');
              reject(new Error('Timeout waiting for cross-tab refresh'));
            }
          }, REQUEST_TIMEOUT_MS);
        });
      }

      // We hold the lock — perform the refresh
      const result = await performRefresh();

      if (result) {
        broadcastRefreshComplete(result);
      } else {
        broadcastRefreshFailed();
      }

      return result;
    } catch (error) {
      broadcastRefreshFailed();
      throw error;
    } finally {
      releaseLock();
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export function getTabId(): string {
  return tabId;
}

export function cleanup(): void {
  refreshPromise = null;
  pendingResolvers.clear();
  releaseLock();
  if (channel) {
    channel.close();
    channel = null;
  }
}
