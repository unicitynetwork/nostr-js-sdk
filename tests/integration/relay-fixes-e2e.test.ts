/**
 * End-to-end tests for the relay-resilience fixes (issue #7) against the
 * live testnet relay at wss://nostr-relay.testnet.unicity.network.
 *
 * Each test connects with a fresh keypair so it cannot collide with other
 * sessions and so the keepalive sub gets a deterministic, unreachable
 * filter.
 *
 * The default vitest config excludes tests/integration/**, so these
 * tests do NOT run via `npm test` / `npm run test:unit`. Run them with
 * the integration config:
 *   npm run test:integration -- relay-fixes-e2e
 * or
 *   RELAY_URL=wss://other-relay npm run test:integration -- relay-fixes-e2e
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
  let clientKeys: NostrKeyManager;

  beforeEach(() => {
    clientKeys = NostrKeyManager.generate();
    client = new NostrClient(clientKeys, {
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

    // Wrap BOTH socket.send (to capture the ping REQ shape) AND
    // socket.onmessage (to count any incoming live-tail EVENTs)
    // BEFORE waiting for any ping cycles. The previous version
    // installed the onmessage wrapper after the first 2.5s wait —
    // a buggy `{limit:1}` filter would send live-tail events
    // immediately after the first REQ/EOSE round-trip and those
    // would land before the wrapper was attached, giving a false
    // negative.
    const sentFrames: string[] = [];
    const origSend = relay!.socket.send.bind(relay!.socket);
    relay!.socket.send = (msg: string) => {
      sentFrames.push(msg);
      return origSend(msg);
    };

    let pingEventCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const origOnMessage = (relay!.socket as any).onmessage as ((e: { data: string }) => void) | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (relay!.socket as any).onmessage = (e: { data: string }) => {
      try {
        const frame = JSON.parse(e.data);
        if (Array.isArray(frame) && frame[0] === 'EVENT' && frame[1] === '__nostr-sdk-keepalive__') {
          pingEventCount++;
        }
      } catch { /* ignore */ }
      if (origOnMessage) origOnMessage(e);
    };

    // Wait one ping cycle so the REQ goes out, then publish a real
    // event from this same key. The previous version of this test
    // relied on "fresh keypair publishes nothing, so live tail sees
    // nothing" — that hid the bug where `authors:[self]` matched
    // every event the wallet itself publishes. Now we publish a real
    // kind-31113 event during the second cycle and assert it does NOT
    // come back on the keepalive sub.
    await new Promise((r) => setTimeout(r, 2500));

    // Publish a kind-31113 token-transfer-shaped event from the SAME
    // pubkey driving the keepalive. With the broken filter the relay
    // echoes this back on `__nostr-sdk-keepalive__` within ms.
    const recipientPubkey = NostrKeyManager.generate().getPublicKeyHex();
    await client.sendTokenTransfer(recipientPubkey, JSON.stringify({ probe: 'keepalive-leak-check' }));

    // Wait long enough for at least one more ping cycle and for the
    // relay's live-tail forwarding to fire if the filter were broken.
    await new Promise((r) => setTimeout(r, 3000));

    const pingReqFrame = sentFrames
      .map((m) => { try { return JSON.parse(m); } catch { return undefined; } })
      .find((m) => Array.isArray(m) && m[0] === 'REQ' && m[1] === '__nostr-sdk-keepalive__') as unknown[] | undefined;

    expect(pingReqFrame).toBeDefined();
    expect(pingReqFrame![0]).toBe('REQ');
    expect(pingReqFrame![1]).toBe('__nostr-sdk-keepalive__');

    // Filter must use the unreachable id pattern — NOT authors:[self],
    // which would match every event the wallet itself publishes.
    const filter = pingReqFrame![2] as Record<string, unknown>;
    expect(filter.ids).toEqual(['0'.repeat(64)]);
    expect(filter.limit).toBe(1);
    expect(filter.authors).toBeUndefined();
    expect(filter.kinds).toBeUndefined();
    expect(filter['#p']).toBeUndefined();
    // Defense-in-depth: the wallet pubkey must not appear anywhere in
    // the filter, no matter the encoding.
    expect(JSON.stringify(filter)).not.toContain(clientKeys.getPublicKeyHex());

    // The actual regression check: with the broken `authors:[self]`
    // filter, the kind-31113 publish above would be echoed back on
    // sub_id `__nostr-sdk-keepalive__` (since the wallet is the
    // author). With the unreachable-id filter, the live tail never
    // matches and pingEventCount stays 0.
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
