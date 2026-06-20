import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(root, '.tmp-auth-refresh-test');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

execFileSync(
  resolve(root, 'node_modules/.bin/tsc'),
  [
    'src/services/authRefreshCoordinator.ts',
    '--target',
    'ES2022',
    '--module',
    'ES2022',
    '--moduleResolution',
    'node',
    '--outDir',
    outDir,
    '--skipLibCheck',
    'true',
    '--strict',
    'true',
  ],
  { cwd: root, stdio: 'inherit' }
);

const { TokenRefreshCoordinator } = await import(
  pathToFileURL(resolve(outDir, 'authRefreshCoordinator.js')).href
);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function tokens(name) {
  return {
    accessToken: `access-${name}`,
    refreshToken: `refresh-${name}`,
    expiresIn: 3600,
    tokenType: 'Bearer',
  };
}

class SharedStorage {
  data = new Map();
  contexts = new Set();

  createContext() {
    const listeners = new Set();
    const context = { listeners };
    this.contexts.add(context);

    return {
      storage: {
        getItem: key => (this.data.has(key) ? this.data.get(key) : null),
        setItem: (key, value) => {
          const oldValue = this.data.has(key) ? this.data.get(key) : null;
          this.data.set(key, String(value));
          this.emit(context, key, oldValue, String(value));
        },
        removeItem: key => {
          const oldValue = this.data.has(key) ? this.data.get(key) : null;
          this.data.delete(key);
          this.emit(context, key, oldValue, null);
        },
      },
      addStorageListener: listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  emit(source, key, oldValue, newValue) {
    for (const context of this.contexts) {
      if (context === source) continue;
      for (const listener of context.listeners) {
        listener({ key, oldValue, newValue });
      }
    }
  }
}

async function testSameTabRefreshesShareOneNetworkRequest() {
  const shared = new SharedStorage();
  const tab = shared.createContext();
  const coordinator = new TokenRefreshCoordinator({
    ...tab,
    channelFactory: null,
    storageKeyPrefix: 'same-tab',
    pollIntervalMs: 5,
    waitTimeoutMs: 250,
  });

  let networkCalls = 0;
  let applyCalls = 0;
  const next = tokens('next');

  const callbacks = {
    getRefreshToken: () => 'refresh-old',
    performRefresh: async () => {
      networkCalls += 1;
      await delay(25);
      return next;
    },
    applyTokens: received => {
      applyCalls += 1;
      assert.deepEqual(received, next);
    },
    clearAuth: () => assert.fail('same-tab success must not clear auth'),
  };

  const [first, second] = await Promise.all([
    coordinator.refresh(callbacks),
    coordinator.refresh(callbacks),
  ]);

  assert.deepEqual(first, next);
  assert.deepEqual(second, next);
  assert.equal(networkCalls, 1);
  assert.equal(applyCalls, 1);
  coordinator.close();
}

async function testCrossTabRefreshUsesStorageFallback() {
  const shared = new SharedStorage();
  const tabA = shared.createContext();
  const tabB = shared.createContext();
  const coordinatorA = new TokenRefreshCoordinator({
    ...tabA,
    channelFactory: null,
    storageKeyPrefix: 'cross-tab',
    pollIntervalMs: 5,
    waitTimeoutMs: 500,
  });
  const coordinatorB = new TokenRefreshCoordinator({
    ...tabB,
    channelFactory: null,
    storageKeyPrefix: 'cross-tab',
    pollIntervalMs: 5,
    waitTimeoutMs: 500,
  });

  let networkCalls = 0;
  let appliedInOtherTab = 0;
  let clearedInOtherTab = 0;
  const next = tokens('broadcast');

  const first = coordinatorA.refresh({
    getRefreshToken: () => 'refresh-old',
    performRefresh: async () => {
      networkCalls += 1;
      await delay(30);
      return next;
    },
    applyTokens: received => assert.deepEqual(received, next),
    clearAuth: () => assert.fail('successful owner refresh must not clear auth'),
  });

  await delay(1);

  const second = coordinatorB.refresh({
    getRefreshToken: () => 'refresh-old',
    performRefresh: async () => {
      networkCalls += 1;
      return tokens('unexpected');
    },
    applyTokens: received => {
      appliedInOtherTab += 1;
      assert.deepEqual(received, next);
    },
    clearAuth: () => {
      clearedInOtherTab += 1;
    },
  });

  assert.deepEqual(await first, next);
  assert.deepEqual(await second, next);
  assert.equal(networkCalls, 1);
  assert.equal(appliedInOtherTab, 1);
  assert.equal(clearedInOtherTab, 0);
  coordinatorA.close();
  coordinatorB.close();
}

async function testFailedRefreshClearsWhenNoTabSucceeds() {
  const shared = new SharedStorage();
  const tab = shared.createContext();
  const coordinator = new TokenRefreshCoordinator({
    ...tab,
    channelFactory: null,
    storageKeyPrefix: 'failure',
    pollIntervalMs: 5,
    waitTimeoutMs: 250,
  });

  let clearCalls = 0;
  const result = await coordinator.refresh({
    getRefreshToken: () => 'refresh-old',
    performRefresh: async () => {
      throw new Error('network failure');
    },
    applyTokens: () => assert.fail('failed refresh must not apply tokens'),
    clearAuth: () => {
      clearCalls += 1;
    },
  });

  assert.equal(result, null);
  assert.equal(clearCalls, 1);
  coordinator.close();
}

await testSameTabRefreshesShareOneNetworkRequest();
await testCrossTabRefreshUsesStorageFallback();
await testFailedRefreshClearsWhenNoTabSucceeds();

rmSync(outDir, { recursive: true, force: true });
console.log('auth refresh coordination tests passed');
