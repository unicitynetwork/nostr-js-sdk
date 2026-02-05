/**
 * Unit tests for NostrClient
 * Features 1-9, 17, 19, 20: Connection lifecycle, message handling, publishing,
 * subscriptions, reconnection, NIP-17, token/payment delegation, nametag query,
 * disconnect cleanup, config combinations, subscription re-establishment, concurrency
 *
 * Techniques: [ST] State Transition, [DT] Decision Table, [EP] Equivalence Partitioning,
 * [BVA] Boundary Value Analysis, [UC] Use Case, [EG] Error Guessing, [PW] Pairwise,
 * [LC] Loop Testing, [RB] Risk-Based, [SC] Statement/Branch Coverage
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { NostrClient, type ConnectionEventListener } from '../../src/client/NostrClient.js';
import { NostrKeyManager } from '../../src/NostrKeyManager.js';
import { Event } from '../../src/protocol/Event.js';
import { Filter } from '../../src/protocol/Filter.js';
import * as EventKinds from '../../src/protocol/EventKinds.js';
import type { IWebSocket, WebSocketMessageEvent, WebSocketCloseEvent, WebSocketErrorEvent } from '../../src/client/WebSocketAdapter.js';

// ============================================================
// Mock WebSocket Infrastructure
// ============================================================

class MockWebSocket implements IWebSocket {
  readyState = 0; // CONNECTING
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  sentMessages: string[] = [];
  closeCode?: number;
  closeReason?: string;

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3; // CLOSED
  }

  simulateOpen(): void {
    this.readyState = 1; // OPEN
    this.onopen?.({});
  }

  simulateMessage(data: string): void {
    this.onmessage?.({ data });
  }

  simulateClose(code = 1000, reason = ''): void {
    this.readyState = 3; // CLOSED
    this.onclose?.({ code, reason });
  }

  simulateError(message = 'Error'): void {
    this.onerror?.({ message });
  }
}

let mockSockets: MockWebSocket[] = [];
let createWebSocketMock: Mock;

vi.mock('../../src/client/WebSocketAdapter.js', () => ({
  createWebSocket: (...args: unknown[]) => createWebSocketMock(...args),
  extractMessageData: (event: WebSocketMessageEvent) => {
    if (typeof event.data === 'string') return event.data;
    return String(event.data);
  },
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
}));

// ============================================================
// Helpers
// ============================================================

function createMockSocket(): MockWebSocket {
  const socket = new MockWebSocket();
  mockSockets.push(socket);
  return socket;
}

/** Flush microtask queue so promise chains settle */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

/** Connect client to a relay and return the mock socket */
async function connectClient(client: NostrClient, url = 'wss://relay.example.com'): Promise<MockWebSocket> {
  const socket = createMockSocket();
  createWebSocketMock.mockResolvedValueOnce(socket);
  const connectPromise = client.connect(url);
  await flushMicrotasks();
  socket.simulateOpen();
  await connectPromise;
  return socket;
}

function createTestEvent(keyManager: NostrKeyManager, content = 'test'): Event {
  return Event.create(keyManager, {
    kind: EventKinds.TEXT_NOTE,
    tags: [],
    content,
  });
}

// ============================================================
// Tests
// ============================================================

