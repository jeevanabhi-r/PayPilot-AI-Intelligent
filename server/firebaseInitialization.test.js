import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreLoader, getOrInitializeApp } from '../src/firebaseInitialization.js';

test('Firebase app initialization reuses an existing default app', () => {
  const app = { name: '[DEFAULT]' };
  let initializeCalls = 0;
  const sdk = {
    getApps: () => [app],
    initializeApp: () => {
      initializeCalls += 1;
      return { name: 'duplicate' };
    },
  };

  assert.equal(getOrInitializeApp(sdk, {}), app);
  assert.equal(initializeCalls, 0);
});

test('Firebase initialization does not mistake a named app for the default app', () => {
  const namedApp = { name: 'admin' };
  const defaultApp = { name: '[DEFAULT]' };
  let initializeCalls = 0;
  const sdk = {
    getApps: () => [namedApp],
    initializeApp: () => {
      initializeCalls += 1;
      return defaultApp;
    },
  };

  assert.equal(getOrInitializeApp(sdk, {}), defaultApp);
  assert.equal(initializeCalls, 1);
});

test('Firebase app initialization creates an app when none exists', () => {
  const app = { name: '[DEFAULT]' };
  let initializeCalls = 0;
  const config = { projectId: 'paypilot-test' };
  const sdk = {
    getApps: () => [],
    initializeApp: (receivedConfig) => {
      initializeCalls += 1;
      assert.equal(receivedConfig, config);
      return app;
    },
  };

  assert.equal(getOrInitializeApp(sdk, config), app);
  assert.equal(initializeCalls, 1);
});

test('Firestore initialization is deferred and shared across callers', async () => {
  const app = { name: '[DEFAULT]' };
  const db = { app };
  let importCalls = 0;
  let firestoreCalls = 0;
  const getDb = createFirestoreLoader(app, async () => {
    importCalls += 1;
    return {
      getFirestore: (receivedApp) => {
        firestoreCalls += 1;
        assert.equal(receivedApp, app);
        return db;
      },
    };
  });

  assert.equal(importCalls, 0);
  const first = getDb();
  const second = getDb();
  assert.equal(first, second);
  assert.equal(await first, db);
  assert.equal(importCalls, 1);
  assert.equal(firestoreCalls, 1);
});

test('Firestore initialization can retry after a transient import failure', async () => {
  const db = { name: 'retry-db' };
  let importCalls = 0;
  const getDb = createFirestoreLoader({}, async () => {
    importCalls += 1;
    if (importCalls === 1) throw new Error('temporary import failure');
    return { getFirestore: () => db };
  });

  await assert.rejects(getDb(), /temporary import failure/);
  assert.equal(await getDb(), db);
  assert.equal(importCalls, 2);
});
