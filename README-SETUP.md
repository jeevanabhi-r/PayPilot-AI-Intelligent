# PayPilot AI — Complete Source Upgrade

This package includes the frontend, Express backend, Firebase setup, Firestore rules, and environment template.
It does not include your private `.env`, API keys, `node_modules`, or `package-lock.json`.

## Included features
- Firebase Email/Password authentication
- Firebase Google popup sign-in
- User-scoped Firestore profile and persistent AI chat history, with conversation turns sent through authenticated `POST /api/chat`
- Premium responsive dark UI
- Marketplace search, category filtering, and sorting
- AI product planning via `POST /api/plan`, with a 25-second client timeout and visible errors
- Groq-powered conversational shopping research with verified eBay offer data and a safe fallback when Groq is unavailable
- PayPal Sandbox checkout and capture verification in the Express backend
- Transactions view and saved shopping preferences

## 1. Install
Open PowerShell in this project folder and run:

    npm install
    npm run dev

Vite runs on http://localhost:5173 and the Express API on http://localhost:3001.

## 2. Configure Firebase
1. Open https://console.firebase.google.com/ and create/select your Firebase project.
2. In Build > Authentication > Sign-in providers, enable **Email/Password** and **Google**.
3. In Authentication > Settings > Authorized domains, make sure `localhost` is listed.
4. Create a Cloud Firestore database.
5. Register a Web app in Project settings > General > Your apps.
6. Copy `.env.example` to `.env` (or merge the Firebase values into your existing `.env`).
7. Fill in the six `VITE_FIREBASE_*` values using the Firebase web app config.
8. Run `npm test` to validate the backend and Firestore rules against the local emulator. This requires Java 11 or newer; Java 21 is recommended.
9. Review `firestore.rules`, then publish it manually in Firestore > Rules when you are ready. Tests do not deploy rules.
10. Restart Vite after editing `.env` (Ctrl+C, then `npm run dev`).

**Do not replace or erase your existing PayPal/Groq values.** Keep the `PAYPAL_CLIENT_SECRET` and `GROQ_API_KEY` server-only; never add them to a `VITE_` variable or commit `.env`.

## 3. Configure PayPal Sandbox and Groq
In your local `.env`, retain or fill:
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `GROQ_API_KEY`
- `GROQ_MODEL` (optional; defaults to `llama-3.3-70b-versatile`)
- `PORT=3001`
- `APP_ORIGIN=http://localhost:5173`

If PayPal credentials are empty, the backend intentionally uses demo mode instead of real payment processing. Test only with PayPal Sandbox credentials.

## 4. Test
- Sign up with email/password.
- Sign out and use Continue with Google.
- Send: `Find wireless headphones under $50`.
- Confirm the recommendation appears and the loading indicator stops.
- Open Recent Conversations and reopen the chat.
- Open Marketplace and test search/sort.
- Test checkout only with Sandbox credentials and explicit approval.

## Notes and production hardening

## Reconciliation worker

After configuring Firebase Admin and PayPal **Sandbox** server variables, run `npm run reconcile` from a trusted scheduler (for example, a private Render Cron Job every five minutes). It reads existing PayPal orders only; it never captures a payment. Do not expose this command through a public HTTP endpoint.
- The `/api/plan` request accepts up to 2500 characters so personalization context does not immediately fail the previous 500-character validation.
- The browser writes transaction display records to the user's Firestore after the backend confirms capture. For a production launch, move that write to a trusted server using Firebase Admin SDK and verify Firebase ID tokens on protected backend endpoints.
- Firestore client rules secure user-scoped records, but API routes are not Firebase-authenticated in this starter project. Add ID-token verification before exposing the backend publicly.
- Firebase web config values are intended for browser use; access control is enforced with Firebase Auth and Firestore rules. Never publish private server secrets.
