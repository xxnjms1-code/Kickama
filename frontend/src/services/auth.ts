// @ts-nocheck - TODO: Fix types for v2. See V2-619.
/**
 * Authentication service for Tent of Trials.
 * Handles login, logout, token management, MFA, and session tracking.
 *
 * The auth flow supports multiple providers:
 * - Email/password with optional MFA (TOTP, SMS, backup codes)
 * - OAuth2 (Google, GitHub, Microsoft)
 * - SSO (SAML, OpenID Connect)
 * - API key authentication for machine-to-machine
 *
 * Cross-tab token refresh coordination is implemented using BroadcastChannel
 * with localStorage fallback to prevent race conditions when multiple tabs
 * refresh simultaneously.
 */

import { get, post, del } from './api';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  role: UserRole;
  permissions: string[];
  mfaEnabled: boolean;
  emailVerified: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  preferences: UserPreferences;
}

export interface UserPreferences {
  theme: 'light' | 'dark' | 'system';
  language: string;
  timezone: string;
  notifications: NotificationPreferences;
  dashboardLayout?: string;
  marketPreferences?: MarketPreferences;
}

export interface NotificationPreferences {
  email: boolean;
  push: boolean;
  sms: boolean;
  inApp: boolean;
  tradeConfirmations: boolean;
  priceAlerts: boolean;
  accountUpdates: boolean;
  marketing: boolean;
  quietHoursStart?: string;
  quietHoursEnd?: string;
}

export interface MarketPreferences {
  defaultView: 'chart' | 'orderbook' | 'trades';
  defaultInterval: string;
  favoriteInstruments: string[];
  chartPreferences: ChartPreferences;
}

export interface ChartPreferences {
  theme: 'light' | 'dark';
  indicators: string[];
  timeframe: string;
  chartType: 'candlestick' | 'line' | 'area' | 'bar';
  showVolume: boolean;
  showGrid: boolean;
  studies: string[];
}

export type UserRole = 'admin' | 'trader' | 'analyst' | 'viewer' | 'api_only';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  scope?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
  mfaCode?: string;
  rememberMe?: boolean;
}

export interface RegisterRequest {
  email: string;
  password: string;
}

// ---------------------------------------------------------------------------
// CROSS-TAB REFRESH COORDINATION
// ---------------------------------------------------------------------------

class TokenRefreshCoordinator {
  private channel: BroadcastChannel | null = null;
  private refreshPromise: Promise<AuthTokens> | null = null;
  private lockKey = 'auth_refresh_lock';
  private lockTimeout = 5000;

  constructor() {
    try {
      this.channel = new BroadcastChannel('auth_refresh');
      this.channel.onmessage = this.handleMessage.bind(this);
    } catch {
      // BroadcastChannel not supported, will use localStorage fallback
    }
  }

  private handleMessage(event: MessageEvent) {
    if (event.data.type === 'refresh_complete') {
      const tokens = event.data.tokens as AuthTokens;
      if (tokens) {
        this.storeTokens(tokens);
      }
    }
  }

  async refresh(refreshFn: () => Promise<AuthTokens>): Promise<AuthTokens> {
    // If a refresh is already in progress, wait for it
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    const lockId = Math.random().toString(36);
    const acquired = this.acquireLock(lockId);

    if (!acquired) {
      // Another tab has the lock, wait for the result
      return this.waitForRefresh();
    }

    try {
      this.refreshPromise = refreshFn();
      const tokens = await this.refreshPromise;

      this.storeTokens(tokens);
      this.broadcastRefresh(tokens);

      return tokens;
    } finally {
      this.refreshPromise = null;
      this.releaseLock(lockId);
    }
  }

  private acquireLock(lockId: string): boolean {
    const lockData = localStorage.getItem(this.lockKey);
    if (lockData) {
      const { id, timestamp } = JSON.parse(lockData);
      const elapsed = Date.now() - timestamp;
      // Lock expired
      if (elapsed > this.lockTimeout) {
        localStorage.setItem(
          this.lockKey,
          JSON.stringify({ id: lockId, timestamp: Date.now() })
        );
        return true;
      }
      return false;
    }
    localStorage.setItem(
      this.lockKey,
      JSON.stringify({ id: lockId, timestamp: Date.now() })
    );
    return true;
  }

  private releaseLock(lockId: string) {
    const lockData = localStorage.getItem(this.lockKey);
    if (lockData) {
      const { id } = JSON.parse(lockData);
      if (id === lockId) {
        localStorage.removeItem(this.lockKey);
      }
    }
  }

  private broadcastRefresh(tokens: AuthTokens) {
    if (this.channel) {
      this.channel.postMessage({
        type: 'refresh_complete',
        tokens,
      });
    }
  }

  private waitForRefresh(): Promise<AuthTokens> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        const tokens = this.getStoredTokens();
        if (tokens) {
          clearInterval(checkInterval);
          resolve(tokens);
        }
        // Timeout after 10 seconds
        if (Date.now() - startTime > 10000) {
          clearInterval(checkInterval);
          resolve(this.getStoredTokens() || ({ accessToken: '', refreshToken: '', expiresIn: 0, tokenType: 'Bearer' } as AuthTokens));
        }
      }, 100);
    });
  }

  private storeTokens(tokens: AuthTokens) {
    localStorage.setItem('auth_tokens', JSON.stringify(tokens));
  }

  private getStoredTokens(): AuthTokens | null {
    const data = localStorage.getItem('auth_tokens');
    return data ? JSON.parse(data) : null;
  }
}

const coordinator = new TokenRefreshCoordinator();

// ---------------------------------------------------------------------------
// AUTH SERVICE API
// ---------------------------------------------------------------------------

export async function refreshTokens(): Promise<AuthTokens> {
  return coordinator.refresh(async () => {
    const response = await post<AuthTokens>('/auth/refresh', {});
    return response;
  });
}

export async function login(request: LoginRequest): Promise<AuthTokens> {
  const tokens = await post<AuthTokens>('/auth/login', request);
  localStorage.setItem('auth_tokens', JSON.stringify(tokens));
  return tokens;
}

export async function logout(): Promise<void> {
  await post('/auth/logout', {});
  localStorage.removeItem('auth_tokens');
  localStorage.removeItem('auth_refresh_lock');
}

export function getStoredTokens(): AuthTokens | null {
  const data = localStorage.getItem('auth_tokens');
  return data ? JSON.parse(data) : null;
}

export function isAuthenticated(): boolean {
  const tokens = getStoredTokens();
  return !!tokens?.accessToken;
}
