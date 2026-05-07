/**
 * Unit tests for the relay-resilience fixes covered by issue #7:
 *   1. The keepalive "ping" REQ filter must be scoped to authors:[self] so
 *      the relay does not stream a global live-tail through it after EOSE.
 *   2. A CLOSED frame from the relay must surface to the listener via
 *      onError and be recorded on the *sending* relay's closedSubIds, so
 *      resubscribeAll / post-AUTH resubscribe skip it on that relay only.
 *      The global subscriptions map is intentionally NOT modified —
 *      multi-relay clients may still have the same sub_id alive on a
 *      healthy relay; listener-driven unsubscribe() is what cleans the
 *      global entry across all relays.
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
  _triggerClose(code?: number, reason?: string): void;
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
    close(code?: number, reason?: string) {
      this._readyState = CLOSED;
      if (this.onclose) this.onclose({ code: code ?? 1000, reason: reason ?? '' });
    },
    _triggerOpen() { if (this.onopen) this.onopen({}); },
    _triggerMessage(data: string) {
      if (this.onmessage) this.onmessage({ data } as WebSocketMessageEvent);
    },
    _triggerClose(code = 1006, reason = '') {
      this._readyState = CLOSED;
      if (this.onclose) this.onclose({ code, reason });
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

  describe('connection-timeout race', () => {
    it('discards a socket that arrives AFTER the connection timeout (no orphan relay)', async () => {
      // Self-audit + Copilot review: createWebSocket can resolve
      // after CONNECTION_TIMEOUT_MS has fired and the outer promise
      // has rejected. Without the fix, the late-arriving socket
      // would still register in this.relays, start a pingTimer,
      // resubscribeAll, etc. — orphan resources the caller can't
      // see (their connect() saw a rejection).
      client = new NostrClient(keyManager, { pingIntervalMs: 0 });

      // Pin the socket creation so it never resolves until we say.
      let socketResolver!: (s: typeof socket) => void;
      const pendingSocketPromise = new Promise<typeof socket>((res) => {
        socketResolver = res;
      });
      mockCreateWebSocket.mockImplementation(() => pendingSocketPromise);

      socket = createFakeSocket();
      // Pre-attach a handler so the rejection that fires during
      // `advanceTimersByTimeAsync` is observed immediately and
      // doesn't briefly count as an "unhandled rejection" — Node
      // (and CI) will fail the run otherwise.
      const connectError = client.connect('wss://slow.test').catch((e) => e);

      // Advance past the connection timeout (30s default).
      await vi.advanceTimersByTimeAsync(31_000);
      const err = await connectError;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/timed out/);

      // NOW the socket arrives. The .then guard must close it and
      // skip registration.
      socketResolver(socket);
      await vi.advanceTimersByTimeAsync(0);
      // The fake socket records close() calls via state; we assert
      // it's CLOSED and that no relay was registered for the URL.
      expect(socket._readyState).toBe(CLOSED);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const relays: Map<string, unknown> = (client as any).relays;
      expect(relays.has('wss://slow.test')).toBe(false);
    });

    it('discards a socket whose onopen fires AFTER the timeout (defense in depth)', async () => {
      // Even if createWebSocket resolves before the timeout, onopen
      // can fire after — same orphan-relay concern. The onopen
      // handler must check the timedOut flag too.
      client = new NostrClient(keyManager, { pingIntervalMs: 0 });
      socket = createFakeSocket();
      mockCreateWebSocket.mockResolvedValue(socket);

      // Pre-attach handler — see comment in the previous test.
      const connectError = client.connect('wss://slow.test').catch((e) => e);
      // Resolve createWebSocket but DON'T trigger onopen yet.
      await vi.advanceTimersByTimeAsync(0);
      // Advance past the connection timeout — outer promise rejects,
      // and the timeout closes the still-pending socket.
      await vi.advanceTimersByTimeAsync(31_000);
      const err = await connectError;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/timed out/);

      // Even if the socket somehow fires onopen later (e.g., the
      // timeout's close() didn't take effect), the onopen guard
      // must skip the registration.
      socket._triggerOpen();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const relays: Map<string, unknown> = (client as any).relays;
      expect(relays.has('wss://slow.test')).toBe(false);
    });
  });

  describe('ping filter scoping', () => {
    it('scopes the keepalive REQ to authors:[selfPubkey]', async () => {
      await connect({ pingIntervalMs: 15000 });

      await vi.advanceTimersByTimeAsync(15000);
      const reqFrame = socket.sentMessages
        .map((m) => JSON.parse(m))
        .find((m) => m[0] === 'REQ' && m[1] === '__nostr-sdk-keepalive__');

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
        .filter((m) => m[1] === '__nostr-sdk-keepalive__');

      expect(pingFrames.length).toBe(2);
      expect(pingFrames[0][0]).toBe('CLOSE');
      expect(pingFrames[1][0]).toBe('REQ');
    });
  });

  describe('CLOSED frame handling', () => {
    it('ignores CLOSED for unknown sub_ids (DoS guard)', async () => {
      // A misbehaving or malicious relay can spam CLOSED frames for
      // arbitrary sub_ids the client never subscribed to. Without a
      // guard, those would each grow `closedSubIds` unbounded over a
      // long-lived connection, and could pre-emptively block sub_ids
      // we might use later.
      await connect();

      // Register a real subscription FIRST so onError is wired to
      // something. Then inject a CLOSED for an unrelated, never-
      // registered sub_id. The guard must drop the ghost frame
      // silently — listener for the real sub must NOT be notified
      // (a previous version of this test created the listener
      // unattached, so the assertion was vacuous).
      const onError = vi.fn();
      const realSubId = client.subscribe(Filter.builder().kinds(1).build(), {
        onEvent: vi.fn(),
        onError,
      });

      // Ghost CLOSED for a sub the client never knows about.
      socket._triggerMessage(JSON.stringify(['CLOSED', 'ghost-sub', 'error: rejected']));
      expect(onError).not.toHaveBeenCalled();

      // CLOSED with the real sub_id IS surfaced.
      socket._triggerMessage(JSON.stringify(['CLOSED', realSubId, 'real-rejection']));
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(realSubId, expect.stringContaining('real-rejection'));

      // And: re-subscribing with the formerly-ghost sub_id must
      // work normally (the ID was never blocked in any closedSubIds).
      const onError2 = vi.fn();
      client.subscribe('ghost-sub', Filter.builder().kinds(2).build(), {
        onEvent: vi.fn(),
        onError: onError2,
      });
      socket._triggerMessage(JSON.stringify(['CLOSED', 'ghost-sub', 'now-real']));
      expect(onError2).toHaveBeenCalledTimes(1);
    });

    it('also ignores CLOSED frames where sub_id is non-string (defensive)', async () => {
      await connect();
      const onError = vi.fn();
      client.subscribe(Filter.builder().kinds(1).build(), { onEvent: vi.fn(), onError });
      // Malformed: numeric sub_id.
      socket._triggerMessage(JSON.stringify(['CLOSED', 42, 'whatever']));
      // Malformed: object sub_id.
      socket._triggerMessage(JSON.stringify(['CLOSED', { x: 1 }, 'whatever']));
      expect(onError).not.toHaveBeenCalled();
    });

    it('handleEventMessage drops EVENT frames with non-string sub_id (DoS guard)', async () => {
      await connect();
      const onEvent = vi.fn();
      client.subscribe(Filter.builder().kinds(1).build(), { onEvent });
      // Numeric sub_id — must be silently dropped.
      socket._triggerMessage(JSON.stringify(['EVENT', 42, {
        id: 'a'.repeat(64), pubkey: 'b'.repeat(64), created_at: 0, kind: 1,
        tags: [], content: '', sig: 'c'.repeat(128),
      }]));
      // Object sub_id.
      socket._triggerMessage(JSON.stringify(['EVENT', { x: 1 }, {
        id: 'a'.repeat(64), pubkey: 'b'.repeat(64), created_at: 0, kind: 1,
        tags: [], content: '', sig: 'c'.repeat(128),
      }]));
      expect(onEvent).not.toHaveBeenCalled();
    });

    it('subscribe() wipes stale per-relay EOSE/CLOSED markers for the same sub_id', async () => {
      // Self-audit invariant: a fresh subscribe with a sub_id that was
      // previously CLOSED on some relay must NOT be skipped on that
      // relay. Same for stale EOSE markers — otherwise the new sub
      // would be treated as already-done and queries built on top of
      // it would settle prematurely.
      await connect();

      // Subscribe + relay sends CLOSED → marker set.
      const subId = 'reused-sub';
      client.subscribe(subId, Filter.builder().kinds(1).build(), { onEvent: vi.fn() });
      socket._triggerMessage(JSON.stringify(['CLOSED', subId, 'rate-limited']));
      // Now subscribe again with the same id (fresh listener).
      client.subscribe(subId, Filter.builder().kinds(2).build(), { onEvent: vi.fn() });

      // The second subscribe must have sent a fresh REQ — even though
      // the relay had marked the prior one closed.
      const reqs = socket.sentMessages
        .map((m) => JSON.parse(m))
        .filter((m) => m[0] === 'REQ' && m[1] === subId);
      expect(reqs.length).toBe(2);
      // And the second REQ uses the new filter (kinds:[2]), not the
      // old one — proving it's a real re-subscribe.
      expect(reqs[1][2].kinds).toEqual([2]);
    });

    it('post-AUTH resubscribe clears eosedSubIds (re-arms stale-EOSE state)', async () => {
      // Pre-auth a relay may have EOSE'd a sub with 0 stored events
      // because the filter was unsatisfiable without auth context.
      // Post-auth that's no longer true — the resubscribed REQ
      // might match. We MUST re-arm the local "still waiting" state
      // so any in-flight queryWithFirstSeenWins doesn't see this
      // relay as already-done from a stale eosedSubIds marker.
      await connect();
      const subId = client.subscribe(Filter.builder().kinds(1).build(), { onEvent: vi.fn() });

      socket._triggerMessage(JSON.stringify(['EOSE', subId]));

      socket.sentMessages.length = 0;
      socket._triggerMessage(JSON.stringify(['AUTH', 'challenge-string']));
      await vi.advanceTimersByTimeAsync(5000);

      // Post-AUTH: the previously-EOSE'd sub MUST be re-issued.
      const reissued = socket.sentMessages.find((m) => m.includes(`"REQ","${subId}"`));
      expect(reissued).toBeDefined();
    });

    it('post-AUTH resubscribe SKIPS terminally-rejected subs (rate-limit stays blocked)', async () => {
      // Counterpart invariant. closedSubIds populated by terminal
      // rejections (rate-limited, blocked, etc.) MUST persist across
      // AUTH success — AUTH doesn't relax those rejections, and
      // re-issuing them would just trigger the same rejection in a
      // loop. Auth-required CLOSEDs aren't in this set in the first
      // place (handleClosedMessage skips them as transient).
      await connect();
      const goodSubId = client.subscribe(Filter.builder().kinds(1).build(), { onEvent: vi.fn() });
      const badSubId = client.subscribe(Filter.builder().kinds(2).build(), { onEvent: vi.fn() });

      // Terminal rejection lands in closedSubIds.
      socket._triggerMessage(JSON.stringify(['CLOSED', badSubId, 'rate-limited: too many']));

      socket.sentMessages.length = 0;
      socket._triggerMessage(JSON.stringify(['AUTH', 'challenge-string']));
      await vi.advanceTimersByTimeAsync(5000);

      // Post-AUTH: goodSubId IS re-issued; badSubId is NOT.
      const goodReissued = socket.sentMessages.find((m) => m.includes(`"REQ","${goodSubId}"`));
      const badReissued = socket.sentMessages.find((m) => m.includes(`"REQ","${badSubId}"`));
      expect(goodReissued).toBeDefined();
      expect(badReissued).toBeUndefined();
    });

    it('accepts truncated ["CLOSED", subId] frames with a default reason', async () => {
      // NIP-01 makes the message field optional. The handler must
      // notify the listener AND mark the sub closed on the sending
      // relay even when the reason is missing — otherwise queries
      // hang to timeout and resubscribe loops persist.
      await connect();

      const onError = vi.fn();
      const subId = client.subscribe(Filter.builder().kinds(1).build(), {
        onEvent: vi.fn(),
        onError,
      });

      socket._triggerMessage(JSON.stringify(['CLOSED', subId])); // no reason

      expect(onError).toHaveBeenCalledWith(subId, expect.stringContaining('no reason provided'));
    });

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

  describe('multi-relay query: settle only when all relays are done', () => {
    it('does NOT settle on first EOSE when a second relay is still streaming', async () => {
      // Two fake sockets — one fast EOSE, one slow with matching events.
      const socketA = createFakeSocket();
      const socketB = createFakeSocket();
      mockCreateWebSocket.mockResolvedValueOnce(socketA);
      mockCreateWebSocket.mockResolvedValueOnce(socketB);

      client = new NostrClient(keyManager, {
        pingIntervalMs: 0,
        queryTimeoutMs: 60_000,
      });
      const cp = Promise.all([
        client.connect('wss://a.test'),
        client.connect('wss://b.test'),
      ]);
      await vi.advanceTimersByTimeAsync(0);
      socketA._triggerOpen();
      socketB._triggerOpen();
      await cp;

      const pending = client.queryPubkeyByNametag('alice');

      // Find the sub_id from socketA's REQ frame (both got the same id).
      const reqA = socketA.sentMessages
        .map((m) => JSON.parse(m))
        .find((m) => m[0] === 'REQ' && typeof m[1] === 'string' && m[1].startsWith('sub_'));
      const subId: string = reqA[1];

      // Relay A finishes immediately with no events.
      socketA._triggerMessage(JSON.stringify(['EOSE', subId]));
      await vi.advanceTimersByTimeAsync(10);
      // Promise must NOT resolve yet — relay B hasn't reported.
      let settled = false;
      pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(10);
      expect(settled).toBe(false);

      // Relay B then delivers a matching event followed by EOSE.
      // We need a real signed event for verify() to pass; for this
      // test we just need the future to settle on EOSE — events
      // missing valid signatures are dropped silently.
      socketB._triggerMessage(JSON.stringify(['EOSE', subId]));
      await vi.advanceTimersByTimeAsync(10);
      // Now both relays are done → settle.
      const result = await pending;
      expect(result).toBeNull(); // no events delivered
    });

    it('relay disconnect mid-query triggers a re-check (no timeout wait)', async () => {
      // Self-audit invariant + Copilot review: queryWithFirstSeenWins
      // only re-evaluates allRelaysDoneFor when a listener callback
      // (EOSE / CLOSED → onError) fires. If a relay drops the
      // WebSocket without sending either, the query would otherwise
      // hang until queryTimeoutMs even though the disconnected relay
      // no longer counts toward pending relays. Fix: socket.onclose
      // synthetically fires onError on every active sub.
      await connect({ queryTimeoutMs: 60_000 });
      const pending = client.queryPubkeyByNametag('alice');
      // Verify the REQ went out so we know we're truly mid-query.
      expect(socket.sentMessages.some((m) => m.includes('"REQ","sub_'))).toBe(true);

      // Drop the socket without any EOSE/CLOSED — simulates a
      // network blip. Without the fix, the query hangs to the 60s
      // timeout. With the fix, onclose fires synthetic onError →
      // listener re-checks allRelaysDoneFor → 0 connected → settle.
      socket._triggerClose(1006, 'Network error');

      const result = await pending;
      expect(result).toBeNull();
    });

    it('disconnect() settles in-flight queries immediately (no full timeout wait)', async () => {
      // Self-audit found: prior to this fix, calling disconnect()
      // mid-query left the future unresolved until queryTimeoutMs
      // elapsed. Listeners weren't notified, so allRelaysDoneFor was
      // never re-checked.
      await connect({ queryTimeoutMs: 60_000 });
      const pending = client.queryPubkeyByNametag('alice');
      // Verify the REQ went out so we know we're truly mid-query.
      const reqMsg = socket.sentMessages
        .map((m) => JSON.parse(m))
        .find((m) => m[0] === 'REQ' && typeof m[1] === 'string' && m[1].startsWith('sub_'));
      expect(reqMsg).toBeDefined();

      const start = Date.now();
      client.disconnect();
      // Microtask flush — listener fires synchronously inside disconnect.
      const result = await pending;
      // Must be null (no events delivered) and resolved promptly,
      // not after the 60s timeout.
      expect(result).toBeNull();
      // Date.now() with fake timers stays at the same instant; what
      // matters is the promise resolved, which it must have to reach
      // this line.
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it('does NOT settle on auth-required CLOSED — leaves the sub in the global Map for post-AUTH retry', async () => {
      // NIP-42 transient case. Pre-auth relays typically reject REQs
      // with `CLOSED("auth-required:...")` then immediately send an
      // AUTH challenge. resubscribeAfterAuth re-issues the sub —
      // but if we mark closedSubIds and the query settles + calls
      // unsubscribe, the sub is gone from the global Map by the
      // time resubscribe runs, and the query is permanently lost.
      // The fix: skip adding to closedSubIds for auth-required
      // rejections; listener still notified, but no settle.
      await connect({ queryTimeoutMs: 60_000 });

      const pending = client.queryPubkeyByNametag('alice');
      const reqMsg = socket.sentMessages
        .map((m) => JSON.parse(m))
        .find((m) => m[0] === 'REQ' && typeof m[1] === 'string' && m[1].startsWith('sub_'));
      const subId: string = reqMsg[1];

      // Relay rejects pre-auth.
      socket._triggerMessage(JSON.stringify(['CLOSED', subId, 'auth-required: please authenticate']));
      await vi.advanceTimersByTimeAsync(10);

      // Promise must NOT have settled — auth retry might still
      // produce events.
      let settled = false;
      pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(10);
      expect(settled).toBe(false);

      // The sub MUST still be registered in the global Map so that
      // resubscribeAfterAuth can find it and re-issue the REQ.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const subs: Map<string, unknown> = (client as any).subscriptions;
      expect(subs.has(subId)).toBe(true);

      // Now the relay sends AUTH challenge → SDK signs and replies →
      // resubscribeAfterAuth fires after the delay → REQ re-issued.
      socket.sentMessages.length = 0;
      socket._triggerMessage(JSON.stringify(['AUTH', 'challenge-string']));
      await vi.advanceTimersByTimeAsync(5000);
      const reissued = socket.sentMessages.find((m) => m.includes(`"REQ","${subId}"`));
      expect(reissued).toBeDefined();
    });

    it('settles on first CLOSED when only one relay is connected (single-relay back-compat)', async () => {
      // The new "wait for all" rule degenerates to "wait for the only
      // one" with a single relay, so single-relay clients see no
      // behavior change.
      await connect({ queryTimeoutMs: 60_000 });
      const pending = client.queryPubkeyByNametag('alice');
      const reqMsg = socket.sentMessages
        .map((m) => JSON.parse(m))
        .find((m) => m[0] === 'REQ' && typeof m[1] === 'string' && m[1].startsWith('sub_'));
      const subId: string = reqMsg[1];
      socket._triggerMessage(JSON.stringify(['CLOSED', subId, 'rate-limited']));
      await vi.advanceTimersByTimeAsync(10);
      expect(await pending).toBeNull();
    });
  });
});
