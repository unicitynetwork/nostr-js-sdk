/**
 * Tests for nametag hijacking prevention.
 *
 * Verifies the two core anti-hijacking mechanisms:
 * 1. First-seen-wins: queryPubkeyByNametag returns the earliest binding author
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
  // First-seen-wins: queryPubkeyByNametag
  // ===========================================================================

  describe('queryPubkeyByNametag (first-seen-wins)', () => {
    it('should return the pubkey of the earliest binding event', async () => {
      // Alice registered first (timestamp 1000), Bob tried later (timestamp 2000)
      const aliceEvent = await createSignedBinding(alice, 'coolname', 1000);
      const bobEvent = await createSignedBinding(bob, 'coolname', 2000);

      // Relay returns both events (order doesn't matter — code picks earliest)
      stubSubscribe(client, [bobEvent, aliceEvent]);

      const owner = await client.queryPubkeyByNametag('coolname');
      expect(owner).toBe(alice.getPublicKeyHex());
    });

    it('should still pick earliest even when attacker event arrives first', async () => {
      // Attacker (Bob) published later but relay delivers his event first
      const aliceEvent = await createSignedBinding(alice, 'target', 1000);
      const bobEvent = await createSignedBinding(bob, 'target', 2000);

      // Bob's event arrives first in the subscription stream
      stubSubscribe(client, [bobEvent, aliceEvent]);

      const owner = await client.queryPubkeyByNametag('target');
      // Alice's event has earlier timestamp → she wins
      expect(owner).toBe(alice.getPublicKeyHex());
      expect(owner).not.toBe(bob.getPublicKeyHex());
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

    it('should handle multiple hijack attempts and still return original owner', async () => {
      // Alice is the original owner (earliest)
      const aliceEvent = await createSignedBinding(alice, 'popular', 1000);

      // Multiple attackers try to claim the same nametag
      const attacker1 = NostrKeyManager.generate();
      const attacker2 = NostrKeyManager.generate();
      const attack1Event = await createSignedBinding(attacker1, 'popular', 1500);
      const attack2Event = await createSignedBinding(attacker2, 'popular', 2000);

      // Relay returns all events in arbitrary order
      stubSubscribe(client, [attack2Event, attack1Event, aliceEvent]);

      const owner = await client.queryPubkeyByNametag('popular');
      expect(owner).toBe(alice.getPublicKeyHex());
    });
  });

  // ===========================================================================
  // First-seen-wins: queryBindingByNametag
  // ===========================================================================

  describe('queryBindingByNametag (first-seen-wins with extended info)', () => {
    it('should return BindingInfo from the earliest event', async () => {
      const aliceEvent = await createSignedBinding(alice, 'richinfo', 1000);
      const bobEvent = await createSignedBinding(bob, 'richinfo', 2000);

      stubSubscribe(client, [bobEvent, aliceEvent]);

      const info = await client.queryBindingByNametag('richinfo');
      expect(info).not.toBeNull();
      expect(info!.transportPubkey).toBe(alice.getPublicKeyHex());
      expect(info!.timestamp).toBe(1000 * 1000); // converted to ms
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

    it('queryBindingByNametag should return latest same-author even when attacker also present', async () => {
      // Alice: old binding at 1000, updated at 3000
      const aliceOld = await createSignedBinding(alice, 'contested', 1000);
      const aliceNew = await createSignedBinding(alice, 'contested', 3000);
      // Bob tries to hijack at 2000 (between Alice's two events)
      const bobEvent = await createSignedBinding(bob, 'contested', 2000);

      stubSubscribe(client, [bobEvent, aliceNew, aliceOld]);

      const info = await client.queryBindingByNametag('contested');
      expect(info).not.toBeNull();
      // Alice wins (earliest first-seen = 1000)
      expect(info!.transportPubkey).toBe(alice.getPublicKeyHex());
      // But we get Alice's LATEST event (timestamp 3000)
      expect(info!.timestamp).toBe(3000 * 1000);
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

    it('queryPubkeyByNametag should still pick earliest author even with multiple same-author events', async () => {
      // Alice has two events (1000, 3000), Bob has one (2000)
      const alice1 = await createSignedBinding(alice, 'multiauth', 1000);
      const alice2 = await createSignedBinding(alice, 'multiauth', 3000);
      const bobEvent = await createSignedBinding(bob, 'multiauth', 2000);

      stubSubscribe(client, [alice2, bobEvent, alice1]);

      const owner = await client.queryPubkeyByNametag('multiauth');
      // Alice first appeared at 1000, Bob at 2000 → Alice wins
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
    it('Alice registers, Bob tries to hijack, resolution still returns Alice', async () => {
      // Step 1: Alice publishes her binding (timestamp 1000)
      const aliceEvent = await createSignedBinding(alice, 'alice', 1000);

      // Step 2: Bob (attacker) publishes a binding for the same nametag (timestamp 2000)
      const bobEvent = await createSignedBinding(bob, 'alice', 2000);

      // Step 3: Both events exist on the relay
      // Any client resolving "alice" should get Alice's pubkey (earliest)
      const resolver = new NostrClient(NostrKeyManager.generate(), { queryTimeoutMs: 1000 });
      stubSubscribe(resolver, [bobEvent, aliceEvent]);

      const resolvedPubkey = await resolver.queryPubkeyByNametag('alice');
      expect(resolvedPubkey).toBe(alice.getPublicKeyHex());
      expect(resolvedPubkey).not.toBe(bob.getPublicKeyHex());

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
