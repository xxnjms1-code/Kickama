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
  name: string;
  acceptTerms: boolean;
  acceptPrivacy: boolean;
  referralCode?: string;
}

export interface MFASetupResponse {
  secret: string;
  qrCode: string;
  backupCodes: string[];
}

export interface Session {
  id: string;
  deviceName: string;
  deviceType: string;
  ipAddress: string;
  location?: string;
  createdAt: string;
  lastActiveAt: string;
  isCurrent: boolean;
}

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------

const TOKEN_KEY = 'tot_auth_tokens';
const USER_KEY = 'tot_user_data';
const REFRESH_THRESHOLD = 60; // seconds before expiry to attempt refresh

/** localStorage key used for cross-tab refresh coordination fallback */
const REFRESH_EVENT_KEY = 'tot_auth_refresh_event';

/** BroadcastChannel name for cross-tab token refresh coordination */
const BC_CHANNEL_NAME = 'tot-auth-refresh';

let currentTokens: AuthTokens | null = null;
let currentUser: User | null = null;
let refreshTimer: number | null = null;
let authListeners: Array<(user: User | null) => void> = [];

// ---------------------------------------------------------------------------
// CROSS-TAB REFRESH COORDINATION STATE
// ---------------------------------------------------------------------------

/**
 * Tracks the in-flight refresh promise so concurrent calls within the same tab
 * share a single network request.
 */
let inFlightRefresh: Promise<AuthTokens | null> | null = null;

/**
 * BroadcastChannel instance for cross-tab communication.
 * Initialized lazily on first refresh attempt.
 */
let bc: BroadcastChannel | null = null;

/**
 * Set to true once the BroadcastChannel and localStorage listeners are set up.
 */
let coordinationInitialized = false;

// ---------------------------------------------------------------------------
// CROSS-TAB REFRESH COORDINATION
// ---------------------------------------------------------------------------

/**
 * Initialize cross-tab refresh coordination using BroadcastChannel with a
 * localStorage event fallback. Safe to call multiple times.
 */
function initRefreshCoordination(): void {
  if (coordinationInitialized) return;

  // Primary channel: BroadcastChannel
  try {
    bc = new BroadcastChannel(BC_CHANNEL_NAME);
    bc.onmessage = (event: MessageEvent) => {
      const data = event.data;
      if (data && data.type === 'tokens-refreshed' && data.tokens) {
        // Another tab has refreshed tokens — adopt them locally.
        storeTokens(data.tokens);
        if (data.user) {
          currentUser = data.user;
        }
        notifyListeners(currentUser);

        // Resolve any in-flight refresh pending in this tab.
        if (inFlightRefresh !== null) {
          const resolveHolder = (inFlightRefresh as unknown as { _resolve: (v: AuthTokens | null) => void })._resolve;
          if (resolveHolder) {
            resolveHolder(data.tokens);
          }
        }
      }
    };
  } catch {
    // BroadcastChannel may be unavailable (e.g., older browsers, non-browser contexts).
    bc = null;
  }

  // Fallback: localStorage events (fires across tabs when BroadcastChannel is unavailable)
  try {
    window.addEventListener('storage', (event: StorageEvent) => {
      if (event.key === REFRESH_EVENT_KEY && event.newValue) {
        try {
          const data = JSON.parse(event.newValue);
          if (data && data.type === 'tokens-refreshed' && data.tokens) {
            // Only adopt if we didn't initiate this ourselves (timestamp-based guard).
            const ourTimestamp = localStorage.getItem(REFRESH_EVENT_KEY + '_ts');
            if (data.timestamp && ourTimestamp && data.timestamp === ourTimestamp) {
              return; // Our own event, skip.
            }
            storeTokens(data.tokens);
            if (data.user) {
              currentUser = data.user;
            }
            notifyListeners(currentUser);
          }
        } catch {
          // ignore malformed events
        }
      }
    });
  } catch {
    // localStorage events may be unavailable
  }

  coordinationInitialized = true;
}

/**
 * Broadcast refreshed tokens to all other tabs via BroadcastChannel, with
 * localStorage fallback.
 */
function broadcastTokens(tokens: AuthTokens): void {
  const payload = {
    type: 'tokens-refreshed',
    tokens,
    user: currentUser,
    timestamp: Date.now().toString(),
  };

  // Primary: BroadcastChannel
  if (bc) {
    try {
      bc.postMessage(payload);
    } catch {
      // ignore broadcast errors
    }
  }

  // Fallback: localStorage event
  try {
    localStorage.setItem(REFRESH_EVENT_KEY + '_ts', payload.timestamp);
    localStorage.setItem(REFRESH_EVENT_KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return Date.now() >= payload.exp * 1000;
  } catch {
    return true;
  }
}

function getTokenExpiry(token: string): number {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp;
  } catch {
    return 0;
  }
}

