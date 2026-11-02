import test from 'node:test';
import assert from 'node:assert/strict';
import { beginChatTurn, buildConversationContext, extractProductSearchQuery, isProductResearchRequest, saveChatTurn } from './chat.js';

function createMemoryDb() {
  const users = new Map();
  let nextId = 0;
  return {
    users,
    batch() {
      const operations = [];
      return {
        set(reference, data, options) { operations.push(() => reference.set(data, options)); return this; },
        async commit() { await Promise.all(operations.map((operation) => operation())); },
      };
    },
    collection(name) {
      assert.equal(name, 'users');
      return {
        doc(userId) {
          if (!users.has(userId)) users.set(userId, new Map());
          const userChats = users.get(userId);
          return {
            collection(subcollection) {
              assert.equal(subcollection, 'chats');
              return {
                doc(chatId = `chat-${++nextId}`) {
                  if (!userChats.has(chatId)) userChats.set(chatId, { data: null, messages: new Map() });
                  const chat = userChats.get(chatId);
                  return {
                    id: chatId,
                    get: async () => ({ exists: Boolean(chat.data), data: () => chat.data }),
                    set: async (data) => { chat.data = data; },
                    update: async (data) => { chat.data = { ...chat.data, ...data }; },
                    collection(messageCollection) {
                      assert.equal(messageCollection, 'messages');
                      return {
                        orderBy: () => ({
                          limit: (max) => ({
                            get: async () => {
                              const docs = [...chat.messages.entries()]
                                .sort((left, right) => right[1].createdAt.localeCompare(left[1].createdAt))
                                .slice(0, max)
                                .map(([id, data]) => ({ id, data: () => data }));
                              return { docs };
                            },
                          }),
                        }),
                        doc(messageId = `message-${++nextId}`) {
                          return {
                            id: messageId,
                            get: async () => ({ exists: chat.messages.has(messageId), data: () => chat.messages.get(messageId) }),
                            set: async (data) => chat.messages.set(messageId, data),
                          };
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

test('conversation context retains recent user and assistant messages only', () => {
  const context = buildConversationContext([
    { role: 'system', content: 'ignored' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'last' },
  ], 2);
  assert.deepEqual(context, [{ role: 'assistant', content: 'reply' }, { role: 'user', content: 'last' }]);
  assert.equal(buildConversationContext([{ role: 'user', content: 'x'.repeat(3000) }])[0].content.length, 2500);
});

test('product follow-ups request fresh verified retailer data', () => {
  assert.equal(isProductResearchRequest('Find a keyboard under $100'), true);
  assert.equal(isProductResearchRequest('Show me some headphones'), true);
  assert.equal(isProductResearchRequest('Samsung phone under $300'), true);
  assert.equal(isProductResearchRequest('Samsung phone'), true);
  assert.equal(isProductResearchRequest('iphone'), true);
  assert.equal(isProductResearchRequest('Sony headphones'), true);
  assert.equal(isProductResearchRequest('Dell laptop'), true);
  assert.equal(isProductResearchRequest('Looking for Sony headphones'), true);
  assert.equal(isProductResearchRequest('Any cheaper alternatives?'), false);
  assert.equal(isProductResearchRequest('Any cheaper alternatives?', [{ role: 'user', content: 'Samsung phone' }]), true);
  assert.equal(isProductResearchRequest('Does it come in another color?', [{ role: 'user', content: 'Find a keyboard' }]), true);
  assert.equal(isProductResearchRequest('Does it come in another color?', [{ role: 'user', content: 'Samsung phone' }]), true);
  assert.equal(isProductResearchRequest('Does it come in another color?'), false);
  assert.equal(isProductResearchRequest('What is a phone?'), false);
  assert.equal(isProductResearchRequest('Thanks, that helps'), false);
});

test('short product keywords trigger searches but greetings and unrelated questions do not', () => {
  for (const keyword of ['phone', 'laptop', 'headphones', 'watch', 'tablet']) {
    assert.equal(isProductResearchRequest(keyword), true, `${keyword} should trigger product search`);
  }
  assert.equal(isProductResearchRequest('Hi there!'), false);
  assert.equal(isProductResearchRequest('Good morning'), false);
  assert.equal(isProductResearchRequest('What is the capital of France?'), false);
  assert.equal(isProductResearchRequest('How is the weather today?'), false);
});

test('product search queries contain concise keywords from the current message only', () => {
  assert.equal(extractProductSearchQuery('Find Sony wireless headphones'), 'Sony wireless headphones');
  assert.equal(extractProductSearchQuery('Find phone'), 'phone');
  assert.equal(extractProductSearchQuery("I'm looking for a phone, please"), 'phone');
  assert.equal(extractProductSearchQuery('Could you find me a noise cancelling headset?'), 'noise cancelling headset');

  const previousMessages = ['Find Sony wireless headphones', 'Find phone'];
  const currentMessage = 'Find phone';
  const query = extractProductSearchQuery(currentMessage);
  assert.equal(query, 'phone');
  assert.equal(extractProductSearchQuery('Samsung phone under $300'), 'Samsung phone under $300');
  assert.equal(previousMessages.some((message) => query.includes(message)), false);
  assert.equal(query.includes('Sony'), false);
});

test('chat turns persist under the user UID and reload prior context', async () => {
  const db = createMemoryDb();
  const requestId = '12345678-1234-1234-1234-123456789abc';
  const first = await beginChatTurn({ db, userId: 'user-a', requestId, message: 'Find headphones', now: '2026-10-31T12:00:00.000Z' });
  assert.equal(first.context.length, 0);
  const offer = { id: 'ebay:1', name: 'Verified headphones', price: 79, currency: 'USD', retailerUrl: 'https://example.com/item' };
  const assistantMessage = await saveChatTurn({ ...first, content: 'I found a verified listing.', offers: [offer], offerQuery: 'headphones', now: '2026-10-31T12:00:01.000Z' });
  assert.equal(assistantMessage.offerQuery, 'headphones');

  const second = await beginChatTurn({ db, userId: 'user-a', conversationId: first.conversationId, requestId: '22345678-1234-1234-1234-123456789abc', message: 'Any cheaper alternatives?', now: '2026-10-31T12:00:02.000Z' });
  assert.deepEqual(second.context.map(({ role, content }) => [role, content]), [
    ['user', 'Find headphones'],
    ['assistant', 'I found a verified listing.'],
  ]);
  assert.deepEqual(db.users.get('user-a').get(first.conversationId).messages.get(assistantMessage.id).offers, [offer]);
  const retry = await beginChatTurn({ db, userId: 'user-a', requestId, message: 'Find headphones' });
  assert.equal(retry.alreadyCompleted, true);
  assert.equal(retry.userMessage.id, first.userMessage.id);
  assert.equal(retry.assistantMessage.id, assistantMessage.id);
  await assert.rejects(
    beginChatTurn({ db, userId: 'user-b', conversationId: first.conversationId, message: 'Read this chat' }),
    { status: 404 },
  );
});

test('duplicate submissions with the same request ID reuse the same message documents', async () => {
  const db = createMemoryDb();
  const request = {
    db,
    userId: 'user-a',
    requestId: '32345678-1234-1234-1234-123456789abc',
    message: 'Find a laptop',
  };
  const [first, retry] = await Promise.all([beginChatTurn(request), beginChatTurn(request)]);
  await Promise.all([
    saveChatTurn({ ...first, content: 'Verified offers are below.' }),
    saveChatTurn({ ...retry, content: 'Verified offers are below.' }),
  ]);
  const chat = db.users.get('user-a').get(`chat-${request.requestId}`);
  assert.equal(chat.messages.size, 2);
  assert.equal([...chat.messages.values()].filter((item) => item.role === 'user').length, 1);
  assert.equal([...chat.messages.values()].filter((item) => item.role === 'assistant').length, 1);
});
