import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { signOut } from 'firebase/auth';
import { auth } from './firebase';
import { api } from './api';

const Dashboard = lazy(() => import('./features/Dashboard'));
const Marketplace = lazy(() => import('./features/Marketplace'));
const Compare = lazy(() => import('./features/Compare'));
const Wishlist = lazy(() => import('./features/Wishlist'));
const Checkout = lazy(() => import('./features/Checkout'));
const Analytics = lazy(() => import('./features/Analytics'));
const Transactions = lazy(() => import('./features/Transactions'));
const Profile = lazy(() => import('./features/Profile'));
const Admin = lazy(() => import('./features/Admin'));

const pages = {
  dashboard: Dashboard,
  marketplace: Marketplace,
  compare: Compare,
  wishlist: Wishlist,
  checkout: Checkout,
  analytics: Analytics,
  transactions: Transactions,
  profile: Profile,
  admin: Admin,
};

const navigationItems = {
  dashboard: 'AI Agent',
  marketplace: 'Discover',
  compare: 'Compare',
  wishlist: 'Wishlist',
  checkout: 'Checkout',
  analytics: 'Analytics',
  transactions: 'Orders',
  profile: 'Profile',
  admin: 'Admin',
};

export default function App({ user }) {
  const [page, setPage] = useState('dashboard');
  const [theme, setTheme] = useState(localStorage.getItem('paypilot-theme') || 'dark');
  const [config, setConfig] = useState(null);
  const [selected, setSelected] = useState([]);
  const [marketplaceOffers, setMarketplaceOffers] = useState(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('paypilot-theme', theme);
    api('/api/config').then(setConfig).catch(() => {});
  }, [theme]);

  const Page = pages[page];
  const openOffers = (offers, query) => {
    setMarketplaceOffers({
      offers: Array.isArray(offers) ? offers : [],
      query: typeof query === 'string' ? query : '',
    });
    setPage('marketplace');
  };
  const clearMarketplaceOffers = useCallback(() => setMarketplaceOffers(null), []);

  return (
    <div className="app">
      <aside>
        <div className="brand">✦ PayPilot <b>AI</b></div>
        <small>INTELLIGENT COMMERCE</small>
        <nav className="app-navigation" aria-label="Main navigation">
          {Object.entries(navigationItems).map(([id, label]) => (
            <button
              key={id}
              className={page === id ? 'active' : ''}
              aria-current={page === id ? 'page' : undefined}
              onClick={() => setPage(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="nav-actions">
          <button
            className="secondary"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </button>
          <button className="secondary" onClick={() => signOut(auth)}>
            Sign out
          </button>
        </div>
      </aside>
      <main>
        <header>
          <span>Workspace / <b>{page}</b></span>
          <span className="pill">
            {config?.mode === 'sandbox' ? 'PayPal Sandbox' : 'Checkout unavailable'}
          </span>
        </header>
        <Suspense fallback={<div className="loading">Loading experience…</div>}>
          <Page
            user={user}
            config={config}
            selected={selected}
            setSelected={setSelected}
            go={setPage}
            openOffers={openOffers}
            transferredOffers={marketplaceOffers}
            onTransferredOffersDisplayed={clearMarketplaceOffers}
          />
        </Suspense>
      </main>
    </div>
  );
}
