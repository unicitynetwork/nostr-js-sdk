/**
 * End-to-end tests for the relay-resilience fixes (issue #7) against the
 * live testnet relay at wss://nostr-relay.testnet.unicity.network.
 *
 * Each test connects with a fresh keypair so it cannot collide with other
 * sessions and so the keepalive sub_id "ping" gets a deterministic
 * authors:[selfPubkey] filter.
 *
 * These tests are skipped automatically by the default vitest config
 * (which excludes tests/integration/**); run them with
 *   npm run test:integration -- relay-fixes-e2e
 * or
 *   RELAY_URL=wss://other-relay vitest run tests/integration/relay-fixes-e2e.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NostrClient } from '../../src/client/NostrClient.js';
import { NostrKeyManager } from '../../src/NostrKeyManager.js';

const RELAY_URL = process.env.RELAY_URL ?? 'wss://nostr-relay.testnet.unicity.network';
// Known nametag with a published binding on testnet, used as a positive
// control for queryPubkeyByNametag.
const KNOWN_NAMETAG = 'unichess';
// Long random string that will not collide with any registered nametag.
const UNREGISTERED_NAMETAG = `e2e-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

describe('E2E: relay resilience fixes (issue #7)', () => {
  let client: NostrClient;

  beforeEach(() => {
    client = new NostrClient(NostrKeyManager.generate(), {
      // Short ping interval so we can exercise the keepalive REQ shape
      // without hanging the test runner.
      pingIntervalMs: 2000,
      queryTimeoutMs: 8000,
      autoReconnect: false,
    });
  });

  afterEach(() => {
    try { client.disconnect(); } catch { /* ignore */ }
  });

  it('queryPubkeyByNametag resolves a known nametag from the live relay', async () => {
    await client.connect(RELAY_URL);

    const start = Date.now();
    const pubkey = await client.queryPubkeyByNametag(KNOWN_NAMETAG);
    const elapsed = Date.now() - start;

    expect(pubkey).toBeTruthy();
    expect(pubkey).toMatch(/^[0-9a-f]{64}$/);
    // Should not require the full queryTimeoutMs.
    expect(elapsed).toBeLessThan(6000);
  }, 20_000);

  it('queryPubkeyByNametag returns null for an unregistered nametag without hanging', async () => {
    await client.connect(RELAY_URL);

    const start = Date.now();
    const pubkey = await client.queryPubkeyByNametag(UNREGISTERED_NAMETAG);
    const elapsed = Date.now() - start;

    expect(pubkey).toBeNull();
    // EOSE should arrive quickly for a tag-indexed lookup with zero
    // matches. We give some slack for relay latency but this should not
    // approach the 8s queryTimeoutMs.
    expect(elapsed).toBeLessThan(7500);
  }, 20_000);

  it('keepalive REQ on the live relay does NOT trigger a global event firehose', async () => {
    // We connect for real, then reach into the SDK's per-relay socket
    // and wrap its send() method to capture exactly what goes on the
    // wire. This is more reliable than monkey-patching the `ws`
    // module because the SDK's WebSocketAdapter dynamically imports
    // `ws`, and the prototype we'd patch via a top-level `import` may
    // not be the same instance.

    await client.connect(RELAY_URL);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const relays: Map<string, { socket: { send: (msg: string) => void } }> = (client as any).relays;
    const relay = relays.get(RELAY_URL);
    expect(relay).toBeDefined();

    const sentFrames: string[] = [];
    const origSend = relay!.socket.send.bind(relay!.socket);
    relay!.socket.send = (msg: string) => {
      sentFrames.push(msg);
      return origSend(msg);
    };

    // Wait for at least one ping cycle (pingIntervalMs is 2000, so 2.5s
    // gives one tick comfortably even under timer skew).
    await new Promise((r) => setTimeout(r, 2500));

    // Also count any incoming events on sub_id "ping" — if the live tail
    // is firehose'd, we'll see them within this window.
    let pingEventCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onmessage = (relay!.socket as any).onmessage as ((e: { data: string }) => void) | null;
    if (onmessage) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (relay!.socket as any).onmessage = (e: { data: string }) => {
        try {
          const frame = JSON.parse(e.data);
          if (Array.isArray(frame) && frame[0] === 'EVENT' && frame[1] === 'ping') {
            pingEventCount++;
          }
        } catch { /* ignore */ }
        onmessage(e);
      };
    }
    // Wait another full ping cycle so we actually have a chance to
    // receive the live-tail firehose if it were broken.
    await new Promise((r) => setTimeout(r, 2500));

    const pingReqFrame = sentFrames
      .map((m) => { try { return JSON.parse(m); } catch { return undefined; } })
      .find((m) => Array.isArray(m) && m[0] === 'REQ' && m[1] === 'ping') as unknown[] | undefined;

    expect(pingReqFrame).toBeDefined();
    expect(pingReqFrame![0]).toBe('REQ');
    expect(pingReqFrame![1]).toBe('ping');

    const filter = pingReqFrame![2] as { authors?: string[]; limit?: number };
    expect(filter.authors).toBeDefined();
    expect(Array.isArray(filter.authors)).toBe(true);
    expect(filter.authors!.length).toBe(1);
    expect(filter.authors![0]).toMatch(/^[0-9a-f]{64}$/);
    expect(filter.limit).toBe(1);
    expect((filter as Record<string, unknown>).kinds).toBeUndefined();
    expect((filter as Record<string, unknown>)['#p']).toBeUndefined();

    // Critical regression check: with the broken `{limit:1}` filter,
    // the relay would be streaming kind-1059 / 31113 events through
    // sub_id "ping" continuously (≈10/s). With the scoped filter,
    // there should be 0 (or at most a single own-publish on first
    // cycle; we use a fresh keypair so that case is excluded).
    expect(pingEventCount).toBe(0);
  }, 30_000);

  it('CLOSED frame from relay settles a query without consuming the full timeout', async () => {
    // We can't reliably trip the relay's per-connection sub limit from a
    // unit test, so we exercise the same code path by rapidly opening a
    // tightly-scoped query, then injecting a synthetic CLOSED frame at
    // the WebSocketAdapter level by reaching into the SDK's relay map.
    //
    // This proves the wiring (queryWithFirstSeenWins surfaces CLOSED →
    // settles) end-to-end against a real connection. The pure filter /
    // protocol behavior is already covered by the unit test.
    await client.connect(RELAY_URL);

    // Kick off a query the relay would have to crawl indexes for.
    const queryStart = Date.now();
    const queryPromise = client.queryPubkeyByNametag(UNREGISTERED_NAMETAG);

    // Reach into the client to find the auto-generated sub_id for this
    // query and inject a CLOSED frame as if the relay sent it. This is
    // the exact wire path that fires under max_subscriptions exhaustion.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subs: Map<string, unknown> = (client as any).subscriptions;
    const querySubId = Array.from(subs.keys()).find((k) => k.startsWith('sub_'));
    expect(querySubId).toBeDefined();

    // Pull the live relay socket and drive a CLOSED message at it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const relays: Map<string, { socket: { onmessage?: (e: { data: string }) => void } }> = (client as any).relays;
    const relay = relays.get(RELAY_URL);
    expect(relay).toBeDefined();
    expect(relay!.socket.onmessage).toBeDefined();

    relay!.socket.onmessage!({
      data: JSON.stringify(['CLOSED', querySubId, 'error: Maximum concurrent subscription count reached']),
    });

    const result = await queryPromise;
    const elapsed = Date.now() - queryStart;

    expect(result).toBeNull();
    // Should resolve nearly immediately after CLOSED, NOT wait for the
    // full queryTimeoutMs.
    expect(elapsed).toBeLessThan(2000);

    // And the rejected sub must be cleaned up so resubscribeAll cannot
    // re-issue it on a future reconnect.
    expect(subs.has(querySubId!)).toBe(false);
  }, 20_000);
});