describe('NostrClient', () => {
  let keyManager: NostrKeyManager;
  let client: NostrClient;

  beforeEach(() => {
    mockSockets = [];
    createWebSocketMock = vi.fn();
    keyManager = NostrKeyManager.generate();
    client = new NostrClient(keyManager);
  });

  afterEach(() => {
    client.disconnect();
  });

  // ==========================================================
  // Feature 1: Connection Lifecycle [ST]
  // ==========================================================
  describe('Feature 1: Connection Lifecycle', () => {
    it('should start in disconnected state', () => {
      expect(client.isConnected()).toBe(false);
      expect(client.getConnectedRelays().size).toBe(0);
    });

    it('should connect to a single relay', async () => {
      await connectClient(client, 'wss://relay1.example.com');

      expect(client.isConnected()).toBe(true);
      expect(client.getConnectedRelays().has('wss://relay1.example.com')).toBe(true);
    });

    it('should connect to multiple relays', async () => {
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();
      createWebSocketMock.mockResolvedValueOnce(socket1).mockResolvedValueOnce(socket2);

      const connectPromise = client.connect('wss://relay1.example.com', 'wss://relay2.example.com');
      await flushMicrotasks();
      socket1.simulateOpen();
      socket2.simulateOpen();
      await connectPromise;

      expect(client.getConnectedRelays().size).toBe(2);
    });

    it('should not create duplicate connection to already-connected relay', async () => {
      await connectClient(client, 'wss://relay.example.com');

      await client.connect('wss://relay.example.com');

      expect(createWebSocketMock).toHaveBeenCalledTimes(1);
    });

    it('should timeout connection after 30 seconds', async () => {
      vi.useFakeTimers();
      const socket = createMockSocket();
      createWebSocketMock.mockResolvedValueOnce(socket);

      const connectPromise = client.connect('wss://slow.example.com');
      // Attach a catch handler before advancing timers to prevent unhandled rejection
      let timeoutError: Error | undefined;
      connectPromise.catch(e => { timeoutError = e; });

      await vi.advanceTimersByTimeAsync(30001);
      await flushMicrotasks();

      expect(timeoutError).toBeDefined();
      expect(timeoutError!.message).toMatch(/timed out/);
      vi.useRealTimers();
    });

    it('should reject if createWebSocket fails', async () => {
      createWebSocketMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(client.connect('wss://down.example.com')).rejects.toThrow('ECONNREFUSED');
    });

    it('should reject if WebSocket fires onerror before onopen', async () => {
      const socket = createMockSocket();
      createWebSocketMock.mockResolvedValueOnce(socket);

      const connectPromise = client.connect('wss://bad.example.com');
      await flushMicrotasks();
      socket.simulateError('Connection refused');

      await expect(connectPromise).rejects.toThrow(/Failed to connect/);
    });

    it('should reject all operations after disconnect [ST terminal state]', async () => {
      client.disconnect();

      await expect(client.connect('wss://relay.example.com')).rejects.toThrow(/disconnected/);

      const event = createTestEvent(keyManager);
      await expect(client.publishEvent(event)).rejects.toThrow(/disconnected/);
    });

    it('should handle multiple disconnect calls gracefully [EG]', () => {
      client.disconnect();
      client.disconnect();
      client.disconnect();
      expect(true).toBe(true);
    });

    it('should return key manager', () => {
      expect(client.getKeyManager()).toBe(keyManager);
    });
  });

  // ==========================================================
  // Feature 2: Relay Message Handling [DT]
  // ==========================================================
  describe('Feature 2: Relay Message Handling', () => {
    let socket: MockWebSocket;

    beforeEach(async () => {
      socket = await connectClient(client);
    });

    it('EVENT message dispatches to correct subscription listener', () => {
      const onEvent = vi.fn();
      client.subscribe('sub_1', Filter.builder().kinds(1).build(), { onEvent });

      const event = createTestEvent(keyManager, 'hello');
      socket.simulateMessage(JSON.stringify(['EVENT', 'sub_1', event.toJSON()]));

      expect(onEvent).toHaveBeenCalledOnce();
      expect(onEvent.mock.calls[0]![0].content).toBe('hello');
    });

    it('EVENT for unknown subscription is silently ignored', () => {
      const onEvent = vi.fn();
      client.subscribe('sub_1', Filter.builder().kinds(1).build(), { onEvent });

      const event = createTestEvent(keyManager);
      socket.simulateMessage(JSON.stringify(['EVENT', 'unknown_sub', event.toJSON()]));

      expect(onEvent).not.toHaveBeenCalled();
    });

    it('EVENT message with fewer than 3 elements is ignored [BVA]', () => {
      const onEvent = vi.fn();
      client.subscribe('sub_1', Filter.builder().kinds(1).build(), { onEvent });

      socket.simulateMessage(JSON.stringify(['EVENT', 'sub_1']));
      expect(onEvent).not.toHaveBeenCalled();
    });

    it('EVENT with invalid event JSON is silently ignored [EG]', () => {
      const onEvent = vi.fn();
      client.subscribe('sub_1', Filter.builder().kinds(1).build(), { onEvent });

      socket.simulateMessage(JSON.stringify(['EVENT', 'sub_1', { invalid: 'data' }]));
      expect(onEvent).not.toHaveBeenCalled();
    });

    it('OK message resolves pending publish (accepted)', async () => {
      const event = createTestEvent(keyManager);
      const publishPromise = client.publishEvent(event);

      socket.simulateMessage(JSON.stringify(['OK', event.id, true, '']));
      await expect(publishPromise).resolves.toBe(event.id);
    });

    it('OK message rejects pending publish (rejected)', async () => {
      const event = createTestEvent(keyManager);
      const publishPromise = client.publishEvent(event);

      socket.simulateMessage(JSON.stringify(['OK', event.id, false, 'blocked: rate limit']));
      await expect(publishPromise).rejects.toThrow(/Event rejected: blocked: rate limit/);
    });

    it('OK message with insufficient elements is ignored [BVA]', async () => {
      vi.useFakeTimers();
      const socket2 = await connectClient(client, 'wss://relay2.example.com');
      const event = createTestEvent(keyManager);
      const publishPromise = client.publishEvent(event);

      socket2.simulateMessage(JSON.stringify(['OK', event.id, true]));
      // Not resolved — advance past timeout
      await vi.advanceTimersByTimeAsync(5001);
      // Resolves via timeout (optimistic)
      await expect(publishPromise).resolves.toBe(event.id);
      vi.useRealTimers();
    });

    it('EOSE triggers onEndOfStoredEvents callback', () => {
      const onEvent = vi.fn();
      const onEndOfStoredEvents = vi.fn();
      client.subscribe('sub_1', Filter.builder().kinds(1).build(), { onEvent, onEndOfStoredEvents });

      socket.simulateMessage(JSON.stringify(['EOSE', 'sub_1']));
      expect(onEndOfStoredEvents).toHaveBeenCalledWith('sub_1');
    });

    it('EOSE handled gracefully when no onEndOfStoredEvents callback', () => {
      const onEvent = vi.fn();
      client.subscribe('sub_1', Filter.builder().kinds(1).build(), { onEvent });

      expect(() => {
        socket.simulateMessage(JSON.stringify(['EOSE', 'sub_1']));
      }).not.toThrow();
    });

    it('CLOSED message triggers onError callback', () => {
      const onEvent = vi.fn();
      const onError = vi.fn();
      client.subscribe('sub_1', Filter.builder().kinds(1).build(), { onEvent, onError });

      socket.simulateMessage(JSON.stringify(['CLOSED', 'sub_1', 'auth-required: must authenticate']));
      expect(onError).toHaveBeenCalledWith('sub_1', expect.stringContaining('auth-required'));
    });

    it('AUTH message triggers NIP-42 authentication', () => {
      socket.simulateMessage(JSON.stringify(['AUTH', 'challenge-abc']));

      const authMessages = socket.sentMessages.filter(m => {
        try { return JSON.parse(m)[0] === 'AUTH'; } catch { return false; }
      });

      expect(authMessages.length).toBe(1);
      const authResponse = JSON.parse(authMessages[0]!);
      const authEvent = authResponse[1];
      expect(authEvent.kind).toBe(22242);

      const relayTag = authEvent.tags.find((t: string[]) => t[0] === 'relay');
      const challengeTag = authEvent.tags.find((t: string[]) => t[0] === 'challenge');
      expect(relayTag[1]).toBe('wss://relay.example.com');
      expect(challengeTag[1]).toBe('challenge-abc');
    });

    it('AUTH triggers resubscription after 100ms delay', async () => {
      vi.useFakeTimers();
      const socket3 = await connectClient(client, 'wss://relay3.example.com');
      const onEvent = vi.fn();
      client.subscribe('sub_1', Filter.builder().kinds(1).build(), { onEvent });
      socket3.sentMessages = [];

      socket3.simulateMessage(JSON.stringify(['AUTH', 'challenge']));

      // Before 100ms — only AUTH sent, no REQ yet
      const reqsBefore = socket3.sentMessages.filter(m => {
        try { return JSON.parse(m)[0] === 'REQ'; } catch { return false; }
      });

      await vi.advanceTimersByTimeAsync(100);

      const reqsAfter = socket3.sentMessages.filter(m => {
        try { return JSON.parse(m)[0] === 'REQ'; } catch { return false; }
      });
      expect(reqsAfter.length).toBeGreaterThanOrEqual(1);
      vi.useRealTimers();
    });

    it('malformed JSON is silently ignored [EG]', () => {
      expect(() => socket.simulateMessage('not json')).not.toThrow();
    });

    it('non-array JSON is silently ignored [EG]', () => {
      expect(() => socket.simulateMessage('{"type":"EVENT"}')).not.toThrow();
    });

    it('empty array is silently ignored [EG]', () => {
      expect(() => socket.simulateMessage('[]')).not.toThrow();
    });

    it('single-element array is silently ignored [EG]', () => {
      expect(() => socket.simulateMessage('["EVENT"]')).not.toThrow();
    });

    it('unknown message type is silently ignored [EG]', () => {
      expect(() => socket.simulateMessage('["UNKNOWN_TYPE","data"]')).not.toThrow();
    });
  });

  // ==========================================================
  // Feature 3: Event Publishing [EP]
  // ==========================================================
  describe('Feature 3: Event Publishing', () => {
    it('should broadcast event to all connected relays', async () => {
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();
      createWebSocketMock.mockResolvedValueOnce(socket1).mockResolvedValueOnce(socket2);

      const connectPromise = client.connect('wss://relay1.example.com', 'wss://relay2.example.com');
      await flushMicrotasks();
      socket1.simulateOpen();
      socket2.simulateOpen();
      await connectPromise;

      const event = createTestEvent(keyManager, 'Hello Nostr');
      const publishPromise = client.publishEvent(event);

      expect(socket1.sentMessages.some(m => m.includes('Hello Nostr'))).toBe(true);
      expect(socket2.sentMessages.some(m => m.includes('Hello Nostr'))).toBe(true);

      socket1.simulateMessage(JSON.stringify(['OK', event.id, true, '']));
      await publishPromise;
    });

    it('should queue event when not connected [ST offline]', async () => {
      const event = createTestEvent(keyManager);
      const publishPromise = client.publishEvent(event);

      expect(publishPromise).toBeInstanceOf(Promise);

      client.disconnect();
      await expect(publishPromise).rejects.toThrow(/disconnected/);
    });

    it('should flush queued events on connection', async () => {
      const event1 = createTestEvent(keyManager, 'queued1');
      const event2 = createTestEvent(keyManager, 'queued2');

      const p1 = client.publishEvent(event1);
      const p2 = client.publishEvent(event2);

      const socket = createMockSocket();
      createWebSocketMock.mockResolvedValueOnce(socket);
      const connectPromise = client.connect('wss://relay.example.com');
      await flushMicrotasks();
      socket.simulateOpen();
      await connectPromise;
      await flushMicrotasks();

      expect(socket.sentMessages.some(m => m.includes('queued1'))).toBe(true);
      expect(socket.sentMessages.some(m => m.includes('queued2'))).toBe(true);

      // Resolve via OK
      socket.simulateMessage(JSON.stringify(['OK', event1.id, true, '']));
      socket.simulateMessage(JSON.stringify(['OK', event2.id, true, '']));
      await p1;
      await p2;
    });

    it('should resolve after 5s timeout even without OK [BVA]', async () => {
      vi.useFakeTimers();
      const socket = await connectClient(client);

      const event = createTestEvent(keyManager);
      const publishPromise = client.publishEvent(event);

      await vi.advanceTimersByTimeAsync(5001);

      await expect(publishPromise).resolves.toBe(event.id);
      vi.useRealTimers();
    });

    it('OK response should clear the pending timeout', async () => {
      const socket = await connectClient(client);

      const event = createTestEvent(keyManager);
      const publishPromise = client.publishEvent(event);

      socket.simulateMessage(JSON.stringify(['OK', event.id, true, '']));
      await expect(publishPromise).resolves.toBe(event.id);
    });
  });

  // ==========================================================
  // Feature 4: Subscriptions [EP]
  // ==========================================================
  describe('Feature 4: Subscriptions', () => {
    it('should auto-generate sequential subscription IDs', async () => {
      await connectClient(client);
      const filter = Filter.builder().kinds(1).build();
      const onEvent = vi.fn();

      const id1 = client.subscribe(filter, { onEvent });
      const id2 = client.subscribe(filter, { onEvent });
      const id3 = client.subscribe(filter, { onEvent });

      expect(id1).toBe('sub_1');
      expect(id2).toBe('sub_2');
      expect(id3).toBe('sub_3');
    });

    it('should accept custom subscription ID', async () => {
      await connectClient(client);
      const filter = Filter.builder().kinds(1).build();

      const id = client.subscribe('my-custom-id', filter, { onEvent: vi.fn() });
      expect(id).toBe('my-custom-id');
    });

    it('should send REQ to all connected relays', async () => {
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();
      createWebSocketMock.mockResolvedValueOnce(socket1).mockResolvedValueOnce(socket2);

      const connectPromise = client.connect('wss://relay1.example.com', 'wss://relay2.example.com');
      await flushMicrotasks();
      socket1.simulateOpen();
      socket2.simulateOpen();
      await connectPromise;

      const filter = Filter.builder().kinds(1).build();
      client.subscribe(filter, { onEvent: vi.fn() });

      const req1 = socket1.sentMessages.find(m => { try { return JSON.parse(m)[0] === 'REQ'; } catch { return false; } });
      const req2 = socket2.sentMessages.find(m => { try { return JSON.parse(m)[0] === 'REQ'; } catch { return false; } });
      expect(req1).toBeDefined();
      expect(req2).toBeDefined();
    });

    it('should store subscription when not connected (no REQ sent)', () => {
      const filter = Filter.builder().kinds(1).build();
      const id = client.subscribe(filter, { onEvent: vi.fn() });

      expect(id).toMatch(/^sub_\d+$/);
    });

    it('should send CLOSE on unsubscribe', async () => {
      const socket = await connectClient(client);
      const filter = Filter.builder().kinds(1).build();

      const subId = client.subscribe(filter, { onEvent: vi.fn() });
      client.unsubscribe(subId);

      const closeMsg = socket.sentMessages.find(m => {
        try { const p = JSON.parse(m); return p[0] === 'CLOSE' && p[1] === subId; }
        catch { return false; }
      });
      expect(closeMsg).toBeDefined();
    });

    it('should handle unsubscribe with unknown ID gracefully', async () => {
      await connectClient(client);
      expect(() => client.unsubscribe('non_existent')).not.toThrow();
    });

    it('should manage many concurrent subscriptions [LC]', async () => {
      const socket = await connectClient(client);

      const ids: string[] = [];
      for (let i = 0; i < 100; i++) {
        ids.push(client.subscribe(Filter.builder().kinds(1).build(), { onEvent: vi.fn() }));
      }

      expect(ids.length).toBe(100);

      const reqMessages = socket.sentMessages.filter(m => {
        try { return JSON.parse(m)[0] === 'REQ'; } catch { return false; }
      });
      expect(reqMessages.length).toBe(100);

      for (const id of ids) {
        client.unsubscribe(id);
      }

      const closeMessages = socket.sentMessages.filter(m => {
        try { return JSON.parse(m)[0] === 'CLOSE'; } catch { return false; }
      });
      expect(closeMessages.length).toBe(100);
    });
  });

  // ==========================================================
  // Feature 5: Reconnection & Health [ST]
  // ==========================================================
  describe('Feature 5: Reconnection', () => {
    it('should schedule reconnect after connection loss (autoReconnect=true)', async () => {
      vi.useFakeTimers();
      const socket = await connectClient(client, 'wss://relay.example.com');
      const onDisconnect = vi.fn();
      const onReconnecting = vi.fn();
      client.addConnectionListener({ onDisconnect, onReconnecting });

      socket.simulateClose(1006, 'network error');

      expect(onDisconnect).toHaveBeenCalledWith('wss://relay.example.com', 'network error');

      await vi.advanceTimersByTimeAsync(1000);
      expect(onReconnecting).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('should NOT reconnect when autoReconnect is false', async () => {
      vi.useFakeTimers();
      client.disconnect();
      client = new NostrClient(keyManager, { autoReconnect: false });

      const socket = await connectClient(client, 'wss://relay.example.com');
      const onReconnecting = vi.fn();
      client.addConnectionListener({ onReconnecting });

      socket.simulateClose(1006, 'network error');
      await vi.advanceTimersByTimeAsync(60000);

      expect(onReconnecting).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('should emit "connect" on first connection', async () => {
      const onConnect = vi.fn();
      client.addConnectionListener({ onConnect });

      await connectClient(client, 'wss://relay.example.com');

      expect(onConnect).toHaveBeenCalledWith('wss://relay.example.com');
    });

    it('should swallow listener errors [EG]', async () => {
      client.addConnectionListener({
        onConnect: () => { throw new Error('listener crash'); },
      });

      await connectClient(client, 'wss://relay.example.com');
      expect(client.isConnected()).toBe(true);
    });

    it('should remove connection listener', async () => {
      const onConnect = vi.fn();
      const listener: ConnectionEventListener = { onConnect };
      client.addConnectionListener(listener);
      client.removeConnectionListener(listener);

      await connectClient(client, 'wss://relay.example.com');
      expect(onConnect).not.toHaveBeenCalled();
    });

    it('should handle removing non-existent listener gracefully', () => {
      expect(() => client.removeConnectionListener({ onConnect: vi.fn() })).not.toThrow();
    });
  });

  // ==========================================================
  // Feature 8: Nametag Query [ST]
  // ==========================================================
  describe('Feature 8: Nametag Query', () => {
    it('should resolve with null on timeout', async () => {
      client.disconnect();
      client = new NostrClient(keyManager, { queryTimeoutMs: 50, pingIntervalMs: 0 });
      await connectClient(client);

      const result = await client.queryPubkeyByNametag('nobody');
      expect(result).toBeNull();
    }, 10000);

    it('should respect custom query timeout', async () => {
      client.disconnect();
      client = new NostrClient(keyManager, { queryTimeoutMs: 50, pingIntervalMs: 0 });
      await connectClient(client);

      const result = await client.queryPubkeyByNametag('test');
      expect(result).toBeNull();
    }, 10000);

    it('should return pubkey on EOSE', async () => {
      const socket = await connectClient(client);

      const queryPromise = client.queryPubkeyByNametag('alice');
      await flushMicrotasks();

      // Find the subscription
      const reqMsg = socket.sentMessages.find(m => {
        try { return JSON.parse(m)[0] === 'REQ'; } catch { return false; }
      });
      expect(reqMsg).toBeDefined();
      const subId = JSON.parse(reqMsg!)[1] as string;

      // Simulate a binding event
      const bindingEvent = Event.create(keyManager, {
        kind: EventKinds.APP_DATA,
        tags: [['d', 'nametag:hash']],
        content: '{}',
        created_at: 2000,
      });
      socket.simulateMessage(JSON.stringify(['EVENT', subId, bindingEvent.toJSON()]));
      socket.simulateMessage(JSON.stringify(['EOSE', subId]));

      const result = await queryPromise;
      expect(result).toBe(keyManager.getPublicKeyHex());
    });

    it('should use setQueryTimeout value', () => {
      client.setQueryTimeout(15000);
      expect(client.getQueryTimeout()).toBe(15000);
    });
  });

  // ==========================================================
  // Feature 9: Disconnect Cleanup [RB]
  // ==========================================================
  describe('Feature 9: Disconnect Cleanup', () => {
    it('should reject all pending OK promises on disconnect', async () => {
      const socket = await connectClient(client);

      const event1 = createTestEvent(keyManager, 'ev1');
      const event2 = createTestEvent(keyManager, 'ev2');
      const p1 = client.publishEvent(event1);
      const p2 = client.publishEvent(event2);

      client.disconnect();

      await expect(p1).rejects.toThrow(/disconnected/);
      await expect(p2).rejects.toThrow(/disconnected/);
    });

    it('should reject all queued events on disconnect', async () => {
      const p1 = client.publishEvent(createTestEvent(keyManager, 'q1'));
      const p2 = client.publishEvent(createTestEvent(keyManager, 'q2'));

      client.disconnect();

      await expect(p1).rejects.toThrow(/disconnected/);
      await expect(p2).rejects.toThrow(/disconnected/);
    });

    it('should close all WebSocket connections', async () => {
      const socket = await connectClient(client);
      client.disconnect();

      expect(socket.closeCode).toBe(1000);
      expect(socket.closeReason).toBe('Client disconnected');
    });

    it('should emit disconnect event for each relay', async () => {
      await connectClient(client, 'wss://relay.example.com');
      const onDisconnect = vi.fn();
      client.addConnectionListener({ onDisconnect });

      client.disconnect();

      expect(onDisconnect).toHaveBeenCalledWith('wss://relay.example.com', 'Client disconnected');
    });

    it('should clear all internal state', async () => {
      await connectClient(client);
      client.subscribe(Filter.builder().kinds(1).build(), { onEvent: vi.fn() });

      client.disconnect();

      expect(client.isConnected()).toBe(false);
      expect(client.getConnectedRelays().size).toBe(0);
    });
  });

  // ==========================================================
  // Feature 17: Configuration Combinations [PW]
  // ==========================================================
  describe('Feature 17: Configuration Combinations', () => {
    const configs = [
      { autoReconnect: true, queryTimeoutMs: 5000, pingIntervalMs: 30000 },
      { autoReconnect: true, queryTimeoutMs: 1000, pingIntervalMs: 0 },
      { autoReconnect: false, queryTimeoutMs: 5000, pingIntervalMs: 0 },
      { autoReconnect: false, queryTimeoutMs: 10000, pingIntervalMs: 30000 },
      { autoReconnect: true, queryTimeoutMs: 30000, pingIntervalMs: 60000 },
      { autoReconnect: false, queryTimeoutMs: 100, pingIntervalMs: 10000 },
    ];

    for (const config of configs) {
      it(`should work with config: autoReconnect=${config.autoReconnect}, queryTimeout=${config.queryTimeoutMs}, ping=${config.pingIntervalMs}`, () => {
        const c = new NostrClient(keyManager, config);
        expect(c.getQueryTimeout()).toBe(config.queryTimeoutMs);
        c.disconnect();
      });
    }
  });

  // ==========================================================
  // Feature 19: Subscription Re-establishment [LC]
  // ==========================================================
  describe('Feature 19: Subscription Re-establishment', () => {
    it('zero subscriptions — nothing to re-establish', async () => {
      vi.useFakeTimers();
      const socket = await connectClient(client);
      socket.simulateClose();

      const newSocket = createMockSocket();
      createWebSocketMock.mockResolvedValueOnce(newSocket);
      await vi.advanceTimersByTimeAsync(1000);
      await flushMicrotasks();
      newSocket.simulateOpen();
      await flushMicrotasks();

      const reqs = newSocket.sentMessages.filter(m => {
        try { return JSON.parse(m)[0] === 'REQ'; } catch { return false; }
      });
      expect(reqs.length).toBe(0);
      vi.useRealTimers();
    });

    it('subscriptions should be re-established after reconnect', async () => {
      vi.useFakeTimers();
      const socket = await connectClient(client);

      client.subscribe(Filter.builder().kinds(1).build(), { onEvent: vi.fn() });
      client.subscribe(Filter.builder().kinds(4).build(), { onEvent: vi.fn() });

      socket.simulateClose();
      const newSocket = createMockSocket();
      createWebSocketMock.mockResolvedValueOnce(newSocket);
      await vi.advanceTimersByTimeAsync(1000);
      await flushMicrotasks();
      newSocket.simulateOpen();
      await flushMicrotasks();

      const reqs = newSocket.sentMessages.filter(m => {
        try { return JSON.parse(m)[0] === 'REQ'; } catch { return false; }
      });
      expect(reqs.length).toBe(2);
      vi.useRealTimers();
    });

    it('unsubscribed subs should NOT be re-established', async () => {
      vi.useFakeTimers();
      const socket = await connectClient(client);

      const sub1 = client.subscribe(Filter.builder().kinds(1).build(), { onEvent: vi.fn() });
      client.subscribe(Filter.builder().kinds(4).build(), { onEvent: vi.fn() });
      client.subscribe(Filter.builder().kinds(14).build(), { onEvent: vi.fn() });
      client.unsubscribe(sub1);

      socket.simulateClose();
      const newSocket = createMockSocket();
      createWebSocketMock.mockResolvedValueOnce(newSocket);
      await vi.advanceTimersByTimeAsync(1000);
      await flushMicrotasks();
      newSocket.simulateOpen();
      await flushMicrotasks();

      const reqs = newSocket.sentMessages.filter(m => {
        try { return JSON.parse(m)[0] === 'REQ'; } catch { return false; }
      });
      expect(reqs.length).toBe(2);
      vi.useRealTimers();
    });
  });

  // ==========================================================
  // Feature 20: Concurrent Operations [EG]
  // ==========================================================
  describe('Feature 20: Concurrent Operations', () => {
    it('should handle many concurrent publishes', async () => {
      const socket = await connectClient(client);

      const promises: Promise<string>[] = [];
      for (let i = 0; i < 50; i++) {
        promises.push(client.publishEvent(createTestEvent(keyManager, `msg${i}`)));
      }

      const eventMessages = socket.sentMessages.filter(m => {
        try { return JSON.parse(m)[0] === 'EVENT'; } catch { return false; }
      });
      expect(eventMessages.length).toBe(50);

      // Resolve all via OK
      for (let i = 0; i < 50; i++) {
        const sentEvent = JSON.parse(eventMessages[i]!)[1];
        socket.simulateMessage(JSON.stringify(['OK', sentEvent.id, true, '']));
      }
      const results = await Promise.all(promises);
      expect(results.length).toBe(50);
    });

    it('should handle rapid subscribe/unsubscribe', async () => {
      await connectClient(client);

      for (let i = 0; i < 50; i++) {
        const subId = client.subscribe(
          Filter.builder().kinds(1).build(),
          { onEvent: vi.fn() }
        );
        client.unsubscribe(subId);
      }

      expect(true).toBe(true);
    });

    it('disconnect while publish is pending rejects the pending promise', async () => {
      await connectClient(client);

      const event = createTestEvent(keyManager);
      const publishPromise = client.publishEvent(event);

      client.disconnect();

      await expect(publishPromise).rejects.toThrow(/disconnected/);
    });
  });

  // ==========================================================
  // Feature 6: NIP-17 via Client [UC]
  // ==========================================================
  describe('Feature 6: NIP-17 via Client', () => {
    it('should send private message via gift wrapping', async () => {
      const socket = await connectClient(client);
      const bob = NostrKeyManager.generate();

      const publishPromise = client.sendPrivateMessage(
        bob.getPublicKeyHex(),
        'Hello Bob'
      );

      const eventMsgs = socket.sentMessages.filter(m => {
        try { return JSON.parse(m)[0] === 'EVENT'; } catch { return false; }
      });
      expect(eventMsgs.length).toBe(1);

      const sentEvent = JSON.parse(eventMsgs[0]!)[1];
      expect(sentEvent.kind).toBe(EventKinds.GIFT_WRAP);
      expect(sentEvent.tags.find((t: string[]) => t[0] === 'p')[1]).toBe(bob.getPublicKeyHex());
      expect(sentEvent.pubkey).not.toBe(keyManager.getPublicKeyHex());

      socket.simulateMessage(JSON.stringify(['OK', sentEvent.id, true, '']));
      await publishPromise;
    });

    it('should send read receipt', async () => {
      const socket = await connectClient(client);
      const bob = NostrKeyManager.generate();

      const publishPromise = client.sendReadReceipt(
        bob.getPublicKeyHex(),
        'event-id-123'
      );

      const eventMsgs = socket.sentMessages.filter(m => {
        try { return JSON.parse(m)[0] === 'EVENT'; } catch { return false; }
      });
      expect(eventMsgs.length).toBe(1);

      const sentEvent = JSON.parse(eventMsgs[0]!)[1];
      expect(sentEvent.kind).toBe(EventKinds.GIFT_WRAP);

      socket.simulateMessage(JSON.stringify(['OK', sentEvent.id, true, '']));
      await publishPromise;
    });

    it('should unwrap a received private message', async () => {
      const bob = NostrKeyManager.generate();

      const { createGiftWrap } = await import('../../src/messaging/nip17.js');
      const giftWrap = createGiftWrap(bob, keyManager.getPublicKeyHex(), 'secret from bob');

      const message = client.unwrapPrivateMessage(giftWrap);

      expect(message.senderPubkey).toBe(bob.getPublicKeyHex());
      expect(message.content).toBe('secret from bob');
    });

    it('should reject sending to unknown nametag', async () => {
      vi.useFakeTimers();
      await connectClient(client);

      const sendPromise = client.sendPrivateMessageToNametag('unknown-user', 'hi');
      // Attach catch handler before advancing timers to prevent unhandled rejection
      let nametagError: Error | undefined;
      sendPromise.catch(e => { nametagError = e; });

      await vi.advanceTimersByTimeAsync(5001);
      await flushMicrotasks();

      expect(nametagError).toBeDefined();
      expect(nametagError!.message).toMatch(/Nametag not found/);
      vi.useRealTimers();
    });
  });

  // ==========================================================
  // Feature 7: Token/Payment via Client [UC]
  // ==========================================================
  describe('Feature 7: Token/Payment via Client', () => {
    it('should create and publish event via createAndPublishEvent', async () => {
      const socket = await connectClient(client);

      const publishPromise = client.createAndPublishEvent({
        kind: EventKinds.TEXT_NOTE,
        tags: [['t', 'test']],
        content: 'published via helper',
      });

      const eventMsgs = socket.sentMessages.filter(m => {
        try { return JSON.parse(m)[0] === 'EVENT'; } catch { return false; }
      });
      expect(eventMsgs.length).toBe(1);

      const sentEvent = JSON.parse(eventMsgs[0]!)[1];
      expect(sentEvent.content).toBe('published via helper');
      expect(sentEvent.pubkey).toBe(keyManager.getPublicKeyHex());

      socket.simulateMessage(JSON.stringify(['OK', sentEvent.id, true, '']));
      await publishPromise;
    });

    it('should publish encrypted DM via publishEncryptedMessage', async () => {
      const socket = await connectClient(client);
      const bob = NostrKeyManager.generate();

      const publishPromise = client.publishEncryptedMessage(
        bob.getPublicKeyHex(),
        'secret message'
      );

      // Poll until the async encryption completes and the event is sent
      let eventMsgs: string[] = [];
      for (let i = 0; i < 50; i++) {
        eventMsgs = socket.sentMessages.filter(m => {
          try { return JSON.parse(m)[0] === 'EVENT'; } catch { return false; }
        });
        if (eventMsgs.length > 0) break;
        await new Promise(r => setTimeout(r, 20));
      }
      expect(eventMsgs.length).toBe(1);

      const sentEvent = JSON.parse(eventMsgs[0]!)[1];
      expect(sentEvent.kind).toBe(EventKinds.ENCRYPTED_DM);
      expect(sentEvent.tags.find((t: string[]) => t[0] === 'p')[1]).toBe(bob.getPublicKeyHex());
      expect(sentEvent.content).not.toBe('secret message');
      expect(sentEvent.content).toContain('?iv=');

      socket.simulateMessage(JSON.stringify(['OK', sentEvent.id, true, '']));
      await publishPromise;
    });
  });
});