function storeTokens(tokens: AuthTokens): void {
  currentTokens = tokens;
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  } catch {
    // localStorage may be unavailable in some environments
  }
}

function clearStoredTokens(): void {
  currentTokens = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    // ignore
  }
}

function loadStoredTokens(): AuthTokens | null {
  try {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (stored) {
      const tokens = JSON.parse(stored) as AuthTokens;
      if (!isTokenExpired(tokens.accessToken)) {
        currentTokens = tokens;
        return tokens;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function notifyListeners(user: User | null): void {
  for (const listener of authListeners) {
    try {
      listener(user);
    } catch {
      // ignore listener errors
    }
  }
}

function scheduleTokenRefresh(tokens: AuthTokens): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  const expiresIn = tokens.expiresIn;
  const refreshIn = Math.max((expiresIn - REFRESH_THRESHOLD) * 1000, 0);

  refreshTimer = window.setTimeout(async () => {
    try {
      const newTokens = await refreshTokens();
      if (newTokens) {
        scheduleTokenRefresh(newTokens);
      }
    } catch {
      // Refresh failed, will retry on next API call
    }
  }, refreshIn);
}

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

export async function login(request: LoginRequest): Promise<AuthTokens> {
  const response = await post<{ tokens: AuthTokens; user: User }>('/auth/login', request);

  storeTokens(response.data.tokens);
  currentUser = response.data.user;

  try {
    localStorage.setItem(USER_KEY, JSON.stringify(response.data.user));
  } catch {
    // ignore
  }

  // Initialize cross-tab coordination so other tabs learn about this login.
  initRefreshCoordination();
  broadcastTokens(response.data.tokens);
  scheduleTokenRefresh(response.data.tokens);
  notifyListeners(response.data.user);

  return response.data.tokens;
}

export async function register(request: RegisterRequest): Promise<AuthTokens> {
  const response = await post<{ tokens: AuthTokens; user: User }>('/auth/register', request);

  storeTokens(response.data.tokens);
  currentUser = response.data.user;

  try {
    localStorage.setItem(USER_KEY, JSON.stringify(response.data.user));
  } catch {
    // ignore
  }

  initRefreshCoordination();
  broadcastTokens(response.data.tokens);
  scheduleTokenRefresh(response.data.tokens);
  notifyListeners(response.data.user);

  return response.data.tokens;
}

export async function logout(): Promise<void> {
  try {
    await del('/auth/logout');
  } catch {
    // Silently ignore logout errors - we clear local state regardless
  }

  clearStoredTokens();
  currentUser = null;

  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  // Reset in-flight refresh so the next call starts fresh
  inFlightRefresh = null;

  notifyListeners(null);
}

export async function refreshTokens(): Promise<AuthTokens | null> {
  // Initialize cross-tab coordination on first refresh call.
  initRefreshCoordination();

  // If there's already an in-flight refresh in this tab, return the same promise.
  if (inFlightRefresh !== null) {
    return inFlightRefresh;
  }

  const tokens = currentTokens || loadStoredTokens();
  if (!tokens?.refreshToken) return null;

  // Create a controlled promise that can be resolved externally when another tab
  // broadcasts tokens, preventing unnecessary network calls during cross-tab race.
  let externalResolve: ((value: AuthTokens | null) => void) | null = null;
  const guardedPromise = new Promise<AuthTokens | null>((resolve) => {
    externalResolve = resolve;
  });

  // Tag the promise so broadcast handlers can resolve it externally.
  (guardedPromise as unknown as { _resolve: ((v: AuthTokens | null) => void) | null })._resolve = externalResolve;

  // Store the guarded promise so concurrent calls share it.
  inFlightRefresh = guardedPromise;

  try {
    const response = await post<{ tokens: AuthTokens }>('/auth/refresh', {
      refreshToken: tokens.refreshToken,
    });

    const newTokens = response.data.tokens;
    storeTokens(newTokens);
    scheduleTokenRefresh(newTokens);

    // Notify other tabs about the new tokens.
    broadcastTokens(newTokens);

    // Resolve the promise.
    if (externalResolve) {
      externalResolve(newTokens);
    }

    return newTokens;
  } catch (error) {
    // Refresh failed. Check if another tab recently refreshed successfully
    // by looking at localStorage. If so, don't clear valid tokens.
    const storedTokens = loadStoredTokens();
    if (storedTokens) {
      // Tokens are still valid (or were updated by another tab) — don't clear.
      if (externalResolve) {
        externalResolve(storedTokens);
      }
      return storedTokens;
    }

    // No valid tokens anywhere — clear and notify.
    clearStoredTokens();
    currentUser = null;
    notifyListeners(null);

    if (externalResolve) {
      externalResolve(null);
    }

    return null;
  } finally {
    // Reset in-flight tracking so that subsequent calls initiate a fresh request.
    // Delay the reset to avoid a thundering-herd problem in rapid sequential calls.
    setTimeout(() => {
      // Only reset if the current promise is still the one we set.
      if (inFlightRefresh === guardedPromise) {
        inFlightRefresh = null;
      }
    }, 0);
  }
}

export async function getCurrentUser(): Promise<User | null> {
  if (currentUser) return currentUser;

  // Try to load from local storage
  try {
    const stored = localStorage.getItem(USER_KEY);
    if (stored) {
      currentUser = JSON.parse(stored);
      return currentUser;
    }
  } catch {
    // ignore
  }

  // Try to restore session from stored tokens
  const tokens = loadStoredTokens();
  if (tokens && !isTokenExpired(tokens.accessToken)) {
    try {
      const response = await get<User>('/auth/me');
      currentUser = response.data;
      try {
        localStorage.setItem(USER_KEY, JSON.stringify(response.data));
      } catch {
        // ignore
      }
      return response.data;
    } catch {
      // Token might be expired or invalid
      const refreshed = await refreshTokens();
      if (refreshed) {
        const response = await get<User>('/auth/me');
        currentUser = response.data;
        return response.data;
      }
    }
  }

  return null;
}

export async function setupMFA(): Promise<MFASetupResponse> {
  const response = await post<MFASetupResponse>('/auth/mfa/setup');
  return response.data;
}

export async function verifyMFA(code: string): Promise<boolean> {
  const response = await post<{ verified: boolean }>('/auth/mfa/verify', { code });
  return response.data.verified;
}

export async function disableMFA(password: string): Promise<void> {
  await del('/auth/mfa/disable', { password });
}

export async function getBackupCodes(): Promise<string[]> {
  const response = await get<{ codes: string[] }>('/auth/mfa/backup-codes');
  return response.data.codes;
}

export async function regenerateBackupCodes(): Promise<string[]> {
  const response = await post<{ codes: string[] }>('/auth/mfa/backup-codes/regenerate');
  return response.data.codes;
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await post('/auth/change-password', {
    currentPassword,
    newPassword,
  });
}

export async function requestPasswordReset(email: string): Promise<void> {
  await post('/auth/reset-password', { email });
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  await post('/auth/reset-password/confirm', { token, newPassword });
}

export async function verifyEmail(token: string): Promise<void> {
  await post('/auth/verify-email', { token });
}

export async function resendVerificationEmail(): Promise<void> {
  await post('/auth/verify-email/resend');
}

export async function getSessions(): Promise<Session[]> {
  const response = await get<{ sessions: Session[] }>('/auth/sessions');
  return response.data.sessions;
}

export async function revokeSession(sessionId: string): Promise<void> {
  await del(`/auth/sessions/${sessionId}`);
}

export async function revokeAllOtherSessions(): Promise<void> {
  await del('/auth/sessions/others');
}

export async function updateProfile(data: Partial<Pick<User, 'name' | 'avatarUrl'>>): Promise<User> {
  const response = await put<User>('/auth/profile', data);
  currentUser = response.data;
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(response.data));
  } catch {
    // ignore
  }
  notifyListeners(response.data);
  return response.data;
}

export async function updatePreferences(preferences: Partial<UserPreferences>): Promise<UserPreferences> {
  const response = await put<UserPreferences>('/auth/preferences', preferences);
  if (currentUser) {
    currentUser.preferences = { ...currentUser.preferences, ...response.data };
  }
  return response.data;
}

export function getAccessToken(): string | null {
  return currentTokens?.accessToken || null;
}

export function isAuthenticated(): boolean {
  const tokens = currentTokens || loadStoredTokens();
  return tokens !== null && !isTokenExpired(tokens.accessToken);
}

export function onAuthChange(listener: (user: User | null) => void): () => void {
  authListeners.push(listener);
  return () => {
    authListeners = authListeners.filter(l => l !== listener);
  };
}

export function getPermissions(): string[] {
  return currentUser?.permissions || [];
}

export function hasPermission(permission: string): boolean {
  return getPermissions().includes(permission) || currentUser?.role === 'admin';
}

export function hasRole(role: UserRole | UserRole[]): boolean {
  if (!currentUser) return false;
  if (Array.isArray(role)) {
    return role.includes(currentUser.role);
  }
  return currentUser.role === role;
}
