import crypto from 'node:crypto';

export const MAX_RECONCILIATION_ATTEMPTS = 8;

export function classifyPayPalOrder(order) {
  const capture = order?.purchase_units?.[0]?.payments?.captures?.[0];
  if (order?.status === 'COMPLETED' && capture?.status === 'COMPLETED') return { state: 'captured', capture };
  if (['VOIDED', 'DECLINED', 'FAILED'].includes(order?.status) || ['DECLINED', 'FAILED'].includes(capture?.status)) return { state: 'failed', capture };
  return { state: 'uncertain', capture };
}

export function retryAt(attempt, now = Date.now()) {
  // 1, 2, 4, 8, 16, 32, 60 minute capped exponential backoff.
  return new Date(now + Math.min(60, 2 ** Math.max(0, attempt - 1)) * 60_000).toISOString();
}

/** Pure orchestration; storage side effects are injected for unit testing. */
export async function reconcileOrder({ order, readPayPalOrder, finalizeSuccess, releaseFailure, scheduleRetry, log = () => {}, now = Date.now() }) {
  const attempt = Number(order.retryCount || 0) + 1;
  let paypal;
  try { paypal = await readPayPalOrder(order.paypalOrderId); } catch (error) {
    const outcome = attempt >= MAX_RECONCILIATION_ATTEMPTS ? 'escalated' : 'retry';
    if (outcome === 'escalated') await scheduleRetry({ attempt, status: 'RECONCILIATION_ESCALATED', reason: `PayPal lookup error: ${error.message}`, nextAttemptAt: null });
    else await scheduleRetry({ attempt, status: 'RECONCILIATION_REQUIRED', reason: `PayPal lookup error: ${error.message}`, nextAttemptAt: retryAt(attempt, now) });
    log({ level: 'warn', event: 'paypal_lookup_failed', orderId: order.paypalOrderId, attempt, outcome }); return outcome;
  }
  const result = classifyPayPalOrder(paypal);
  if (result.state === 'captured') { await finalizeSuccess({ capture: result.capture, paypalOrder: paypal, attempt }); log({ level: 'info', event: 'reconciliation_completed', orderId: order.paypalOrderId, attempt }); return 'completed'; }
  if (result.state === 'failed') { await releaseFailure({ capture: result.capture, paypalOrder: paypal, attempt }); log({ level: 'info', event: 'reconciliation_failed', orderId: order.paypalOrderId, attempt }); return 'failed'; }
  const outcome = attempt >= MAX_RECONCILIATION_ATTEMPTS ? 'escalated' : 'retry';
  await scheduleRetry({ attempt, status: outcome === 'escalated' ? 'RECONCILIATION_ESCALATED' : 'RECONCILIATION_REQUIRED', reason: `PayPal status remains ${paypal?.status || 'unknown'}`, nextAttemptAt: outcome === 'escalated' ? null : retryAt(attempt, now) });
  log({ level: 'warn', event: 'reconciliation_uncertain', orderId: order.paypalOrderId, attempt, outcome, paypalStatus: paypal?.status || null }); return outcome;
}

async function paypalAccessToken() {
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const response = await fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  if (!response.ok) throw new Error(`PayPal authentication failed (${response.status})`); return (await response.json()).access_token;
}

