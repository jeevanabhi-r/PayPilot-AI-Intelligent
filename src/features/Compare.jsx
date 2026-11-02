import React, { useState } from 'react';
import { api, money } from '../api';

function badges(product, specificationBasis) {
  const labels = [];
  if (product.isBestOverall) labels.push('Best overall match');
  if (product.isBestBudget) labels.push('Best budget option');
  if (product.isBestSpecification) {
    labels.push(specificationBasis === 'requiredSpecifications' ? 'Best specification match' : 'Most listed specifications');
  }
  return labels;
}

export default function Compare({ selected, setSelected }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function compare() {
    setError('');
    setLoading(true);
    try {
      setResult(await api('/api/compare', {
        method: 'POST',
        body: JSON.stringify({ products: selected, query }),
      }));
    } catch (compareError) {
      setResult(null);
      setError(compareError.message);
    } finally {
      setLoading(false);
    }
  }

  function remove(productId) {
    setSelected((current) => current.filter((product) => (product.productId || product.id) !== productId));
    setResult(null);
  }

  const products = result?.products || [];
  const specifications = result?.specifications || [];

  return <section>
    <p className="eyebrow">DECISION LAB</p>
    <h1>Compare products</h1>
    <p>Compare the details provided for each product. Unlisted specifications remain unavailable; prices in different currencies are not converted.</p>
    <div className="comparison-controls">
      <label htmlFor="comparison-requirements">What matters most? (optional)</label>
      <input
        id="comparison-requirements"
        value={query}
        maxLength={1200}
        onChange={(event) => { setQuery(event.target.value); setResult(null); }}
        placeholder="e.g. laptop under $1,000 with 16GB RAM for coding"
      />
      <button disabled={selected.length < 2 || loading} onClick={compare}>
        {loading ? 'Comparing…' : `Compare ${selected.length} selected`}
      </button>
      <p>{selected.length}/3 selected. Choose products in Discover or the AI Agent.</p>
    </div>
    {error && <p className="notice">{error}</p>}
    {selected.length < 2 && <div className="empty">Select at least two products in Discover or the AI Agent to compare.</div>}
    {selected.length >= 2 && !result && <div className="comparison-selected">
      {selected.map((product) => {
        const productId = product.productId || product.id;
        const demo = product.dataType === 'DEMO';
        return <article key={productId}>
          <small>{demo ? 'DEMO · SAMPLE DATA' : 'LIVE · eBay'}</small>
          <strong>{product.title || product.name}</strong>
          <span>{demo ? 'Sample price: ' : ''}{money(product.price, product.currency)}</span>
          <button className="secondary" onClick={() => remove(productId)}>Remove</button>
        </article>;
      })}
    </div>}
    {result && <>
      <p className="comparison-summary">{result.explanation || 'No comparable evidence was available.'}</p>
      {result.winners?.budgetNote && <p className="notice">{result.winners.budgetNote}</p>}
      {result.winners?.noProductsWithinBudget && <p className="notice">No selected product meets the requested budget and currency; the lowest-price option is shown only for comparison.</p>}
      <div className="comparison-table-scroll">
        <table className="comparison-table">
          <thead>
            <tr>
              <th scope="col">Product details</th>
              {products.map((product) => <th scope="col" key={product.productId}>
                <small className={product.dataType === 'DEMO' ? 'demo-label' : 'live-label'}>
                  {product.dataType === 'DEMO' ? 'DEMO · SAMPLE DATA' : 'LIVE · eBay'}
                </small>
                <strong>{product.title}</strong>
                {badges(product, result.winners?.specificationBasis).map((label) => <span className="winner-badge" key={label}>{label}</span>)}
                <button className="secondary" onClick={() => remove(product.productId)}>Remove</button>
              </th>)}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Price</th>
              {products.map((product) => <td key={product.productId}>
                {product.dataType === 'DEMO' ? 'Sample price: ' : ''}{money(product.price, product.currency)}
              </td>)}
            </tr>
            <tr><th scope="row">Currency</th>{products.map((product) => <td key={product.productId}>{product.currency}</td>)}</tr>
            <tr><th scope="row">Brand</th>{products.map((product) => <td key={product.productId}>{product.brand || 'Not available'}</td>)}</tr>
            <tr><th scope="row">Category</th>{products.map((product) => <td key={product.productId}>{product.category || 'Not available'}</td>)}</tr>
            <tr><th scope="row">Product source</th>{products.map((product) => <td key={product.productId}>
              {product.dataType === 'DEMO' ? 'DEMO · Sample catalogue' : `LIVE · ${product.source || 'eBay'}`}
            </td>)}</tr>
            <tr><th scope="row">Requirement match</th>{products.map((product) => <td key={product.productId}>
              {product.recommendation ? `${product.recommendation.score}/100` : 'No requirements supplied'}
              {product.recommendation?.satisfied === false && <p className="bad">Some requirements are not met or confirmed.</p>}
            </td>)}</tr>
            {specifications.map((specification) => <tr key={specification.name}>
              <th scope="row">{specification.name}</th>
              {specification.values.map((entry) => <td key={entry.productId}>
                {entry.available ? entry.value : 'Not available'}
              </td>)}
            </tr>)}
            <tr><th scope="row">LIVE/DEMO</th>{products.map((product) => <td key={product.productId}>
              {product.dataType}
              {product.dataType === 'DEMO' && <p>Sample data; no seller or retailer listing.</p>}
            </td>)}</tr>
          </tbody>
        </table>
      </div>
      <h2>Price differences</h2>
      {result.priceDifferences?.length
        ? <ul>{result.priceDifferences.map((pair) => {
          const left = products.find((product) => product.productId === pair.leftProductId);
          const right = products.find((product) => product.productId === pair.rightProductId);
          return <li key={`${pair.leftProductId}-${pair.rightProductId}`}>
            {pair.difference === null
              ? `${left.title} vs ${right.title}: Not comparable (different currencies).`
              : `${left.title} vs ${right.title}: ${money(Math.abs(pair.difference), pair.currency)} ${pair.difference < 0 ? 'lower for the first product' : pair.difference > 0 ? 'higher for the first product' : 'same listed price'}.`}
          </li>;
        })}</ul>
        : <p>No price comparison is available.</p>}
      {!!result.evidenceStatements?.length && <>
        <h2>Evidence-based trade-offs</h2>
        <ul>{result.evidenceStatements.map((statement) => <li key={statement}>{statement}</li>)}</ul>
        <small>Summary source: {result.explanationSource === 'groq' ? 'Groq-selected verified evidence' : 'Deterministic product data'}</small>
      </>}
      <p className="comparison-disclaimer">{result.disclaimer}</p>
    </>}
  </section>;
}
