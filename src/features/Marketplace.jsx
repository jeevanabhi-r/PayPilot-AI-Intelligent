import React, { useEffect, useRef, useState } from 'react';
import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { api, money } from '../api';
import { getDb } from '../firebase';
import { filterVerifiedOffers, isOfferRelevantToQuery, offerDetail, sellerDisplayName } from '../offerUtils';
import BudgetOptimizer from './BudgetOptimizer';

function safeRetailerUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? value : null;
  } catch {
    return null;
  }
}

export default function Marketplace({ user, selected, setSelected, go, transferredOffers, onTransferredOffersDisplayed }) {
  const [queryText, setQueryText] = useState('');
  const [items, setItems] = useState([]);
  const [recommendationData, setRecommendationData] = useState(null);
  const [state, setState] = useState('idle');
  const [notice, setNotice] = useState('');
  const searchVersion = useRef(0);

  useEffect(() => {
    if (!transferredOffers) return;
    searchVersion.current += 1;
    const query = transferredOffers.query || '';
    const offers = filterVerifiedOffers(transferredOffers.offers)
      .filter((offer) => isOfferRelevantToQuery(offer, query));
    setQueryText(query);
    setItems(offers);
    setRecommendationData({
      recommendations: offers.filter((offer) => offer.recommendation?.satisfied),
      alternatives: offers.filter((offer) => !offer.recommendation?.satisfied),
      requirements: transferredOffers.requirements || null,
      allRequirementsSatisfied: offers.some((offer) => offer.recommendation?.satisfied),
    });
    setState('done');
    setNotice(offers.length ? 'Results transferred from the AI Agent.' : 'No products matched the transferred search.');
    onTransferredOffersDisplayed();
  }, [transferredOffers, onTransferredOffersDisplayed]);

  async function search(event) {
    event.preventDefault();
    const version = ++searchVersion.current;
    setState('loading');
    setItems([]);
    setNotice('');
    try {
      const data = await api(`/api/products/search?q=${encodeURIComponent(queryText)}`);
      if (version !== searchVersion.current) return;
      const products = filterVerifiedOffers(data.products)
        .filter((product) => isOfferRelevantToQuery(product, queryText));
      setItems(products);
      setRecommendationData(data.recommendations || null);
      setNotice([
        data.message || data.purchaseNotice || 'Products from the unified product catalogue.',
        data.priceTracking?.warning,
      ].filter(Boolean).join(' '));
      setState('done');
    } catch (error) {
      if (version !== searchVersion.current) return;
      setNotice(error.message);
      setState('error');
    }
  }

  function updateQuery(value) {
    searchVersion.current += 1;
    setQueryText(value);
    setItems([]);
    setRecommendationData(null);
    setNotice('');
    setState('idle');
  }

  function toggle(product) {
    setSelected((current) => current.some((item) => item.id === product.id)
      ? current.filter((item) => item.id !== product.id)
      : current.length < 3 ? [...current, product] : current);
  }

  async function wish(product) {
    try {
      if (product.dataType === 'LIVE') {
        await api('/api/wishlist/live', {
          method: 'POST',
          body: JSON.stringify({
            productId: product.productId || product.id,
            query: product.title || product.name,
          }),
        });
      } else {
        const db = await getDb();
        await addDoc(collection(db, 'users', user.uid, 'wishlist'), {
          productId: product.productId || product.id,
          dataType: 'DEMO',
          title: product.title || product.name,
          name: product.name || product.title,
          brand: product.brand || null,
          category: product.category,
          price: product.price,
          currency: product.currency,
          image: product.image || null,
          source: 'PayPilot Curated Demo Catalogue',
          listingUrl: null,
          retailerUrl: null,
          availability: 'Sample data',
          external: false,
          merchant: null,
          condition: null,
          createdAt: serverTimestamp(),
        });
      }
      setNotice('Saved to wishlist. Price history is recorded only after a provider refresh.');
    } catch (error) {
      setNotice(`Could not save product: ${error.message}`);
    }
  }

  return <section>
    <p className="eyebrow">PRODUCT DISCOVERY</p>
    <h1>Find products</h1>
    <BudgetOptimizer selected={selected} setSelected={setSelected} go={go} />
    <form className="search" onSubmit={search}>
      <input
        required
        minLength="2"
        value={queryText}
        onChange={(event) => updateQuery(event.target.value)}
        placeholder="Search phones, laptops, headphones…"
      />
      <button disabled={state === 'loading'}>{state === 'loading' ? 'Searching…' : 'Search products'}</button>
    </form>
    {notice && <p className="notice">{notice}</p>}
    {state === 'idle' && <div className="empty">Search combines live eBay offers with clearly labeled sample products from the demo catalogue.</div>}
    {state === 'done' && items.length === 0 && <div className="empty">No products matched this search. Try another query.</div>}
    {recommendationData && (() => {
      const recommendations = recommendationData.recommendations || [];
      const alternatives = recommendationData.alternatives || [];
      const displayed = recommendations.length ? recommendations : alternatives;
      return <section className="recommendation-results" aria-label="AI recommendations">
        <p className="eyebrow">EXPLAINABLE PRODUCT MATCH</p>
        <h2>{recommendations.length ? 'Top matches for your requirements' : 'Closest alternatives'}</h2>
        {!recommendations.length && displayed.length > 0 && <p>No product matched every stated requirement. Review the reasons each alternative may not fit.</p>}
        {recommendationData.requirements && <p className="requirement-summary">
          Requirements considered: {[
            recommendationData.requirements.category,
            recommendationData.requirements.budget !== null && recommendationData.requirements.budget !== undefined
              ? `Budget ${recommendationData.requirements.budget} ${recommendationData.requirements.currency || 'currency per listing'}`
              : null,
            recommendationData.requirements.preferredBrand,
            ...(recommendationData.requirements.intendedUse || []),
            ...Object.entries(recommendationData.requirements.requiredSpecifications || {}).map(([key, value]) => `${key} ${value}`),
            ...(recommendationData.requirements.mustHaveFeatures || []),
            ...(recommendationData.requirements.optionalFeatures || []).map((feature) => `optional ${feature}`),
          ].filter(Boolean).join(' · ') || 'No structured requirements identified'}
        </p>}
        {displayed.length > 0
          ? <div className="grid">{displayed.map((product) => {
            const rec = product.recommendation;
            const live = product.dataType === 'LIVE';
            const listing = live ? safeRetailerUrl(product.listingUrl || product.retailerUrl) : null;
            return <article className="recommendation" key={`recommendation-${product.productId || product.id}`}>
              <small>{live ? 'LIVE · eBay' : 'DEMO · SAMPLE DATA'} · {rec?.score ?? 0}/100</small>
              <h3>{product.title || product.name}</h3>
              <strong>{live ? money(product.price, product.currency) : `Sample price: ${money(product.price, product.currency)}`} ({product.currency})</strong>
              <p>{rec?.explanation || 'No matching product facts were confirmed.'}</p>
              {!!rec?.concerns?.length && <ul className="recommendation-concerns">{rec.concerns.map((concern) => <li key={concern}>{concern}</li>)}</ul>}
              {!!rec?.criteria?.length && <details><summary>Scoring breakdown</summary>{rec.criteria.map((criterion) => <p key={criterion.key}>{criterion.label}: {Math.round(criterion.score)}% match (weight {criterion.weight})</p>)}</details>}
              {listing && <a href={listing} target="_blank" rel="noreferrer">Open verified eBay listing ↗</a>}
            </article>;
          })}</div>
          : <p>No products were available to rank.</p>}
      </section>;
    })()}
    <div className="grid">
      {items.map((item) => {
        const live = item.dataType === 'LIVE';
        const retailerUrl = live ? safeRetailerUrl(item.listingUrl || item.retailerUrl) : null;
        return <article className="product" key={item.productId || item.id}>
          {item.image
            ? <img src={item.image} alt=""/>
            : <div className="product-image-empty" aria-label="Product image unavailable">Image unavailable</div>}
          <small>{live ? 'LIVE · eBay' : 'DEMO · SAMPLE DATA'}</small>
          <h3>{item.title || item.name}</h3>
          <p>{item.brand || 'Brand not provided'} · {item.category}</p>
          <strong>{live ? money(item.price, item.currency) : `Sample price: ${money(item.price, item.currency)}`} ({item.currency})</strong>
          <p>{live ? `Seller: ${sellerDisplayName(item.merchant)}` : 'Curated sample product; no seller or listing.'}</p>
          <p>{live ? offerDetail(item.availability) : 'Sample data; availability is not live.'}</p>
          {retailerUrl && <a href={retailerUrl} target="_blank" rel="noreferrer">Open verified eBay listing ↗</a>}
          <div>
            <button
              className="secondary"
              onClick={() => toggle(item)}
              disabled={selected.length >= 3 && !selected.some((product) => product.id === item.id)}
            >{selected.some((product) => product.id === item.id) ? 'Remove from compare' : 'Add to compare'}</button>
            <button className="secondary" onClick={() => wish(item)}>Save</button>
          </div>
        </article>;
      })}
    </div>
    {selected.length > 0 && <button className="floating" onClick={() => go('compare')}>Compare selection ({selected.length}/3) →</button>}
  </section>;
}
