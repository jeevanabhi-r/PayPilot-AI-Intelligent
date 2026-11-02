import 'dotenv/config';
import { getAdminDb } from './auth.js';
import { runReconciliationWorker } from './reconciliation.js';
const db = getAdminDb();
if (!db || !process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) throw new Error('Firebase Admin and PayPal Sandbox credentials are required for reconciliation.');
const results = await runReconciliationWorker(db); console.log(JSON.stringify({ event: 'reconciliation_run_finished', processed: results.length, results }));
