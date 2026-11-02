import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequireUser } from './auth.js';

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('chat authentication rejects requests without a bearer token', async () => {
  const middleware = createRequireUser(() => ({ verifyIdToken: async () => ({ uid: 'user-a' }) }));
  const res = response();
  await middleware({ headers: {} }, res, () => assert.fail('Unauthenticated request passed.'));
  assert.equal(res.statusCode, 401);
});

test('chat authentication rejects invalid tokens', async () => {
  const middleware = createRequireUser(() => ({ verifyIdToken: async () => { throw new Error('invalid'); } }));
  const res = response();
  await middleware({ headers: { authorization: 'Bearer invalid-token' } }, res, () => assert.fail('Invalid token passed.'));
  assert.equal(res.statusCode, 401);
});

test('chat authentication assigns the verified Firebase UID', async () => {
  let authenticatedUser;
  const middleware = createRequireUser(() => ({ verifyIdToken: async (token, checkRevoked) => {
    assert.equal(token, 'valid-token');
    assert.equal(checkRevoked, true);
    return { uid: 'user-a' };
  } }));
  await middleware({ headers: { authorization: 'Bearer valid-token' } }, response(), () => { authenticatedUser = true; });
  assert.equal(authenticatedUser, true);
});

test('chat authentication reports missing Firebase Admin configuration', async () => {
  const res = response();
  await createRequireUser(() => null)({ headers: {} }, res, () => assert.fail('Unavailable verifier passed.'));
  assert.equal(res.statusCode, 503);
});