async function readPayPalOrder(orderId) {
  const token = await paypalAccessToken(); const response = await fetch(`https://api-m.sandbox.paypal.com/v2/checkout/orders/${encodeURIComponent(orderId)}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.message || `PayPal lookup failed (${response.status})`); return data;
}

export async function runReconciliationWorker(db, { limit = 25, logger = console, staleClaimMs = Number(process.env.CAPTURE_CLAIM_TIMEOUT_MS || 10 * 60_000) } = {}) {
  const now = new Date(); const [required, processing] = await Promise.all([db.collectionGroup('orders').where('status', '==', 'RECONCILIATION_REQUIRED').limit(limit).get(), db.collectionGroup('orders').where('status', '==', 'CAPTURE_PROCESSING').limit(limit).get()]);
  const stale = processing.docs.filter((document) => Date.parse(document.data().captureClaimedAt || 0) + staleClaimMs <= now.getTime());
  for (const document of stale) await db.runTransaction(async (store) => { const current = await store.get(document.ref); if (current.exists && current.data().status === 'CAPTURE_PROCESSING' && Date.parse(current.data().captureClaimedAt || 0) + staleClaimMs <= now.getTime()) store.update(document.ref, { status: 'RECONCILIATION_REQUIRED', reconciliationReason: 'Stale capture claim recovered', nextAttemptAt: now.toISOString(), updatedAt: now.toISOString() }); });
  const eligible = [...required.docs, ...stale].filter((document) => !document.data().nextAttemptAt || new Date(document.data().nextAttemptAt) <= now);
  const outcomes = [];
  for (const document of eligible) {
    const claimed = await db.runTransaction(async (store) => { const current = await store.get(document.ref); if (!current.exists || current.data().status !== 'RECONCILIATION_REQUIRED' || (current.data().reconciliationClaimedAt && Date.parse(current.data().reconciliationClaimedAt) + staleClaimMs > now.getTime())) return null; const claimId = crypto.randomUUID(); store.update(document.ref, { reconciliationClaimId: claimId, reconciliationClaimedAt: now.toISOString() }); return { ...current.data(), reconciliationClaimId: claimId }; }); if (!claimed) continue; const order = claimed; const userRef = document.ref.parent.parent;
    const audit = (event, details = {}) => db.collection('users').doc(userRef.id).collection('paymentEvents').doc().set({ event, orderId: order.paypalOrderId, createdAt: new Date().toISOString(), ...details });
    const result = await reconcileOrder({ order, readPayPalOrder, log: (record) => logger.info(JSON.stringify(record)), finalizeSuccess: async ({ capture, attempt }) => db.runTransaction(async (store) => { const transactionRef = userRef.collection('transactions').doc(order.paypalOrderId); const current = await store.get(document.ref); if (!current.exists || !['RECONCILIATION_REQUIRED', 'CAPTURE_PROCESSING'].includes(current.data().status)) return; if (current.data().reservationReleased) { store.update(document.ref, { status: 'PAYMENT_INVENTORY_CONFLICT', reconciledAt: new Date().toISOString(), retryCount: attempt, paypalCaptureId: capture.id || null }); return; } if (!(await store.get(transactionRef)).exists) store.set(transactionRef, { id: capture.id || crypto.randomUUID(), orderId: order.paypalOrderId, productId: order.productId, productName: order.productName, amount: order.amount, currency: order.currency, status: 'COMPLETED', paypalCaptureId: capture.id || null, createdAt: new Date().toISOString(), reconciled: true }); store.update(document.ref, { status: 'COMPLETED', reconciledAt: new Date().toISOString(), retryCount: attempt, paypalCaptureId: capture.id || null }); }), releaseFailure: async ({ attempt, paypalOrder }) => db.runTransaction(async (store) => { const current = await store.get(document.ref); if (!current.exists || current.data().reservationReleased) return; if (current.data().productSource === 'paypilot-marketplace') { const productRef = db.collection('marketplaceProducts').doc(current.data().productId); const product = await store.get(productRef); if (product.exists) store.update(productRef, { stock: product.data().stock + 1, updatedAt: new Date().toISOString() }); } store.update(document.ref, { status: 'FAILED', reservationReleased: true, failedAt: new Date().toISOString(), retryCount: attempt, paypalStatus: paypalOrder.status }); }), scheduleRetry: async (update) => document.ref.update({ ...update, retryCount: update.attempt, updatedAt: new Date().toISOString() }) });
    await audit('reconciliation_result', { outcome: result, retryCount: Number(order.retryCount || 0) + 1 }); outcomes.push({ orderId: order.paypalOrderId, outcome: result });
  }
  return outcomes;
}
