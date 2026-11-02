import React, { useEffect, useRef, useState } from 'react';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
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

export default function Dashboard({ user, openOffers, selected, setSelected, go }) {
  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const restoredHistory = useRef(false);
  const pendingRequest = useRef(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe;
    getDb().then((db) => {
      if (cancelled) return;
      const conversationsQuery = query(collection(db, 'users', user.uid, 'chats'), orderBy('updatedAt', 'desc'));
      unsubscribe = onSnapshot(conversationsQuery, (snapshot) => {
        const history = snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
        setConversations(history);
        if (!restoredHistory.current) {
          restoredHistory.current = true;
          if (history.length) setConversationId(history[0].id);
        }
      }, (snapshotError) => setError(`Could not load conversation history: ${snapshotError.message}`));
    }).catch((loadError) => setError(`Could not load conversation history: ${loadError.message}`));
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [user.uid]);

  useEffect(() => {
    setMessages([]);
    if (!conversationId) return undefined;
    let cancelled = false;
    let unsubscribe;
    getDb().then((db) => {
      if (cancelled) return;
      const messagesQuery = query(collection(db, 'users', user.uid, 'chats', conversationId, 'messages'), orderBy('createdAt', 'asc'));
      unsubscribe = onSnapshot(messagesQuery, (snapshot) => {
        setMessages(snapshot.docs.map((document) => ({ id: document.id, ...document.data() })));
      }, (snapshotError) => setError(`Could not load this conversation: ${snapshotError.message}`));
    }).catch((loadError) => setError(`Could not load this conversation: ${loadError.message}`));
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [user.uid, conversationId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, loading]);

  function newChat() {
    restoredHistory.current = true;
    pendingRequest.current = null;
    setConversationId(null);
    setMessages([]);
    setError('');
  }

  function toggleComparison(product) {
    const productId = product.productId || product.id;
    setSelected((current) => current.some((item) => (item.productId || item.id) === productId)
      ? current.filter((item) => (item.productId || item.id) !== productId)
      : current.length < 3 ? [...current, product] : current);
  }

  async function sendMessage(event) {
    event.preventDefault();
    const message = text.trim();
    if (!message || loading) return;

    restoredHistory.current = true;
    const retry = pendingRequest.current?.message === message && pendingRequest.current?.conversationId === conversationId
      ? pendingRequest.current
      : { requestId: crypto.randomUUID(), message, conversationId };
    pendingRequest.current = retry;
    const optimisticId = `pending-${retry.requestId}`;
    setMessages((current) => [...current, { id: optimisticId, role: 'user', content: message, offers: [] }]);
    setText('');
    setError('');
    setLoading(true);
    try {
      const result = await api('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ conversationId: retry.conversationId, message, requestId: retry.requestId }),
      });
      setConversationId(result.conversationId);
      setMessages((current) => {
        const byId = new Map(current.filter((item) => item.id !== optimisticId).map((item) => [item.id, item]));
        byId.set(result.userMessage.id, result.userMessage);
        byId.set(result.assistantMessage.id, result.assistantMessage);
        return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      });
      pendingRequest.current = null;
    } catch (sendError) {
      setMessages((current) => current.filter((item) => item.id !== optimisticId));
      setText(message);
      setError(sendError.message);
    } finally {
      setLoading(false);
    }
  }

  return <section className="agent">
    <div className="agent-heading">
      <div>
        <p className="eyebrow">PAYPILOT AI AGENT</p>
        <h1>Research, together.</h1>
        <p>Ask for recommendations, with explainable matches based on stated requirements and product data. Live offers and sample products are clearly distinguished.</p>
      </div>
      <button className="secondary" onClick={newChat} disabled={loading}>New chat</button>
    </div>
    <div className="chat-layout">
      <aside className="chat-history" aria-label="Conversation history">
        <h2>Conversations</h2>
        {conversations.length ? conversations.map((item) => <button
          key={item.id}
          className={conversationId === item.id ? 'active' : ''}
          disabled={loading}
          onClick={() => { restoredHistory.current = true; pendingRequest.current = null; setConversationId(item.id); setError(''); }}
        >{item.title || 'Shopping conversation'}</button>) : <p className="history-empty">Your saved conversations will appear here.</p>}
      </aside>
      <div className="chat-panel">
        <div className="chat-messages" aria-live="polite">
          {!messages.length && !loading && <div className="chat-welcome">
            <h2>What are you shopping for?</h2>
            <p>Ask for verified offers, then use follow-up questions to refine your search.</p>
          </div>}
          {messages.map((item, index) => {
            const searchQuery = item.offerQuery || messages.slice(0, index).reverse().find((previous) => previous.role === 'user')?.content || '';
            const verifiedOffers = filterVerifiedOffers(item.offers)
              .filter((offer) => isOfferRelevantToQuery(offer, searchQuery));
            return <article key={item.id} className={`chat-message ${item.role}`}>
            <small>{item.role === 'user' ? 'You' : 'PayPilot AI'}</small>
            <p>{item.content}</p>
            {verifiedOffers.length > 0 && <div className="chat-offers">
              {verifiedOffers.map((offer) => {
                const live = offer.dataType === 'LIVE' || (!offer.dataType && offer.id?.startsWith('ebay:'));
                const retailerUrl = live ? safeRetailerUrl(offer.listingUrl || offer.retailerUrl) : null;
                return <article className="chat-offer" key={offer.id}>
                  <small>{live ? 'LIVE · eBay' : 'DEMO · SAMPLE DATA'}</small>
                  <strong>{offer.name}</strong>
                  <p>{live ? money(offer.price, offer.currency) : `Sample price: ${money(offer.price, offer.currency)}`} ({offer.currency})</p>
                  {offer.recommendation && <>
                    <p><strong>Recommendation score: {offer.recommendation.score}/100</strong></p>
                    <p>{offer.recommendation.explanation}</p>
                    {!!offer.recommendation.concerns?.length && <ul className="recommendation-concerns">{offer.recommendation.concerns.map((concern) => <li key={concern}>{concern}</li>)}</ul>}
                  </>}
                  <small>{live ? `Seller: ${sellerDisplayName(offer.merchant)}` : 'Curated sample product; no seller or listing.'}</small>
                  <p>{live ? offerDetail(offer.availability) : 'Sample data; availability is not live.'}</p>
                  {retailerUrl && <a href={retailerUrl} target="_blank" rel="noreferrer">Open verified listing ↗</a>}
                  <button
                    className="secondary"
                    disabled={selected.length >= 3 && !selected.some((product) => (product.productId || product.id) === (offer.productId || offer.id))}
                    onClick={() => toggleComparison(offer)}
                  >{selected.some((product) => (product.productId || product.id) === (offer.productId || offer.id)) ? 'Remove from compare' : 'Add to compare'}</button>
                </article>;
              })}
              <button className="secondary" onClick={() => openOffers(verifiedOffers, searchQuery)}>Open verified offers in Discover</button>
              {selected.length > 0 && <button className="secondary" onClick={() => go('compare')}>Compare selection ({selected.length}/3)</button>}
            </div>}
          </article>;
          })}
          {loading && <div className="chat-loading" role="status">PayPilot AI is thinking…</div>}
          <div ref={bottomRef}/>
        </div>
        {error && <p className="notice chat-error">{error}</p>}
        <form className="chat-compose" onSubmit={sendMessage}>
          <textarea
            value={text}
            onChange={(event) => { if (event.target.value.trim() !== pendingRequest.current?.message) pendingRequest.current = null; setText(event.target.value); }}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form.requestSubmit(); } }}
            placeholder="Ask a question or follow up…"
            aria-label="Message PayPilot AI"
            maxLength={1500}
            rows={2}
            disabled={loading}
          />
          <button type="submit" disabled={loading || !text.trim()}>{loading ? 'Sending…' : 'Send'}</button>
        </form>
        <small className="chat-disclaimer">PayPilot never initiates a payment. Prices and availability can change at the retailer.</small>
      </div>
    </div>
    <BudgetOptimizer selected={selected} setSelected={setSelected} go={go} />
  </section>;
}
