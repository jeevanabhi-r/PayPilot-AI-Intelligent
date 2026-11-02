const PRODUCT_QUERY_PATTERN = /\b(?:phones?|smartphones?|iphones?|laptops?|headphones?|headsets?|watches|watch|tablets?|keyboards?|mice|cameras?|televisions?|tv|monitors?|consoles?)\b/i;

export function buildConversationContext(messages, limit = 12) {
  return messages
    .filter((message) => ['user', 'assistant'].includes(message.role) && typeof message.content === 'string')
    .slice(-limit)
    .map(({ role, content }) => ({ role, content: content.slice(0, 2500) }));
}

export function isProductResearchRequest(message, context = []) {
  const searchIntent = /\b(find|search|recommend|suggest|shop|buy|purchase|looking for|need|want|price|cost|under|budget|deal|offer|product|cheaper|cheapest|alternative|alternatives|compare|available|retailer|link|show me|what about|do you have)\b/i.test(message);
  const asksGeneralQuestion = /\b(?:what is|what are|who is|where is|when is|why does|why is|how do i|how does|explain|define)\b/i.test(message);
  const mentionsProduct = PRODUCT_QUERY_PATTERN.test(message);
  if (mentionsProduct && (!asksGeneralQuestion || searchIntent)) return true;
  const hasProductContext = context.some((item) => item.role === 'user' && PRODUCT_QUERY_PATTERN.test(item.content));
  return hasProductContext && (searchIntent || /\b(it|they|them|those|these|one|ones|which|better)\b/i.test(message));
}

export function extractProductSearchQuery(message) {
  return String(message)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:(?:please|hey)[\s,]*)*(?:(?:can|could|would)\s+you\s+)?(?:(?:help me\s+)?(?:find|search(?:\s+for)?|look(?:ing)?\s+for|show(?:\s+me)?|recommend|suggest|shop(?:\s+for)?|buy|purchase)\s+(?:me\s+)?|i(?:'m| am)\s+looking\s+for\s+|i\s+(?:want|need)\s+|tell me about\s+)/i, '')
    .replace(/\s+(?:please|thanks)[.!?]*$/i, '')
    .replace(/^(?:(?:a|an|the|some)\s+)+/i, '')
    .replace(/^[\s,.:;-]+|[\s,.:;!?-]+$/g, '')
    .trim();
}

export async function beginChatTurn({ db, userId, conversationId, requestId, message, now = new Date().toISOString() }) {
  const chats = db.collection('users').doc(userId).collection('chats');
  const isNew = !conversationId;
  const chatRef = isNew ? chats.doc(`chat-${requestId}`) : chats.doc(conversationId);

  if (!isNew && !(await chatRef.get()).exists) {
    const error = new Error('Conversation not found.');
    error.status = 404;
    throw error;
  }

  const messages = chatRef.collection('messages');
  const userMessageRef = messages.doc(`${requestId}-user`);
  const assistantMessageRef = messages.doc(`${requestId}-assistant`);
  const [existingUserMessage, existingAssistantMessage] = await Promise.all([userMessageRef.get(), assistantMessageRef.get()]);
  if (existingAssistantMessage.exists && existingUserMessage.exists) {
    return {
      conversationId: chatRef.id,
      alreadyCompleted: true,
      userMessage: { id: userMessageRef.id, ...existingUserMessage.data() },
      assistantMessage: { id: assistantMessageRef.id, ...existingAssistantMessage.data() },
    };
  }

  const snapshot = await messages.orderBy('createdAt', 'desc').limit(20).get();
  const context = buildConversationContext(snapshot.docs.map((document) => document.data()).reverse());
  const userMessage = { role: 'user', content: message, offers: [], createdAt: now };
  return {
    db,
    chatRef,
    messages,
    userMessageRef,
    assistantMessageRef,
    conversationId: chatRef.id,
    context,
    userMessage: { id: userMessageRef.id, ...userMessage },
    isNew,
  };
}

export async function saveChatTurn({ db, chatRef, userMessageRef, assistantMessageRef, userMessage, content, offers = [], offerQuery = '', isNew, now = new Date().toISOString() }) {
  const assistantTime = Math.max(Date.parse(now), Date.parse(userMessage.createdAt) + 1);
  const assistantMessage = {
    role: 'assistant',
    content: content.slice(0, 4000),
    offers: offers.slice(0, 12),
    ...(offerQuery ? { offerQuery: offerQuery.slice(0, 250) } : {}),
    createdAt: new Date(assistantTime).toISOString(),
  };
  const batch = db.batch();
  batch.set(chatRef, {
    ...(isNew ? { title: userMessage.content.slice(0, 80), createdAt: userMessage.createdAt } : {}),
    updatedAt: assistantMessage.createdAt,
  }, { merge: true });
  batch.set(userMessageRef, userMessage);
  batch.set(assistantMessageRef, assistantMessage);
  await batch.commit();
  return { id: assistantMessageRef.id, ...assistantMessage };
}
