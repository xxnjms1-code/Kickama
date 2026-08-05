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
 * Token refresh is coordinated across tabs using a BroadcastChannel (with a
 * localStorage fallback) so that concurrent refresh attempts share a single
 * in-flight network request and token updates propagate safely. See
 * `refreshTokens()` and the cross-tab coordination helpers below.
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

let currentTokens: AuthTokens | null = null;
let currentUser: User | null = null;
let refreshTimer: number | null = null;
let authListeners: Array<(user: User | null) => void> = [];

// ---------------------------------------------------------------------------
// CROSS-TAB REFRESH COORDINATION STATE
// ---------------------------------------------------------------------------

/** BroadcastChannel name used to propagate refresh results across tabs. */
const REFRESH_CHANNEL_NAME = 'tot-auth-refresh';
/** localStorage key holding the current refresh leader lease. */
const REFRESH_LEADER_KEY = 'tot_refresh_leader';
/** How long (ms) a leader lease is considered valid before another tab may take over. */
const REFRESH_LEADER_TTL_MS = 10_000;
/** How long (ms) a follower waits for the leader's result before taking over itself. */
const REFRESH_FOLLOWER_TIMEOUT_MS = 8_000;

/** Unique id for this tab/session, used for leader election. */
const tabId = Math.random().toString(36).slice(2);

/** In-flight refresh promise shared by all same-tab callers (same-tab de-duplication). */
let refreshInFlight: Promise<AuthTokens | null> | null = null;

/** Lazily-created BroadcastChannel for cross-tab refresh messages. */
let refreshChannel: BroadcastChannel | null = null;

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

/**
 * Read the refresh token currently persisted in localStorage, without any
 * expiry check or side effects. Used to detect whether another tab has
 * replaced the stored tokens while a refresh was in flight, so that a failed
 * refresh does not wipe tokens stored by a concurrent successful refresh.
 */
function getStoredRefreshToken(): string | null {
  try {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (!stored) return null;
    const tokens = JSON.parse(stored) as AuthTokens;
    return tokens?.refreshToken ?? null;
  } catch {
    return null;
  }
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
// CROSS-TAB REFRESH COORDINATION HELPERS
// ---------------------------------------------------------------------------

/**
 * Message broadcast between tabs to coordinate token refresh.
 * - `refresh-success`: the leader completed a refresh and is sharing the new tokens.
 * - `refresh-failure`: the leader's refresh failed; followers may take over.
 */
type RefreshMessage =
  | { type: 'refresh-success'; tokens: AuthTokens; leader: string }
  | { type: 'refresh-failure'; leader: string };

/**
 * Lazily create (and cache) the BroadcastChannel used for cross-tab refresh
 * coordination. Returns null when BroadcastChannel is unavailable, in which
 * case the localStorage `storage` event is used as a fallback.
 */
function getRefreshChannel(): BroadcastChannel | null {
  if (refreshChannel) return refreshChannel;
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    refreshChannel = new BroadcastChannel(REFRESH_CHANNEL_NAME);
    return refreshChannel;
  } catch {
    return null;
  }
}

/**
 * Broadcast a refresh result message to other tabs. Uses BroadcastChannel when
 * available, otherwise writes to localStorage so the `storage` event fires in
 * other tabs (same-tab storage events do not fire, which is the desired behaviour).
 */
function sendRefreshMessage(message: RefreshMessage): void {
  const channel = getRefreshChannel();
  if (channel) {
    try {
      channel.postMessage(message);
      return;
    } catch {
      // fall through to localStorage fallback
    }
  }
  try {
    localStorage.setItem(REFRESH_CHANNEL_NAME, JSON.stringify({ ...message, _ts: Date.now() }));
  } catch {
    // ignore – no other tab will be notified
  }
}

/**
 * Subscribe to refresh result messages from other tabs. Returns an unsubscribe
 * function. Uses BroadcastChannel when available, otherwise listens to the
 * localStorage `storage` event.
 */
