/**
 * Live e2e: UNIP-01 single-owner identity bindings.
 *
 * Against a UNIP-01 relay, once an owner registers a nametag (a marked binding),
 * a different key cannot overwrite it: the relay rejects the competing marked
 * binding (even backdated — created_at is not authoritative), and resolution
 * returns the owner.
 *
 * Excluded from the default `vitest run` (integration config). Run against the
 * deployed testnet relay:
 *   RELAY_URL=wss://nostr-relay.testnet.unicity.network \
 *     npm run test:integration -- unip-01-single-owner-relay
 */

import { describe, it, expect, afterEach } from 'vitest';
import { NostrClient } from '../../src/client/NostrClient.js';
import { NostrKeyManager } from '../../src/NostrKeyManager.js';
import { createBindingEvent, UNICITY_NAMETAG_NAMESPACE } from '../../src/nametag/NametagBinding.js';
import { Event } from '../../src/protocol/Event.js';

const RELAY_URL = process.env.RELAY_URL?.trim() || 'wss://nostr-relay.testnet.unicity.network';

// A fresh nametag per run — UNIP-01 ownership is permanent on the relay, so we
// must not collide with a previous run's owner. A fixed-length slice of a fresh
// (cryptographically random) pubkey gives a stable [a-z0-9] length and a
// negligible collision chance. Result: "e2e" + 12 hex chars = 15 chars (≤ 20).
function uniqueNametag(): string {
  return `e2e${NostrKeyManager.generate().getPublicKeyHex().slice(0, 12)}`;
}

const chainKey = (m: string): string => '02' + m.repeat(64);

describe('UNIP-01 live e2e: single-owner nametag ownership', () => {
  const clients: NostrClient[] = [];
  const opts = { queryTimeoutMs: 12000, autoReconnect: false };

  afterEach(() => {
    for (const c of clients.splice(0)) {
      try { c.disconnect(); } catch { /* ignore */ }
    }
  });

  it('relay rejects a second key for an owned nametag; resolution returns the owner', async () => {
    const nametag = uniqueNametag();
    const ownerKeys = NostrKeyManager.generate();
    const otherKeys = NostrKeyManager.generate();

    const owner = new NostrClient(ownerKeys, opts);
    const other = new NostrClient(otherKeys, opts);
    const resolver = new NostrClient(NostrKeyManager.generate(), opts);
    clients.push(owner, other, resolver);

    await Promise.all([
      owner.connect(RELAY_URL),
      other.connect(RELAY_URL),
      resolver.connect(RELAY_URL),
    ]);

    const ownerChain = chainKey('a');
    const otherChain = chainKey('f');

    // 1. Owner registers the nametag with a marked binding. publishEvent resolves
    //    on the relay's OK:true.
    const ownerBinding = await createBindingEvent(ownerKeys, nametag, `DIRECT://${ownerChain}`, undefined, {
      publicKey: ownerChain,
      directAddress: `DIRECT://${ownerChain}`,
    });
    expect(ownerBinding.getTagValues('L')).toContain(UNICITY_NAMETAG_NAMESPACE);
    // publishEvent resolves on the relay's OK:true, which is sent only after the
    // event (and its namespace_owner record) is committed — no settle needed.
    await owner.publishEvent(ownerBinding);

    // 2. A second key tries to overwrite the binding with its own marked binding
    //    (current timestamp). The relay must reject it (NIP-20 `blocked:` —
    //    owned by another key).
    const otherBinding = await createBindingEvent(otherKeys, nametag, `DIRECT://${otherChain}`, undefined, {
      publicKey: otherChain,
      directAddress: `DIRECT://${otherChain}`,
    });
    await expect(other.publishEvent(otherBinding)).rejects.toThrow(/blocked|owned by another key/i);

    // 3. The second key retries BACKDATED (created_at=1). Still rejected —
    //    created_at is not authoritative; the relay arbitrates by receive order.
    const backdated = Event.create(otherKeys, {
      kind: otherBinding.kind,
      tags: otherBinding.tags,
      content: otherBinding.content,
      created_at: 1,
    });
    expect(backdated.verify()).toBe(true); // a valid, real signature
    await expect(other.publishEvent(backdated)).rejects.toThrow();

    // 4. A third party resolving the nametag gets the OWNER, not the second key.
    //    The owner's binding is already committed (step 1) and the rejected
    //    publishes changed no state, so no settle is needed here either.
    const resolved = await resolver.queryPubkeyByNametag(nametag);
    expect(resolved).toBe(ownerKeys.getPublicKeyHex());
    expect(resolved).not.toBe(otherKeys.getPublicKeyHex());

    const binding = await resolver.queryBindingByNametag(nametag);
    expect(binding?.publicKey).toBe(ownerChain);
    expect(binding?.transportPubkey).toBe(ownerKeys.getPublicKeyHex());
  }, 90_000);
});
