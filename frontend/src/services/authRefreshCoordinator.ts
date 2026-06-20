export interface RefreshTokensLike {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  scope?: string;
}

interface RefreshLock {
  ownerId: string;
  requestId: string;
  expiresAt: number;
}

interface RefreshMessage {
  type: 'success' | 'failure';
  ownerId: string;
  requestId: string;
  tokens?: RefreshTokensLike;
  timestamp: number;
}

interface StorageEventLike {
  key: string | null;
  newValue: string | null;
}

interface BroadcastChannelLike {
  postMessage(message: RefreshMessage): void;
  close(): void;
  onmessage: ((event: { data: RefreshMessage }) => void) | null;
}

export interface TokenRefreshCoordinatorOptions {
  storage?: Storage | null;
  storageKeyPrefix?: string;
  lockTtlMs?: number;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  channelFactory?: ((name: string) => BroadcastChannelLike | null) | null;
  addStorageListener?: ((handler: (event: StorageEventLike) => void) => () => void) | null;
  now?: () => number;
  createId?: () => string;
}

export interface TokenRefreshCallbacks<Tokens extends RefreshTokensLike> {
  getRefreshToken(): string | null;
  performRefresh(refreshToken: string): Promise<Tokens>;
  applyTokens(tokens: Tokens): void;
  clearAuth(): void;
}

const DEFAULT_PREFIX = 'tot_auth_refresh';
const DEFAULT_LOCK_TTL_MS = 10_000;
const DEFAULT_WAIT_TIMEOUT_MS = 12_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

export class TokenRefreshCoordinator<Tokens extends RefreshTokensLike = RefreshTokensLike> {
  private readonly ownerId: string;
  private readonly storage: Storage | null;
  private readonly prefix: string;
  private readonly lockTtlMs: number;
  private readonly waitTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly addStorageListener?: (handler: (event: StorageEventLike) => void) => () => void;
  private readonly channel: BroadcastChannelLike | null;
  private inFlight: Promise<Tokens | null> | null = null;

