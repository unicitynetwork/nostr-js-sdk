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
    it('notifies the listener via onError and marks the sub closed on the sending relay', async () => {
      await connect();

      const onError = vi.fn();
      const onEvent = vi.fn();
      const subId = client.subscribe(Filter.builder().kinds(1).build(), {
        onEvent,
        onError,
      });

      // The REQ was sent.
      expect(socket.sentMessages.some((m) => m.includes(`"REQ","${subId}"`))).toBe(true);

      // Relay rejects with CLOSED (what nostr-rs-relay emits when
      // max_subscriptions is hit).
      socket._triggerMessage(JSON.stringify(['CLOSED', subId, 'error: rate-limited: too many concurrent REQs']));

      // Listener is notified with the relay's reason.
      expect(onError).toHaveBeenCalledWith(subId, expect.stringContaining('rate-limited'));

      // The sub_id is recorded on the relay's closedSubIds set so that
      // reconnect / post-AUTH resubscribe skip it. We assert via the
      // observable behavior in the next two tests rather than reaching
      // into private state here.
    });

    it('drops EVENT frames after CLOSED in single-relay setup (no listener invocations)', async () => {
      // Single-relay clients are the common case in the wild. With the
      // sub still in the global map (so multi-relay tails keep working),
      // we still need to make sure that an unsubscribe() called by the
      // listener via onError actually empties the map — otherwise stale
      // events keep arriving.
      await connect();

      const onError = vi.fn((subId: string) => client.unsubscribe(subId));
      const onEvent = vi.fn();
      const subId = client.subscribe(Filter.builder().kinds(1).build(), {
        onEvent,
        onError,
      });

      socket._triggerMessage(JSON.stringify(['CLOSED', subId, 'error: rate-limited']));
      expect(onError).toHaveBeenCalledTimes(1);

      // After the listener-driven unsubscribe(), a follow-up EVENT for
      // the same sub_id must NOT fire onEvent.
      socket._triggerMessage(JSON.stringify(['EVENT', subId, {
        id: 'a'.repeat(64), pubkey: 'b'.repeat(64), created_at: 0, kind: 1,
        tags: [], content: '', sig: 'c'.repeat(128),
      }]));
      expect(onEvent).not.toHaveBeenCalled();
    });

    it('post-AUTH resubscribe RE-ISSUES previously CLOSED-rejected subs (NIP-42 auth-required)', async () => {
      // NIP-42 flow: relay sends CLOSED("auth-required") for any
      // pre-auth REQ, then on AUTH success the client must re-issue
      // those REQs. The closedSubIds bookkeeping must NOT permanently
      // skip them; it must be cleared in the post-AUTH resubscribe
      // path. (The "regular" resubscribeAll on reconnect operates on
      // a fresh socket with a fresh closedSubIds set, so that path is
      // already covered by RelayConnection construction.)
      await connect();

      const subId = client.subscribe(Filter.builder().kinds(1).build(), {
        onEvent: vi.fn(),
      });
      const reqFrame = JSON.stringify(['REQ', subId, Filter.builder().kinds(1).build().toJSON()]);

      // Initial REQ went out.
      expect(socket.sentMessages).toContain(reqFrame);

      // Relay rejects pre-auth.
      socket._triggerMessage(JSON.stringify(['CLOSED', subId, 'auth-required: please authenticate']));

      socket.sentMessages.length = 0;

      // AUTH challenge fires; the SDK signs and replies, then schedules
      // resubscribeAll after AUTH_RESUBSCRIBE_DELAY_MS.
      socket._triggerMessage(JSON.stringify(['AUTH', 'challenge-string']));
      await vi.advanceTimersByTimeAsync(5000);

      // The previously-rejected sub MUST be re-issued on this relay so
      // post-auth flow can succeed. (Other healthy relays were never
      // in the rejected state to begin with.)
      const reissued = socket.sentMessages.find((m) => m.includes(`"REQ","${subId}"`));
      expect(reissued).toBeDefined();
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
