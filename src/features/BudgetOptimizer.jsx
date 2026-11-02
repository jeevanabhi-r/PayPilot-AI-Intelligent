import React, { useState } from 'react';
import { api, money } from '../api';

const categories = ['Smartphones', 'Laptops', 'Headphones', 'Smartwatches', 'Tablets'];
const currencies = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY'];

function Combination({ combination, selected, setSelected, go, label }) {
  if (!combination) return null;
  return <article className="budget-combination">
    <div className="budget-combination-heading">
      <h3>{label}</h3>
      <strong>Match score: {combination.score}/100</strong>
    </div>
    <p>
      Total: {money(combination.totalCost, combination.products[0]?.currency)}
      {' · '}Remaining: {money(combination.remainingBudget, combination.products[0]?.currency)}
      {' · '}Categories covered: {combination.metrics.categoryCoverage}%
    </p>
    <ul className="budget-product-list">
      {combination.products.map((product) => {
        const productId = product.productId || product.id;
        const isSelected = selected.some((item) => (item.productId || item.id) === productId);
        const disabled = selected.length >= 3 && !isSelected;
        return <li key={productId}>
          <div>
            <small>{product.dataType === 'DEMO' ? 'DEMO · SAMPLE DATA' : 'LIVE · eBay'}</small>
            <strong>{product.title}</strong>
            <span>{product.requestedCategory || product.category} · {product.brand || 'Brand not provided'}</span>
            <span>{product.dataType === 'DEMO' ? 'Sample price: ' : ''}{money(product.price, product.currency)}</span>
            {product.recommendation && <span>Product match: {product.recommendation.score}/100</span>}
          </div>
          {setSelected && <button
            type="button"
            className="secondary"
            disabled={disabled}
            onClick={() => {
              setSelected((current) => isSelected
                ? current.filter((item) => (item.productId || item.id) !== productId)
                : current.length < 3 ? [...current, product] : current);
            }}
          >{isSelected ? 'Remove from compare' : 'Add to compare'}</button>}
        </li>;
      })}
    </ul>
    {go && combination.products.length > 0 && <button type="button" className="secondary" onClick={() => go('compare')}>Open Compare selection</button>}
  </article>;
}

export default function BudgetOptimizer({ selected = [], setSelected, go }) {
  const [budget, setBudget] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [chosenCategories, setChosenCategories] = useState([]);
  const [brands, setBrands] = useState('');
  const [intendedUse, setIntendedUse] = useState('');
  const [priorities, setPriorities] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function toggleCategory(category) {
    setChosenCategories((current) => current.includes(category)
      ? current.filter((item) => item !== category)
      : [...current, category]);
    setResult(null);
  }

  async function optimize(event) {
    event.preventDefault();
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const optimization = await api('/api/budget/optimize', {
        method: 'POST',
        body: JSON.stringify({
          budget: Number(budget),
          currency,
          categories: chosenCategories,
          preferredBrands: brands.split(',').map((brand) => brand.trim()).filter(Boolean),
          intendedUse,
          priorities,
        }),
      });
      setResult(optimization);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  return <section className="budget-optimizer" aria-label="Intelligent budget optimizer">
    <p className="eyebrow">BUDGET OPTIMIZER</p>
    <h2>Plan a multi-category basket</h2>
    <p>Find a deterministic product combination within one total budget. DEMO products use sample prices; currencies are never converted.</p>
    <p className="budget-scoring-note">The optimizer first maximizes requested category coverage, then ranks equally covered baskets using: coverage 40%, recommendation match 30%, budget utilization 10%, specification suitability 10%, and preferred-brand match 10%.</p>
    <form className="budget-form" onSubmit={optimize}>
      <label>Total budget
        <input required type="number" min="0.01" max="1000000" step="0.01" value={budget} onChange={(event) => { setBudget(event.target.value); setResult(null); }} />
      </label>
      <label>Currency
        <select value={currency} onChange={(event) => { setCurrency(event.target.value); setResult(null); }}>
          {currencies.map((code) => <option key={code} value={code}>{code}</option>)}
        </select>
      </label>
      <fieldset>
        <legend>Required product categories</legend>
        <div className="budget-categories">
          {categories.map((category) => <label key={category}>
            <input type="checkbox" checked={chosenCategories.includes(category)} onChange={() => toggleCategory(category)} />
            {category}
          </label>)}
        </div>
      </fieldset>
      <label>Preferred brands, comma-separated
        <input maxLength={300} value={brands} onChange={(event) => { setBrands(event.target.value); setResult(null); }} placeholder="e.g. Apple, Sony" />
      </label>
      <label>Intended use
        <input maxLength={240} value={intendedUse} onChange={(event) => { setIntendedUse(event.target.value); setResult(null); }} placeholder="e.g. work, travel, music" />
      </label>
      <label className="budget-priorities">Priorities and required specs
        <textarea maxLength={1200} value={priorities} onChange={(event) => { setPriorities(event.target.value); setResult(null); }} placeholder="e.g. 16GB RAM, noise cancellation, Bluetooth" />
      </label>
      <button disabled={loading || !chosenCategories.length}>{loading ? 'Optimizing…' : 'Optimize my budget'}</button>
    </form>
    {error && <p className="notice">{error}</p>}
    {result && <div className="budget-results">
      <h3>Recommended combination</h3>
      <p className="budget-explanation">{result.explanation}</p>
      {result.searchFailures?.length > 0 && <p className="notice">Some category searches failed: {result.searchFailures.join(', ')}.</p>}
      {result.searchStatuses?.filter((status) => status.message).map((status) => (
        <p className="notice" key={status.category}>{status.category}: {status.message}</p>
      ))}
      {result.missingCategories.length > 0 && <div className="budget-missing">
        <h4>Categories not covered</h4>
        <ul>{result.missingCategories.map(({ category, reason }) => <li key={category}><strong>{category}:</strong> {reason}</li>)}</ul>
      </div>}
      {result.recommendedCombination
        ? <>
          <Combination combination={result.recommendedCombination} selected={selected} setSelected={setSelected} go={go} label="Best-scoring basket" />
          {result.alternatives.length > 0 && <>
            <h3>Alternative combinations</h3>
            {result.alternatives.map((combination, index) => <Combination
              key={combination.products.map((product) => product.productId).join('|')}
              combination={combination}
              selected={selected}
              setSelected={setSelected}
              go={go}
              label={`Alternative ${index + 1}`}
            />)}
          </>}
          {result.comparison.specifications.length > 0 && <details className="budget-specifications">
            <summary>Available specifications across the recommended combination</summary>
            <ul>{result.comparison.specifications.map((specification) => <li key={specification.name}>
              <strong>{specification.name}:</strong> {specification.values.map((entry) => {
                const product = result.recommendedCombination.products.find((item) => item.productId === entry.productId);
                return `${product?.title || entry.productId}: ${entry.available ? entry.value : 'Not available'}`;
              }).join(' · ')}
            </li>)}</ul>
          </details>}
        </>
        : <p>No products were available in the requested categories and currency.</p>}
      <small>{result.disclaimer}</small>
    </div>}
  </section>;
}