  constructor(options: TokenRefreshCoordinatorOptions = {}) {
    this.prefix = options.storageKeyPrefix ?? DEFAULT_PREFIX;
    this.lockTtlMs = options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
    this.waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.storage = options.storage === undefined ? getBrowserStorage() : options.storage;
    this.now = options.now ?? (() => Date.now());
    this.createId = options.createId ?? (() => `${this.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
    this.ownerId = this.createId();
    this.addStorageListener = options.addStorageListener ?? getBrowserStorageListener();

    const channelFactory = options.channelFactory === undefined ? getBrowserChannelFactory() : options.channelFactory;
    this.channel = channelFactory ? channelFactory(`${this.prefix}:channel`) : null;
  }

  refresh(callbacks: TokenRefreshCallbacks<Tokens>): Promise<Tokens | null> {
    if (this.inFlight) return this.inFlight;

    const refreshToken = callbacks.getRefreshToken();
    if (!refreshToken) return Promise.resolve(null);

    this.inFlight = this.runRefresh(refreshToken, callbacks).finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  close(): void {
    this.channel?.close();
  }

  private async runRefresh(refreshToken: string, callbacks: TokenRefreshCallbacks<Tokens>): Promise<Tokens | null> {
    const requestId = this.createId();

    if (this.acquireLock(requestId)) {
      try {
        const tokens = await callbacks.performRefresh(refreshToken);
        callbacks.applyTokens(tokens);
        this.publish({ type: 'success', ownerId: this.ownerId, requestId, tokens, timestamp: this.now() });
        return tokens;
      } catch {
        const adopted = await this.waitForResult({ startedAt: this.now(), successOnly: true, timeoutMs: 250 });
        if (adopted?.type === 'success' && adopted.tokens) {
          callbacks.applyTokens(adopted.tokens as Tokens);
          return adopted.tokens as Tokens;
        }

        callbacks.clearAuth();
        this.publish({ type: 'failure', ownerId: this.ownerId, requestId, timestamp: this.now() });
        return null;
      } finally {
        this.releaseLock(requestId);
      }
    }

    const activeLock = this.readLock();
    const result = await this.waitForResult({
      requestId: activeLock?.requestId,
      startedAt: this.now(),
      timeoutMs: this.waitTimeoutMs,
    });

    if (result?.type === 'success' && result.tokens) {
      callbacks.applyTokens(result.tokens as Tokens);
      return result.tokens as Tokens;
    }

    if (result?.type === 'failure') {
      callbacks.clearAuth();
      return null;
    }

    return this.retryAfterStaleLock(refreshToken, callbacks);
  }

  private async retryAfterStaleLock(
    refreshToken: string,
    callbacks: TokenRefreshCallbacks<Tokens>
  ): Promise<Tokens | null> {
    const requestId = this.createId();
    if (!this.acquireLock(requestId, true)) return null;

    try {
      const tokens = await callbacks.performRefresh(refreshToken);
      callbacks.applyTokens(tokens);
      this.publish({ type: 'success', ownerId: this.ownerId, requestId, tokens, timestamp: this.now() });
      return tokens;
    } catch {
      callbacks.clearAuth();
      this.publish({ type: 'failure', ownerId: this.ownerId, requestId, timestamp: this.now() });
      return null;
    } finally {
      this.releaseLock(requestId);
    }
  }

  private acquireLock(requestId: string, allowLiveSteal = false): boolean {
    if (!this.storage) return true;

    const existing = this.readLock();
    if (!allowLiveSteal && existing && existing.expiresAt > this.now() && existing.ownerId !== this.ownerId) {
      return false;
    }

    const lock: RefreshLock = {
      ownerId: this.ownerId,
      requestId,
      expiresAt: this.now() + this.lockTtlMs,
    };

    try {
      this.storage.setItem(this.lockKey, JSON.stringify(lock));
      const saved = this.readLock();
      return saved?.ownerId === this.ownerId && saved.requestId === requestId;
    } catch {
      return true;
    }
  }

  private releaseLock(requestId: string): void {
    if (!this.storage) return;

    const existing = this.readLock();
    if (!existing || existing.ownerId !== this.ownerId || existing.requestId !== requestId) return;

    try {
      this.storage.removeItem(this.lockKey);
    } catch {
      // ignore storage cleanup failures
    }
  }

  private readLock(): RefreshLock | null {
    if (!this.storage) return null;

    try {
      const raw = this.storage.getItem(this.lockKey);
      if (!raw) return null;
      const lock = JSON.parse(raw) as RefreshLock;
      if (!lock.ownerId || !lock.requestId || typeof lock.expiresAt !== 'number') return null;
      return lock;
    } catch {
      return null;
    }
  }

  private publish(message: RefreshMessage): void {
    this.channel?.postMessage(message);

    if (!this.storage) return;

    try {
      this.storage.setItem(this.statusKey, JSON.stringify(message));
    } catch {
      // ignore storage publication failures
    }
  }

  private waitForResult(options: {
    requestId?: string;
    startedAt: number;
    timeoutMs: number;
    successOnly?: boolean;
  }): Promise<RefreshMessage | null> {
    return new Promise(resolve => {
      let settled = false;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      let removeStorageListener: (() => void) | null = null;
      const previousChannelHandler = this.channel?.onmessage ?? null;

      const finish = (message: RefreshMessage | null) => {
        if (settled) return;
        settled = true;
        if (pollTimer) clearInterval(pollTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        removeStorageListener?.();
        if (this.channel) this.channel.onmessage = previousChannelHandler;
        resolve(message);
      };

      const accept = (message: RefreshMessage | null): boolean => {
        if (!message) return false;
        if (message.ownerId === this.ownerId) return false;
        if (message.timestamp < options.startedAt) return false;
        if (options.requestId && message.requestId !== options.requestId) return false;
        if (options.successOnly && message.type !== 'success') return false;
        return true;
      };

      const inspect = (message: RefreshMessage | null) => {
        if (accept(message)) finish(message);
      };

      if (this.channel) {
        this.channel.onmessage = event => {
          inspect(event.data);
          previousChannelHandler?.(event);
        };
      }

      if (this.storage && this.addStorageListener) {
        removeStorageListener = this.addStorageListener(event => {
          if (event.key !== this.statusKey || !event.newValue) return;
          inspect(this.parseMessage(event.newValue));
        });
      }

      inspect(this.readLatestStatus());
      pollTimer = setInterval(() => inspect(this.readLatestStatus()), this.pollIntervalMs);
      timeoutTimer = setTimeout(() => finish(null), options.timeoutMs);
    });
  }

  private readLatestStatus(): RefreshMessage | null {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(this.statusKey);
      return raw ? this.parseMessage(raw) : null;
    } catch {
      return null;
    }
  }

  private parseMessage(raw: string): RefreshMessage | null {
    try {
      const message = JSON.parse(raw) as RefreshMessage;
      if ((message.type !== 'success' && message.type !== 'failure') || !message.ownerId || !message.requestId) {
        return null;
      }
      return message;
    } catch {
      return null;
    }
  }

  private get lockKey(): string {
    return `${this.prefix}:lock`;
  }

  private get statusKey(): string {
    return `${this.prefix}:status`;
  }
}

function getBrowserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function getBrowserStorageListener(): ((handler: (event: StorageEventLike) => void) => () => void) | undefined {
  if (typeof window === 'undefined' || !window.addEventListener) return undefined;

  return handler => {
    const listener = (event: StorageEvent) => handler({ key: event.key, newValue: event.newValue });
    window.addEventListener('storage', listener);
    return () => window.removeEventListener('storage', listener);
  };
}

function getBrowserChannelFactory(): ((name: string) => BroadcastChannelLike | null) | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  return name => {
    const channel = new BroadcastChannel(name);
    let handler: ((event: { data: RefreshMessage }) => void) | null = null;
    channel.onmessage = event => handler?.({ data: event.data as RefreshMessage });
    return {
      postMessage: message => channel.postMessage(message),
      close: () => channel.close(),
      get onmessage() {
        return handler;
      },
      set onmessage(nextHandler) {
        handler = nextHandler;
      },
    };
  };
}
