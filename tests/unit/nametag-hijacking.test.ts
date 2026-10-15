/**
 * Tests for nametag hijacking prevention.
 *
 * Verifies the two core anti-hijacking mechanisms:
 * 1. No guessing between authors: when more than one author publishes a legacy
 *    (unmarked) binding for a nametag, resolution returns null — `created_at` is
 *    self-asserted, so it never picks a winner
 * 2. Conflict detection: publishNametagBinding rejects if nametag is claimed by another pubkey
 *
 * These are the critical paths that prevent a malicious actor from overwriting
 * another user's nametag binding on Nostr relays.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NostrClient } from '../../src/client/NostrClient.js';
import { NostrKeyManager } from '../../src/NostrKeyManager.js';
import { createBindingEvent } from '../../src/nametag/NametagBinding.js';
import type { Event } from '../../src/protocol/Event.js';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create a signed binding event for a nametag from a given key manager.
 */
async function createSignedBinding(
  km: NostrKeyManager,
  nametag: string,
  createdAtOverride?: number,
): Promise<Event> {
  const event = await createBindingEvent(km, nametag, km.getPublicKeyHex());
  // These tests exercise the LEGACY (unmarked) resolution path, where a single
  // author resolves and several authors are ambiguous. Strip the UNIP-01 marker
  // so the events take that path; the marked (UNIP-01) resolution is covered in
  // nametag-binding-resolution-determinism.test.ts.
  (event as unknown as { tags: string[][] }).tags = event.tags.filter((t) => t[0] !== 'L');
  // Override created_at for testing ordering.
  // This invalidates the Schnorr signature, so we stub verify() to return true.
  // These tests exercise ordering/resolution logic, not signature verification.
  if (createdAtOverride !== undefined) {
    (event as unknown as { created_at: number }).created_at = createdAtOverride;
  }
  vi.spyOn(event, 'verify').mockReturnValue(true);
  return event;
}

/**
 * Stub the client's subscribe method to deliver given events then EOSE.
 * Deliberately filter-unaware: these tests exercise ordering/resolution logic,
 * not filter construction. Filter correctness is tested separately in nametag.test.ts.
 */
function stubSubscribe(client: NostrClient, events: Event[]): void {
  vi.spyOn(client, 'subscribe').mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (...args: any[]) => {
      const subId = 'test-sub-' + Math.random().toString(36).slice(2, 6);
      // Last arg is always the listener
      const listener = args[args.length - 1];
      setTimeout(() => {
        for (const event of events) {
          listener.onEvent?.(event);
        }
        listener.onEndOfStoredEvents?.();
      }, 0);
      return subId;
    },
  );
}

// =============================================================================
// Tests
// =============================================================================

