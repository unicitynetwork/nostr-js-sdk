/**
 * Two-party end-to-end test: Alice publishes a real token transfer to
 * Bob, Bob's consumer subscription receives it, and Alice's keepalive
 * sub does NOT echo Alice's own publish back.
 *
 * This test runs in two modes:
 *   1. Against a containerised unicity-tokens-relay (default; hermetic).
 *      The image is pulled from
 *      `ghcr.io/unicitynetwork/unicity-tokens-relay:latest`.
 *   2. Against a deployed relay, by setting RELAY_URL=wss://...
 *      Use this for "does my fix actually work in production?" checks.
 *
 *   $ npm run test:integration -- two-party-flow-relay
 *   $ RELAY_URL=wss://nostr-relay.testnet.unicity.network npm run test:integration -- two-party-flow-relay
 *
 * This is the test the previous fix was missing. Earlier coverage
 * asserted the SHAPE of the keepalive REQ filter, then locked in
 * `authors:[self]` as the expected shape — so when that filter was
 * actually wrong (it matched every event the wallet itself published
 * and the relay echoed each one back on the keepalive sub), the tests
 * confirmed the bug rather than catching it. This test asserts
 * BEHAVIOR — what actually arrives on the wire — which is what
 * matters.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { NostrClient } from '../../src/client/NostrClient.js';
import { NostrKeyManager } from '../../src/NostrKeyManager.js';
import { Filter } from '../../src/protocol/Filter.js';
import * as EventKinds from '../../src/protocol/EventKinds.js';
import type { Event } from '../../src/protocol/Event.js';

const RELAY_INTERNAL_PORT = 8080;
const STARTUP_TIMEOUT_MS = 60_000;

// Mode is decided once per test file:
//   - RELAY_URL=wss://...    → use that, skip container startup
//   - (unset)                → spin up the unicity-tokens-relay image
const EXTERNAL_RELAY_URL = process.env.RELAY_URL?.trim();
const USE_CONTAINER = !EXTERNAL_RELAY_URL;

describe('E2E: two-party token transfer + keepalive isolation', () => {
  let container: StartedTestContainer | undefined;
  let relayUrl: string;

  beforeAll(async () => {
    if (USE_CONTAINER) {
      container = await new GenericContainer('ghcr.io/unicitynetwork/unicity-tokens-relay:latest')
        // Force linux/amd64 so the image runs unmodified on Apple
        // Silicon dev machines (the published image only ships an
        // amd64 manifest). Docker Desktop / colima run it under
        // emulation; CI runners on linux/amd64 hit the native path.
        .withPlatform('linux/amd64')
        .withExposedPorts(RELAY_INTERNAL_PORT)
        // Most nostr-rs-relay-style images log a "listening on" line
        // shortly after startup. The permissive log match also covers
        // "ready" / "started" banners; falls back to startup timeout
        // if the image diverges.
        .withWaitStrategy(Wait.forLogMessage(/listening|ready|started/i, 1))
        .withStartupTimeout(STARTUP_TIMEOUT_MS)
        .start();

      const port = container.getMappedPort(RELAY_INTERNAL_PORT);
      relayUrl = `ws://localhost:${port}`;
      // Brief settle delay so the relay's WS upgrade handler is wired
      // before the first connect attempt.
      await new Promise((r) => setTimeout(r, 500));
    } else {
      relayUrl = EXTERNAL_RELAY_URL!;
    }
  }, STARTUP_TIMEOUT_MS + 5_000);

  afterAll(async () => {
    if (container) {
      try { await container.stop(); } catch { /* ignore */ }
    }
  });

  let aliceKeys: NostrKeyManager;
  let bobKeys: NostrKeyManager;
  let alice: NostrClient;
  let bob: NostrClient;

  beforeEach(() => {
    aliceKeys = NostrKeyManager.generate();
    bobKeys = NostrKeyManager.generate();
    // Short ping interval so we cover at least one keepalive REQ
    // cycle in-test without sleeping forever.
    const opts = { pingIntervalMs: 2000, queryTimeoutMs: 8000, autoReconnect: false };
    alice = new NostrClient(aliceKeys, opts);
    bob = new NostrClient(bobKeys, opts);
  });

  afterEach(() => {
    try { alice.disconnect(); } catch { /* ignore */ }
    try { bob.disconnect(); } catch { /* ignore */ }
  });

  it('Alice → Bob token transfer is received and NOT echoed on Alice\'s keepalive sub', async () => {
    await Promise.all([alice.connect(relayUrl), bob.connect(relayUrl)]);

    // Wrap Alice's socket to count any frames the relay sends on her
    // keepalive sub. With a correct filter this stays at 0 even when
    // she publishes events.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aliceRelays: Map<string, { socket: { onmessage: ((e: { data: string }) => void) | null } }> = (alice as any).relays;
    const aliceRelay = aliceRelays.get(relayUrl);
    expect(aliceRelay).toBeDefined();

    let pingEchoCount = 0;
    const origOnMessage = aliceRelay!.socket.onmessage;
    aliceRelay!.socket.onmessage = (e: { data: string }) => {
      try {
        const frame = JSON.parse(e.data);
        if (Array.isArray(frame) && frame[0] === 'EVENT' && frame[1] === '__nostr-sdk-keepalive__') {
          pingEchoCount++;
        }
      } catch { /* ignore non-JSON */ }
      if (origOnMessage) origOnMessage(e);
    };

    // Bob subscribes for incoming token transfers addressed to him.
    let bobReceivedResolve!: (event: Event) => void;
    const bobReceivedPromise = new Promise<Event>((resolve) => {
      bobReceivedResolve = resolve;
    });

    bob.subscribe(
      Filter.builder()
        .kinds(EventKinds.TOKEN_TRANSFER)
        .pTags(bobKeys.getPublicKeyHex())
        .build(),
      {
        onEvent: (event: Event) => bobReceivedResolve(event),
      },
    );

    // Wait for the subscription to settle (relay sends EOSE for the
    // initial empty result set), and for at least one keepalive cycle
    // to fire on Alice so any broken filter would already be live.
    await new Promise((r) => setTimeout(r, 2500));

    // Alice publishes a real token transfer to Bob.
    const tokenJson = JSON.stringify({ probe: 'two-party-flow', ts: Date.now() });
    const eventId = await alice.sendTokenTransfer(bobKeys.getPublicKeyHex(), tokenJson);
    expect(eventId).toMatch(/^[0-9a-f]{64}$/);

    // Bob should receive it within a few seconds.
    const received = await Promise.race([
      bobReceivedPromise,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('Bob did not receive Alice\'s transfer in time')), 8000)),
    ]);
    expect(received.id).toBe(eventId);
    expect(received.kind).toBe(EventKinds.TOKEN_TRANSFER);
    expect(received.pubkey).toBe(aliceKeys.getPublicKeyHex());

    // Wait one more keepalive cycle so any post-publish live-tail
    // delivery would have arrived by now.
    await new Promise((r) => setTimeout(r, 2500));

    // Regression check: the keepalive sub on Alice's connection must
    // not have received any EVENTs. The previous `authors:[self]`
    // filter would have echoed the kind-31113 publish back here.
    expect(pingEchoCount).toBe(0);
  }, 30_000);

  it('Bob → Alice round-trip works while keepalive is active on both', async () => {
    // Symmetric variant: Alice subscribes to events addressed to
    // herself and Bob sends. This catches the scenario where a relay
    // dedupes events across overlapping subs — if Alice's keepalive
    // matched the same event her consumer sub does, on some relays
    // only one sub gets the delivery and the wallet's flow breaks.
    // With the unreachable-id keepalive filter, no overlap is
    // possible.
    await Promise.all([alice.connect(relayUrl), bob.connect(relayUrl)]);

    let resolveReceived!: (event: Event) => void;
    const receivedPromise = new Promise<Event>((resolve) => {
      resolveReceived = resolve;
    });

    alice.subscribe(
      Filter.builder()
        .kinds(EventKinds.TOKEN_TRANSFER)
        .pTags(aliceKeys.getPublicKeyHex())
        .build(),
      {
        onEvent: (event: Event) => resolveReceived(event),
      },
    );

    await new Promise((r) => setTimeout(r, 2500));
    const eventId = await bob.sendTokenTransfer(
      aliceKeys.getPublicKeyHex(),
      JSON.stringify({ probe: 'reverse-direction' }),
    );

    const received = await Promise.race([
      receivedPromise,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('Alice did not receive Bob\'s transfer')), 8000)),
    ]);
    expect(received.id).toBe(eventId);
    expect(received.pubkey).toBe(bobKeys.getPublicKeyHex());
  }, 30_000);
});
