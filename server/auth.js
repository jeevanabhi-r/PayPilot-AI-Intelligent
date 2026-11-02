import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

let adminAuth;

/** Enables server-side Firebase verification only when a service account is configured. */
export function getAdminAuth() {
  if (adminAuth) return adminAuth;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) return null;
  if (!getApps().length) initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  adminAuth = getAuth();
  return adminAuth;
}

export function getAdminDb() {
  return getAdminAuth() ? getFirestore() : null;
}

export function createRequireUser(getVerifier = getAdminAuth) {
  return async function requireUser(req, res, next) {
    const verifier = getVerifier();
    if (!verifier) return res.status(503).json({ error: 'Secure server authentication is not configured.' });
    const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return res.status(401).json({ error: 'Sign in is required.' });
    try {
      req.user = await verifier.verifyIdToken(token, true);
      next();
    } catch {
      res.status(401).json({ error: 'Your session is invalid or expired. Please sign in again.' });
    }
  };
}

export const requireUser = createRequireUser();

export function requireAdmin(req, res, next) {
  if (req.user?.admin === true) return next();
  return res.status(403).json({ error: 'Administrator access is required.' });
}