describe('Nametag hijacking prevention', () => {
  let alice: NostrKeyManager;
  let bob: NostrKeyManager;
  let client: NostrClient;

  beforeEach(() => {
    alice = NostrKeyManager.generate();
    bob = NostrKeyManager.generate();
    client = new NostrClient(alice, { queryTimeoutMs: 1000 });
  });

  afterEach(() => {
    client.disconnect();
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // Ambiguity: queryPubkeyByNametag
  // ===========================================================================

  describe('queryPubkeyByNametag (several legacy authors are ambiguous)', () => {
    it('should return null when two authors publish legacy bindings for the same nametag', async () => {
      // Alice's binding says 1000, Bob's says 2000 — but both are self-asserted,
      // and Bob could just as well have claimed 1.
      const aliceEvent = await createSignedBinding(alice, 'coolname', 1000);
      const bobEvent = await createSignedBinding(bob, 'coolname', 2000);

      stubSubscribe(client, [bobEvent, aliceEvent]);

      const owner = await client.queryPubkeyByNametag('coolname');
      expect(owner).toBeNull();
    });

    it('should return null whatever the delivery order', async () => {
      const aliceEvent = await createSignedBinding(alice, 'target', 1000);
      const bobEvent = await createSignedBinding(bob, 'target', 2000);

      stubSubscribe(client, [aliceEvent, bobEvent]);

      const owner = await client.queryPubkeyByNametag('target');
      expect(owner).toBeNull();
    });

    it('should return null when no binding exists', async () => {
      stubSubscribe(client, []);

      const owner = await client.queryPubkeyByNametag('unclaimed');
      expect(owner).toBeNull();
    });

    it('should return the only pubkey when single binding exists', async () => {
      const aliceEvent = await createSignedBinding(alice, 'solo', 1000);
      stubSubscribe(client, [aliceEvent]);

      const owner = await client.queryPubkeyByNametag('solo');
      expect(owner).toBe(alice.getPublicKeyHex());
    });

    it('should return null under multiple competing legacy bindings', async () => {
      const aliceEvent = await createSignedBinding(alice, 'popular', 1000);

      // Multiple attackers try to claim the same nametag
      const attacker1 = NostrKeyManager.generate();
      const attacker2 = NostrKeyManager.generate();
      const attack1Event = await createSignedBinding(attacker1, 'popular', 1500);
      const attack2Event = await createSignedBinding(attacker2, 'popular', 2000);

      // Relay returns all events in arbitrary order
      stubSubscribe(client, [attack2Event, attack1Event, aliceEvent]);

      const owner = await client.queryPubkeyByNametag('popular');
      expect(owner).toBeNull();
    });
  });

  // ===========================================================================
  // Ambiguity: queryBindingByNametag
  // ===========================================================================

  describe('queryBindingByNametag (extended info)', () => {
    it('should return BindingInfo from the only author', async () => {
      const aliceEvent = await createSignedBinding(alice, 'richinfo', 1000);

      stubSubscribe(client, [aliceEvent]);

      const info = await client.queryBindingByNametag('richinfo');
      expect(info).not.toBeNull();
      expect(info!.transportPubkey).toBe(alice.getPublicKeyHex());
      expect(info!.timestamp).toBe(1000 * 1000); // converted to ms
    });

    it('should return null when two authors publish legacy bindings', async () => {
      const aliceEvent = await createSignedBinding(alice, 'richinfo', 1000);
      const bobEvent = await createSignedBinding(bob, 'richinfo', 2000);

      stubSubscribe(client, [bobEvent, aliceEvent]);

      expect(await client.queryBindingByNametag('richinfo')).toBeNull();
    });

    it('should return null when no binding exists', async () => {
      stubSubscribe(client, []);

      const info = await client.queryBindingByNametag('ghost');
      expect(info).toBeNull();
    });
  });

  // ===========================================================================
  // Same-author latest-wins: updated binding returned over stale one
  // ===========================================================================

  describe('same-author latest-wins', () => {
    it('queryBindingByNametag should return latest event from the rightful owner', async () => {
      // Alice publishes an initial binding (timestamp 1000), then updates it (timestamp 2000)
      const aliceOld = await createSignedBinding(alice, 'evolving', 1000);
      const aliceNew = await createSignedBinding(alice, 'evolving', 2000);
      // Override content to distinguish old vs new
      (aliceNew as unknown as { content: string }).content = JSON.stringify({
        nametag_hash: 'hash',
        address: alice.getPublicKeyHex(),
        verified: Date.now(),
        nametag: 'evolving',
        public_key: '02' + 'b'.repeat(64),
        l1_address: 'alpha1updated',
      });

      // Relay returns both (old first)
      stubSubscribe(client, [aliceOld, aliceNew]);

      const info = await client.queryBindingByNametag('evolving');
      expect(info).not.toBeNull();
      expect(info!.transportPubkey).toBe(alice.getPublicKeyHex());
      // Should return the LATEST event's data (timestamp 2000)
      expect(info!.timestamp).toBe(2000 * 1000);
      expect(info!.l1Address).toBe('alpha1updated');
    });

    it('queryBindingByNametag should return null when another author is also present', async () => {
      // Alice: old binding at 1000, updated at 3000; Bob's binding says 2000.
      const aliceOld = await createSignedBinding(alice, 'contested', 1000);
      const aliceNew = await createSignedBinding(alice, 'contested', 3000);
      const bobEvent = await createSignedBinding(bob, 'contested', 2000);

      stubSubscribe(client, [bobEvent, aliceNew, aliceOld]);

      // Alice's extra event does not make her more of an owner: two authors.
      expect(await client.queryBindingByNametag('contested')).toBeNull();
    });

    it('queryBindingByAddress should return latest event from same author', async () => {
      // Simulate: wallet created without nametag (timestamp 1000), then nametag added (timestamp 2000)
      // Both events share the same address tag
      const bareEvent = await createSignedBinding(alice, 'lookup', 1000);
      const fullEvent = await createSignedBinding(alice, 'lookup', 2000);
      (fullEvent as unknown as { content: string }).content = JSON.stringify({
        nametag_hash: 'hash',
        address: alice.getPublicKeyHex(),
        verified: Date.now(),
        nametag: 'lookup',
        public_key: '02' + 'c'.repeat(64),
        l1_address: 'alpha1full',
        direct_address: 'DIRECT://full',
      });

      stubSubscribe(client, [bareEvent, fullEvent]);

      const info = await client.queryBindingByAddress(alice.getPublicKeyHex());
      expect(info).not.toBeNull();
      // Should return the LATEST (most complete) event
      expect(info!.timestamp).toBe(2000 * 1000);
      expect(info!.nametag).toBe('lookup');
      expect(info!.l1Address).toBe('alpha1full');
    });

    it('queryPubkeyByNametag should resolve one author with several events', async () => {
      const alice1 = await createSignedBinding(alice, 'multiauth', 1000);
      const alice2 = await createSignedBinding(alice, 'multiauth', 3000);

      stubSubscribe(client, [alice2, alice1]);

      const owner = await client.queryPubkeyByNametag('multiauth');
      expect(owner).toBe(alice.getPublicKeyHex());
    });
  });

  // ===========================================================================
  // Conflict detection: publishNametagBinding
  // ===========================================================================

  describe('publishNametagBinding (conflict detection)', () => {
    it('should throw when nametag is already claimed by another pubkey', async () => {
      // Alice already owns the nametag on the relay
      const aliceEvent = await createSignedBinding(alice, 'taken', 1000);

      // Bob's client queries the relay → finds Alice's binding
      const bobClient = new NostrClient(bob, { queryTimeoutMs: 1000 });
      stubSubscribe(bobClient, [aliceEvent]);

      // Bob tries to publish → should throw
      await expect(
        bobClient.publishNametagBinding('taken', bob.getPublicKeyHex()),
      ).rejects.toThrow('already claimed');

      bobClient.disconnect();
    });

    it('should throw when two other authors contest the nametag', async () => {
      // Contested resolves to null, but null here does not mean "available".
      const aliceEvent = await createSignedBinding(alice, 'contested', 1000);
      const bobEvent = await createSignedBinding(bob, 'contested', 2000);

      const carol = NostrKeyManager.generate();
      const carolClient = new NostrClient(carol, { queryTimeoutMs: 1000 });
      stubSubscribe(carolClient, [aliceEvent, bobEvent]);
      const publishSpy = vi.spyOn(carolClient, 'publishEvent').mockResolvedValue('event-id');

      await expect(
        carolClient.publishNametagBinding('contested', carol.getPublicKeyHex()),
      ).rejects.toThrow('already claimed');
      expect(publishSpy).not.toHaveBeenCalled();

      carolClient.disconnect();
    });

    it('should succeed when the publisher is one of the contesting authors', async () => {
      // Lets a legacy owner republish (e.g. migrate to a marked binding) even
      // when someone else has published a competing legacy binding.
      const aliceEvent = await createSignedBinding(alice, 'contested', 1000);
      const bobEvent = await createSignedBinding(bob, 'contested', 2000);
      stubSubscribe(client, [aliceEvent, bobEvent]);
      vi.spyOn(client, 'publishEvent').mockResolvedValue('event-id');

      await expect(client.publishNametagBinding('contested', alice.getPublicKeyHex())).resolves.toBe(true);
    });

    it('should succeed when nametag is unclaimed', async () => {
      // No events on relay
      stubSubscribe(client, []);
      // Mock publishEvent to succeed
      vi.spyOn(client, 'publishEvent').mockResolvedValue('event-id');

      const result = await client.publishNametagBinding(
        'fresh',
        alice.getPublicKeyHex(),
      );
      expect(result).toBe(true);
    });

    it('should succeed when same pubkey re-publishes (update)', async () => {
      // Alice already has a binding
      const aliceEvent = await createSignedBinding(alice, 'mine', 1000);
      stubSubscribe(client, [aliceEvent]);
      vi.spyOn(client, 'publishEvent').mockResolvedValue('event-id');

      // Alice re-publishes (e.g., updating address info) → should succeed
      const result = await client.publishNametagBinding(
        'mine',
        alice.getPublicKeyHex(),
      );
      expect(result).toBe(true);
    });

    it('should pass identity params through to the binding event', async () => {
      stubSubscribe(client, []);
      const publishSpy = vi.spyOn(client, 'publishEvent').mockResolvedValue('event-id');

      await client.publishNametagBinding(
        'withident',
        alice.getPublicKeyHex(),
        {
          publicKey: '02' + 'a'.repeat(64),
          l1Address: 'alpha1test',
          directAddress: 'DIRECT://test',
        },
      );

      // Verify the published event contains identity fields in content
      expect(publishSpy).toHaveBeenCalledTimes(1);
      const publishedEvent = publishSpy.mock.calls[0][0];
      const content = JSON.parse((publishedEvent as unknown as { content: string }).content);
      expect(content.public_key).toBe('02' + 'a'.repeat(64));
      expect(content.l1_address).toBe('alpha1test');
      expect(content.direct_address).toBe('DIRECT://test');
    });
  });

  // ===========================================================================
  // End-to-end hijacking scenario
  // ===========================================================================

  describe('end-to-end hijacking scenario', () => {
    it('Alice registers a legacy binding, Bob publishes one too, resolution never returns Bob', async () => {
      // Step 1: Alice publishes her legacy binding (timestamp 1000)
      const aliceEvent = await createSignedBinding(alice, 'alice', 1000);

      // Step 2: Bob (attacker) publishes a legacy binding for the same nametag.
      // Unmarked bindings are not relay-vetted, so nothing stops him.
      const bobEvent = await createSignedBinding(bob, 'alice', 2000);

      // Step 3: Both events exist on the relay. Nothing the client can see tells
      // the real owner apart, so resolution refuses rather than sending to Bob.
      const resolver = new NostrClient(NostrKeyManager.generate(), { queryTimeoutMs: 1000 });
      stubSubscribe(resolver, [bobEvent, aliceEvent]);

      const resolvedPubkey = await resolver.queryPubkeyByNametag('alice');
      expect(resolvedPubkey).toBeNull();

      resolver.disconnect();
    });

    it('Bob cannot publish if Alice already claimed the nametag', async () => {
      const aliceEvent = await createSignedBinding(alice, 'protected', 1000);

      // Bob's client sees Alice's existing binding
      const bobClient = new NostrClient(bob, { queryTimeoutMs: 1000 });
      stubSubscribe(bobClient, [aliceEvent]);

      // Bob's publish attempt is rejected
      await expect(
        bobClient.publishNametagBinding('protected', bob.getPublicKeyHex()),
      ).rejects.toThrow('already claimed');

      // Meanwhile, resolution still returns Alice
      vi.restoreAllMocks();
      vi.spyOn(aliceEvent, 'verify').mockReturnValue(true);
      stubSubscribe(bobClient, [aliceEvent]);
      const owner = await bobClient.queryPubkeyByNametag('protected');
      expect(owner).toBe(alice.getPublicKeyHex());

      bobClient.disconnect();
    });
  });
});