function onRefreshMessage(handler: (message: RefreshMessage) => void): () => void {
  const channel = getRefreshChannel();
  if (channel) {
    const listener = (event: MessageEvent) => {
      if (event && event.data) handler(event.data as RefreshMessage);
    };
    channel.addEventListener('message', listener);
    return () => channel.removeEventListener('message', listener);
  }

  const listener = (event: StorageEvent) => {
    if (event.key === REFRESH_CHANNEL_NAME && event.newValue) {
      try {
        handler(JSON.parse(event.newValue) as RefreshMessage);
      } catch {
        // ignore malformed messages
      }
    }
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}

/**
 * Attempt to acquire the refresh leader lease. Returns true when this tab becomes
 * the leader (no other fresh lease exists). When localStorage is unavailable the
 * tab always leads (effectively single-tab).
 */
function acquireLeadership(): boolean {
  const now = Date.now();
  try {
    const raw = localStorage.getItem(REFRESH_LEADER_KEY);
    if (raw) {
      const leader = JSON.parse(raw) as { tab: string; ts: number };
      if (leader && leader.tab !== tabId && now - leader.ts < REFRESH_LEADER_TTL_MS) {
        return false; // another tab holds a fresh lease
      }
    }
    localStorage.setItem(REFRESH_LEADER_KEY, JSON.stringify({ tab: tabId, ts: now }));
    return true;
  } catch {
    return true; // localStorage unavailable – assume single tab
  }
}

/**
 * Forcefully take the leader lease (used after a follower times out or a leader
 * reports failure). Overwrites any stale lease owned by another tab.
 */
function takeLeadership(): void {
  try {
    localStorage.setItem(REFRESH_LEADER_KEY, JSON.stringify({ tab: tabId, ts: Date.now() }));
  } catch {
    // ignore
  }
}

/** Release the leader lease, but only if it still belongs to this tab. */
function releaseLeadership(): void {
  try {
    const raw = localStorage.getItem(REFRESH_LEADER_KEY);
    if (raw) {
      const leader = JSON.parse(raw) as { tab: string; ts: number };
      if (leader && leader.tab === tabId) {
        localStorage.removeItem(REFRESH_LEADER_KEY);
      }
    }
  } catch {
    // ignore
  }
}

/**
 * Wait for the current leader to broadcast a refresh result. Resolves with the
 * adopted tokens on success, or null on failure/timeout (caller then takes over).
 */
function waitForLeaderResult(): Promise<AuthTokens | null> {
  return new Promise<AuthTokens | null>((resolve) => {
    let settled = false;

    const unsubscribe = onRefreshMessage((message) => {
      if (settled) return;
      if (message.type === 'refresh-success') {
        settled = true;
        cleanup();
        // Adopt the leader's tokens and keep the refresh schedule consistent.
        storeTokens(message.tokens);
        scheduleTokenRefresh(message.tokens);
        resolve(message.tokens);
      } else if (message.type === 'refresh-failure') {
        settled = true;
        cleanup();
        resolve(null);
      }
    });

    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null); // timed out waiting for the leader
    }, REFRESH_FOLLOWER_TIMEOUT_MS);

    function cleanup(): void {
      unsubscribe();
      clearTimeout(timer);
    }
  });
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

  notifyListeners(null);
}

export async function refreshTokens(): Promise<AuthTokens | null> {
  // Same-tab de-duplication: concurrent callers share a single in-flight refresh.
  if (refreshInFlight) {
    return refreshInFlight;
  }

  const tokens = currentTokens || loadStoredTokens();
  if (!tokens?.refreshToken) return null;

  // Remember the refresh token we started with so a later failure can detect
  // whether another tab already replaced the stored tokens.
  const refreshToken = tokens.refreshToken;

  refreshInFlight = performCoordinatedRefresh(refreshToken);
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

/**
 * Perform a token refresh coordinated across tabs.
 *
 * - If this tab wins the leader lease it performs the single network refresh
 *   and broadcasts the result so followers adopt the new tokens.
 * - If another tab already leads, this tab waits for the leader's result and
 *   adopts the tokens instead of issuing its own request.
 * - On failure tokens are only cleared when no other tab has updated them in
 *   the meantime, preventing a failed refresh from wiping valid tokens stored
 *   by a concurrent successful refresh.
 */
async function performCoordinatedRefresh(refreshToken: string): Promise<AuthTokens | null> {
  // Follower path: wait for an existing leader to publish a result.
  if (!acquireLeadership()) {
    const adopted = await waitForLeaderResult();
    if (adopted) return adopted;
    // Leader never answered (timed out or failed) – take over and refresh.
    takeLeadership();
  }

  // Leader path: perform the single network refresh for all tabs.
  try {
    const response = await post<{ tokens: AuthTokens }>('/auth/refresh', {
      refreshToken,
    });

    storeTokens(response.data.tokens);
    scheduleTokenRefresh(response.data.tokens);
    sendRefreshMessage({ type: 'refresh-success', tokens: response.data.tokens, leader: tabId });

    return response.data.tokens;
  } catch {
    // Only clear local state when the stored refresh token is still the one we
    // attempted to refresh. If another tab already stored newer tokens (i.e. the
    // stored refresh token changed) we keep them and avoid clobbering a
    // concurrent successful refresh.
    if (getStoredRefreshToken() === refreshToken) {
      sendRefreshMessage({ type: 'refresh-failure', leader: tabId });
      clearStoredTokens();
      currentUser = null;
      notifyListeners(null);
    }
    return null;
  } finally {
    releaseLeadership();
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
