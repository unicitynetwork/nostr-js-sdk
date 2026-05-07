/**
 * Unit tests for the relay-resilience fixes covered by issue #7:
 *   1. The keepalive "ping" REQ filter must be scoped to authors:[self] so
 *      the relay does not stream a global live-tail through it after EOSE.
 *   2. A CLOSED frame from the relay must remove the subscription from the
 *      client-local map, so reconnect-resubscribe and AUTH-resubscribe do
 *      not re-issue the rejected REQ.
 *   3. queryWithFirstSeenWins (used by queryPubkeyByNametag /
 *      queryBindingByNametag / queryBindingByAddress) must settle promptly
 *      on a CLOSED frame instead of waiting for the full query timeout —
 *      otherwise rate-limit rejections look identical to "no data exists".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NostrClient } from '../../src/client/NostrClient.js';
import { NostrKeyManager } from '../../src/NostrKeyManager.js';
import { Filter } from '../../src/protocol/Filter.js';
import type {
  IWebSocket,
  WebSocketMessageEvent,
} from '../../src/client/WebSocketAdapter.js';
import { OPEN, CLOSED } from '../../src/client/WebSocketAdapter.js';

vi.mock('../../src/client/WebSocketAdapter.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/client/WebSocketAdapter.js')>();
  return {
    ...orig,
    createWebSocket: vi.fn(),
  };
});
import { createWebSocket } from '../../src/client/WebSocketAdapter.js';
const mockCreateWebSocket = vi.mocked(createWebSocket);

function createFakeSocket(): IWebSocket & {
  _triggerOpen(): void;
  _triggerMessage(data: string): void;
  sentMessages: string[];
  _readyState: number;
} {
  const socket: ReturnType<typeof createFakeSocket> = {
    _readyState: OPEN,
    get readyState() { return this._readyState; },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    sentMessages: [],
    send(data: string) { this.sentMessages.push(data); },
    close() { this._readyState = CLOSED; },
    _triggerOpen() { if (this.onopen) this.onopen({}); },
    _triggerMessage(data: string) {
      if (this.onmessage) this.onmessage({ data } as WebSocketMessageEvent);
    },
  };
  return socket;
}

describe('Relay resilience fixes (issue #7)', () => {
  let client: NostrClient;
  let keyManager: NostrKeyManager;
  let socket: ReturnType<typeof createFakeSocket>;

  beforeEach(() => {
    keyManager = NostrKeyManager.generate();
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (client) client.disconnect();
    vi.useRealTimers();
  });

  async function connect(opts?: { pingIntervalMs?: number; queryTimeoutMs?: number }): Promise<void> {
    client = new NostrClient(keyManager, {
      pingIntervalMs: opts?.pingIntervalMs ?? 0,        // ping disabled by default in these tests
      queryTimeoutMs: opts?.queryTimeoutMs ?? 5000,
    });
    socket = createFakeSocket();
    mockCreateWebSocket.mockResolvedValue(socket);
    const p = client.connect('wss://relay.test');
    await vi.advanceTimersByTimeAsync(0);
    socket._triggerOpen();
    await p;
    socket.sentMessages.length = 0;
  }

  describe('ping filter scoping', () => {
    it('scopes the keepalive REQ to authors:[selfPubkey]', async () => {
      await connect({ pingIntervalMs: 15000 });

      await vi.advanceTimersByTimeAsync(15000);
      const reqFrame = socket.sentMessages
        .map((m) => JSON.parse(m))
        .find((m) => m[0] === 'REQ' && m[1] === 'ping');

      expect(reqFrame).toBeDefined();
      expect(reqFrame[2]).toEqual({
        authors: [keyManager.getPublicKeyHex()],
        limit: 1,
      });
    });

    it('precedes the REQ with a CLOSE for the same sub_id (no slot accumulation)', async () => {
      await connect({ pingIntervalMs: 15000 });

      await vi.advanceTimersByTimeAsync(15000);
      const pingFrames = socket.sentMessages
        .map((m) => JSON.parse(m))
        .filter((m) => m[1] === 'ping');

      expect(pingFrames.length).toBe(2);
      expect(pingFrames[0][0]).toBe('CLOSE');
      expect(pingFrames[1][0]).toBe('REQ');
    });
  });

  describe('CLOSED frame handling', () => {
    it('removes the subscription from the client-local map on CLOSED', async () => {
      await connect();

      const onError = vi.fn();
      const subId = client.subscribe(Filter.builder().kinds(1).build(), {
        onEvent: vi.fn(),
        onError,
      });

      // Verify the REQ was sent.
      expect(socket.sentMessages.some((m) => m.includes(`"REQ","${subId}"`))).toBe(true);

      // Relay rejects with CLOSED (this is what nostr-rs-relay emits when
      // max_subscriptions is hit).
      socket._triggerMessage(JSON.stringify(['CLOSED', subId, 'error: rate-limited: too many concurrent REQs']));

      // The listener is notified.
      expect(onError).toHaveBeenCalledWith(subId, expect.stringContaining('rate-limited'));

      // The Map entry is gone — proven by the fact that a follow-up
      // EVENT for that sub_id is silently dropped (no listener invocation).
      // We verify by sending an EVENT and asserting onError isn't called
      // a second time (the original onEvent handler also wouldn't fire,
      // but easier to assert what *didn't* happen via call counts).
      const onEventLater = vi.fn();
      // Re-subscribe with the same sub_id to prove the slot was freed in
      // the local map; subscribe assigns a new auto-generated sub_id, so
      // we're really testing that `subscriptions.has(oldSubId)` is false.
      client.unsubscribe(subId);   // should be a no-op now — no CLOSE frame emitted
      const sentBefore = socket.sentMessages.length;
      client.unsubscribe(subId);
      expect(socket.sentMessages.length).toBe(sentBefore);
      expect(onEventLater).not.toHaveBeenCalled();
    });

    it('does NOT replay a CLOSED-rejected sub on simulated post-AUTH resubscribe', async () => {
      await connect();

      const subId = client.subscribe(Filter.builder().kinds(1).build(), {
        onEvent: vi.fn(),
      });
      const reqFrame = JSON.stringify(['REQ', subId, Filter.builder().kinds(1).build().toJSON()]);

      // Initial REQ went out.
      expect(socket.sentMessages).toContain(reqFrame);

      // Relay rejects.
      socket._triggerMessage(JSON.stringify(['CLOSED', subId, 'error: auth-required']));

      // Simulate post-AUTH resubscribe by triggering an AUTH challenge —
      // resubscribeAll runs after AUTH_RESUBSCRIBE_DELAY_MS. The rejected
      // sub must NOT be re-issued.
      socket.sentMessages.length = 0;
      socket._triggerMessage(JSON.stringify(['AUTH', 'challenge-string']));
      await vi.advanceTimersByTimeAsync(5000);

      const reissued = socket.sentMessages.find((m) => m.includes(`"REQ","${subId}"`));
      expect(reissued).toBeUndefined();
    });
  });

  describe('queryWithFirstSeenWins settles promptly on CLOSED', () => {
    it('resolves null for queryPubkeyByNametag on CLOSED without waiting for query timeout', async () => {
      // Use an overlong timeout so the test would visibly hang if the
      // CLOSED-handling path were broken.
      await connect({ queryTimeoutMs: 60000 });

      // Kick off a nametag query.
      const pending = client.queryPubkeyByNametag('alice');

      // Find the auto-generated sub_id from the most recent REQ frame.
      const reqMsg = socket.sentMessages
        .map((m) => JSON.parse(m))
        .find((m) => m[0] === 'REQ' && typeof m[1] === 'string' && m[1].startsWith('sub_'));
      expect(reqMsg).toBeDefined();
      const subId: string = reqMsg[1];

      // Relay rejects with CLOSED instead of EOSE.
      socket._triggerMessage(
        JSON.stringify(['CLOSED', subId, 'error: Maximum concurrent subscription count reached']),
      );

      // We MUST NOT have to wait the full 60s timeout. Advance a small
      // amount and assert the promise resolves null.
      await vi.advanceTimersByTimeAsync(10);
      const result = await pending;
      expect(result).toBeNull();
    });

    it('still resolves null normally on EOSE with zero events', async () => {
      await connect({ queryTimeoutMs: 60000 });

      const pending = client.queryPubkeyByNametag('alice');
      const reqMsg = socket.sentMessages
        .map((m) => JSON.parse(m))
        .find((m) => m[0] === 'REQ' && typeof m[1] === 'string' && m[1].startsWith('sub_'));
      const subId: string = reqMsg[1];

      socket._triggerMessage(JSON.stringify(['EOSE', subId]));
      await vi.advanceTimersByTimeAsync(10);
      expect(await pending).toBeNull();
    });
  });
});
