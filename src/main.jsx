import React, { Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from './firebase';
import App from './App';
import './style.css';

const Auth = lazy(() => import('./ui/Auth'));

function Root() {
  const [user, setUser] = useState();

  useEffect(() => onAuthStateChanged(auth, setUser), []);

  if (user === undefined) return <main className="boot">Loading PayPilot AI…</main>;
  if (user) return <App user={user} />;

  return (
    <Suspense fallback={<main className="boot">Loading PayPilot AI…</main>}>
      <Auth />
    </Suspense>
  );
}

createRoot(document.getElementById('root')).render(<Root />);
