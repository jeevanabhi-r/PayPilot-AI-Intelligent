import { catalog } from './logic.js';

function normalize(id, input) {
  return { id, name: input.name, description: input.description || '', category: input.category || 'General', price: Number(input.price), currency: input.currency || 'USD', stock: Number(input.stock), available: input.available === true, imageUrl: input.imageUrl || null, source: 'paypilot-marketplace' };
}

export async function listMarketplaceProducts(db) {
  if (!db) return catalog.map((product) => ({ ...product, currency: 'USD', stock: null, available: true, source: 'paypilot-catalog' }));
  const snapshot = await db.collection('marketplaceProducts').where('available', '==', true).get();
  const managed = snapshot.docs.map((document) => normalize(document.id, document.data())).filter((product) => product.stock > 0 && Number.isFinite(product.price));
  return [...catalog.map((product) => ({ ...product, currency: 'USD', stock: null, available: true, source: 'paypilot-catalog' })), ...managed];
}

export async function getMarketplaceProduct(db, id) {
  if (db) { const snapshot = await db.collection('marketplaceProducts').doc(id).get(); if (snapshot.exists) return normalize(snapshot.id, snapshot.data()); }
  const product = catalog.find((item) => item.id === id); return product ? { ...product, currency: 'USD', stock: null, available: true, source: 'paypilot-catalog' } : null;
}
