import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';

const projectId = 'demo-paypilot-security-rules';
let environment;

before(async () => {
  const rules = await readFile(new URL('../firestore.rules', import.meta.url), 'utf8');
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules },
  });
});

after(async () => {
  await environment?.cleanup();
});

function demoWishlistItem(overrides = {}) {
  return {
    productId: 'demo-phone-1',
    dataType: 'DEMO',
    title: 'Sample phone',
    name: 'Sample phone',
    brand: 'Sample brand',
    category: 'Smartphones',
    price: 199,
    currency: 'USD',
    source: 'PayPilot Curated Demo Catalogue',
    listingUrl: null,
    retailerUrl: null,
    availability: 'Sample data',
    external: false,
    createdAt: serverTimestamp(),
    ...overrides,
  };
}

function forgedLiveItem(overrides = {}) {
  return {
    productId: 'ebay:item-1',
    dataType: 'LIVE',
    title: 'Claimed live phone',
    name: 'Claimed live phone',
    category: 'Smartphones',
    price: 199,
    currency: 'USD',
    source: 'eBay Browse API',
    listingUrl: 'https://www.ebay.com/itm/item-1',
    retailerUrl: 'https://www.ebay.com/itm/item-1',
    availability: 'In stock',
    external: true,
    createdAt: serverTimestamp(),
    ...overrides,
  };
}

test('only the authenticated owner can access their user document and wishlist', async () => {
  await environment.clearFirestore();
  const owner = environment.authenticatedContext('owner').firestore();
  const otherUser = environment.authenticatedContext('other-user').firestore();
  const ownerDoc = doc(owner, 'users', 'owner');
  const ownerWishlist = doc(owner, 'users', 'owner', 'wishlist', 'demo-1');

  await assertSucceeds(setDoc(ownerDoc, { displayName: 'Owner' }));
  await assertSucceeds(getDoc(ownerDoc));
  await assertFails(getDoc(doc(otherUser, 'users', 'owner')));
  await assertSucceeds(setDoc(ownerWishlist, demoWishlistItem()));
  await assertSucceeds(getDoc(ownerWishlist));
  await assertFails(getDoc(doc(otherUser, 'users', 'owner', 'wishlist', 'demo-1')));
  await assertFails(setDoc(doc(otherUser, 'users', 'owner', 'wishlist', 'other'), demoWishlistItem()));
  await assertSucceeds(deleteDoc(ownerWishlist));
});

test('client wishlist writes reject malicious ebay.com.attacker listing hosts', async () => {
  await environment.clearFirestore();
  const db = environment.authenticatedContext('owner').firestore();
  await assertFails(setDoc(
    doc(db, 'users', 'owner', 'wishlist', 'malicious-host'),
    forgedLiveItem({ listingUrl: 'https://ebay.com.attacker/itm/item-1' }),
  ));
});

test('client wishlist writes reject sources outside the explicit allowlist', async () => {
  await environment.clearFirestore();
  const db = environment.authenticatedContext('owner').firestore();
  await assertFails(setDoc(
    doc(db, 'users', 'owner', 'wishlist', 'invalid-source'),
    demoWishlistItem({ source: 'Untrusted sample source' }),
  ));
});

test('clients cannot forge verified LIVE wishlist entries even with a trusted listing URL', async () => {
  await environment.clearFirestore();
  const db = environment.authenticatedContext('owner').firestore();
  await assertFails(setDoc(
    doc(db, 'users', 'owner', 'wishlist', 'forged-live'),
    forgedLiveItem(),
  ));
});

test('owners can create and read valid DEMO wishlist entries', async () => {
  await environment.clearFirestore();
  const db = environment.authenticatedContext('owner').firestore();
  const item = doc(db, 'users', 'owner', 'wishlist', 'demo-1');
  await assertSucceeds(setDoc(item, demoWishlistItem()));
  await assertSucceeds(getDoc(item));
});

test('nested chats, tracking, alerts, transactions, and orders retain explicit access', async () => {
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const paths = [
      'users/owner/chats/chat-1',
      'users/owner/chats/chat-1/messages/message-1',
      'users/owner/priceTracking/product-1',
      'users/owner/priceTracking/product-1/snapshots/snapshot-1',
      'users/owner/priceAlerts/alert-1',
      'users/owner/transactions/transaction-1',
      'users/owner/orders/order-1',
    ];
    await Promise.all(paths.map((path) => setDoc(doc(db, path), { value: 'seeded' })));
  });

  const owner = environment.authenticatedContext('owner').firestore();
  const otherUser = environment.authenticatedContext('other-user').firestore();
  const ownerReadable = [
    'users/owner/chats/chat-1',
    'users/owner/chats/chat-1/messages/message-1',
    'users/owner/transactions/transaction-1',
    'users/owner/orders/order-1',
  ];
  const ownerDenied = [
    'users/owner/priceTracking/product-1',
    'users/owner/priceTracking/product-1/snapshots/snapshot-1',
    'users/owner/priceAlerts/alert-1',
  ];

  for (const path of ownerReadable) {
    await assertSucceeds(getDoc(doc(owner, path)));
    await assertFails(setDoc(doc(owner, path), { value: 'client-write' }));
    await assertFails(getDoc(doc(otherUser, path)));
  }
  for (const path of ownerDenied) {
    await assertFails(getDoc(doc(owner, path)));
    await assertFails(setDoc(doc(owner, path), { value: 'client-write' }));
    await assertFails(getDoc(doc(otherUser, path)));
  }

  await assertFails(setDoc(
    doc(owner, 'users/owner/chats/chat-1/messages/new-message'),
    { value: 'client-write' },
  ));
  await assertFails(setDoc(
    doc(owner, 'users/owner/priceTracking/product-1/snapshots/new-snapshot'),
    { value: 'client-write' },
  ));
  await assertFails(setDoc(
    doc(owner, 'users/owner/priceAlerts/new-alert'),
    { value: 'client-write' },
  ));
  await assertFails(setDoc(
    doc(owner, 'users/owner/transactions/new-transaction'),
    { value: 'client-write' },
  ));
  await assertFails(setDoc(
    doc(owner, 'users/owner/orders/new-order'),
    { value: 'client-write' },
  ));

  const wishlist = collection(otherUser, 'users/owner/wishlist');
  await assertFails(getDoc(doc(wishlist, 'demo-1')));
});
