/**
 * Nametag binding resolution determinism (UNIP-01).
 *
 * Under UNIP-01, a binding that carries the single-owner namespace marker
 * (NIP-32 ["L","unicity:nametag"]) is vetted by the relay for single ownership.
 * Resolution therefore PREFERS marked bindings and ignores the self-asserted
 * `created_at` entirely:
 *
 *   - a marked owner wins over an unmarked (legacy) binding even when the legacy
 *     binding has a much lower `created_at` (so a backdated, unmarked binding
 *     cannot win against the relay-vetted owner);
 *   - two distinct marked owners are treated as ambiguous (null) rather than
 *     decided by `created_at` (no silent selection);
 *   - when no marked binding exists (an identifier not yet migrated), a single
 *     legacy author still resolves, but two or more are ambiguous (null) —
 *     `created_at` never decides between authors;
 *   - only bindings whose `d` tag is the queried nametag's hash count (the relay
 *     vets ownership of the `d` tag, not of `t` tags, which anyone can add);
 *   - address lookups ignore the marker (the relay vets no address) and resolve
 *     only when exactly one author advertises the address.
 *
 * Tests use REAL signatures (no `verify()` stub). `createBindingEvent` now emits
 * the marker, so the helper strips it to simulate legacy/unmarked bindings.
 *
 * See: unicity-tokens-relay/docs/UNIP-01.md
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NostrClient } from '../../src/client/NostrClient.js';
import { NostrKeyManager } from '../../src/NostrKeyManager.js';
import {
  createBindingEvent,
  createIdentityBindingEvent,
  UNICITY_NAMETAG_NAMESPACE,
} from '../../src/nametag/NametagBinding.js';
import * as NametagUtils from '../../src/nametag/NametagUtils.js';
import { Event } from '../../src/protocol/Event.js';

/** A plausible compressed secp256k1 chain pubkey for a given marker byte. */
function chainKey(marker: string): string {
  return '02' + marker.repeat(64);
}

/**
 * Build a binding for `nametag` authored by `km`, advertising `chainPubkey`,
 * signed at `createdAt`. The signature is REAL (re-signed via Event.create).
 * `marked` controls whether the UNIP-01 ["L", ...] marker is present — set false
 * to simulate a legacy/unmarked binding.
 */
async function signedBindingAt(
  km: NostrKeyManager,
  nametag: string,
  chainPubkey: string,
  createdAt: number,
  marked = true,
): Promise<Event> {
  const canonical = await createBindingEvent(km, nametag, `DIRECT://${chainPubkey}`, undefined, {
    publicKey: chainPubkey,
    directAddress: `DIRECT://${chainPubkey}`,
  });
  const tags = marked
    ? canonical.tags
    : canonical.tags.filter((t) => !(t[0] === 'L' && t[1] === UNICITY_NAMETAG_NAMESPACE));
  return Event.create(km, {
    kind: canonical.kind,
    tags,
    content: canonical.content,
    created_at: createdAt,
  });
}

/** Deliver `events` to any subscription, then EOSE. No relay connection is used. */
function stubSubscribe(client: NostrClient, events: Event[]): void {
  vi.spyOn(client, 'subscribe').mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (...args: any[]) => {
      const listener = args[args.length - 1];
      setTimeout(() => {
        for (const event of events) listener.onEvent?.(event);
        listener.onEndOfStoredEvents?.();
      }, 0);
      return 'determinism-sub';
    },
  );
}

describe('UNIP-01 nametag resolution (created_at is not authoritative)', () => {
  let keyA: NostrKeyManager;
  let keyB: NostrKeyManager;
  let resolver: NostrClient;

  const NOW = Math.floor(Date.now() / 1000);
  const chainA = chainKey('a');
  const chainB = chainKey('f');

  afterEach(() => {
    resolver?.disconnect();
    vi.restoreAllMocks();
  });

  it('createBindingEvent emits the UNIP-01 marker', async () => {
    keyA = NostrKeyManager.generate();
    const binding = await createBindingEvent(keyA, 'alice', `DIRECT://${chainA}`);
    expect(binding.getTagValues('L')).toContain(UNICITY_NAMETAG_NAMESPACE);
  });

  it('a marked owner wins over an unmarked binding with a much lower created_at', async () => {
    keyA = NostrKeyManager.generate();
    keyB = NostrKeyManager.generate();

    const owner = await signedBindingAt(keyA, 'alice', chainA, NOW, true); // marked
    const legacy = await signedBindingAt(keyB, 'alice', chainB, 1, false); // unmarked, backdated

    resolver = new NostrClient(NostrKeyManager.generate(), { queryTimeoutMs: 1000 });
    stubSubscribe(resolver, [legacy, owner]);

    const resolved = await resolver.queryPubkeyByNametag('alice');
    // The relay-vetted (marked) owner is selected; the lower created_at is ignored.
    expect(resolved).toBe(keyA.getPublicKeyHex());
    expect(resolved).not.toBe(keyB.getPublicKeyHex());
  });

  it('hands the marked owner chain pubkey to the sender', async () => {
    keyA = NostrKeyManager.generate();
    keyB = NostrKeyManager.generate();

    const owner = await signedBindingAt(keyA, 'alice', chainA, NOW, true);
    const legacy = await signedBindingAt(keyB, 'alice', chainB, 1, false);

    resolver = new NostrClient(NostrKeyManager.generate(), { queryTimeoutMs: 1000 });
    stubSubscribe(resolver, [legacy, owner]);

    const info = await resolver.queryBindingByNametag('alice');
    expect(info).not.toBeNull();
    expect(info!.publicKey).toBe(chainA);
    expect(info!.transportPubkey).toBe(keyA.getPublicKeyHex());
  });

  it('two distinct marked owners are ambiguous (null), never decided by created_at', async () => {
    keyA = NostrKeyManager.generate();
    keyB = NostrKeyManager.generate();

    const a = await signedBindingAt(keyA, 'alice', chainA, NOW, true);
    const b = await signedBindingAt(keyB, 'alice', chainB, 1, true); // lower created_at, also marked

    resolver = new NostrClient(NostrKeyManager.generate(), { queryTimeoutMs: 1000 });
    stubSubscribe(resolver, [a, b]);

    const resolved = await resolver.queryPubkeyByNametag('alice');
    // Must NOT pick the lower created_at; ambiguous -> null (caller treats as unresolved).
    expect(resolved).toBeNull();
  });

  it('two unmarked authors for the same nametag are ambiguous (null), never decided by created_at', async () => {
    keyA = NostrKeyManager.generate();
    keyB = NostrKeyManager.generate();

    const a = await signedBindingAt(keyA, 'alice', chainA, NOW, false); // unmarked
    const b = await signedBindingAt(keyB, 'alice', chainB, 1, false); // unmarked, backdated

    resolver = new NostrClient(NostrKeyManager.generate(), { queryTimeoutMs: 1000 });
    stubSubscribe(resolver, [a, b]);

    // The relay enforces nothing for unmarked bindings, so anyone can publish one
    // under the victim's d tag with any created_at. Refuse to guess.
    expect(await resolver.queryPubkeyByNametag('alice')).toBeNull();
  });

  it('a single unmarked (legacy) author still resolves', async () => {
    keyA = NostrKeyManager.generate();
    const a = await signedBindingAt(keyA, 'alice', chainA, 1000, false);

    resolver = new NostrClient(NostrKeyManager.generate(), { queryTimeoutMs: 1000 });
    stubSubscribe(resolver, [a]);

    expect(await resolver.queryPubkeyByNametag('alice')).toBe(keyA.getPublicKeyHex());
  });
});

/**
 * A signed kind-30078 event under the author's OWN `d` tag that also carries
 * `tTags`. Anyone can publish this: the relay vets only the `d` tag (and only
 * when the event is marked), so `t` tags are free-form.
 */
function eventCarryingTags(
  km: NostrKeyManager,
  dTag: string,
  tTags: string[],
  content: Record<string, string>,
  createdAt: number,
  marked: boolean,
): Event {
  const tags = [['d', dTag], ...(marked ? [['L', UNICITY_NAMETAG_NAMESPACE]] : []), ...tTags.map((t) => ['t', t])];
  return Event.create(km, { kind: 30078, tags, content: JSON.stringify(content), created_at: createdAt });
}

describe('UNIP-01 resolution counts only events that bind the queried identifier', () => {
  let victim: NostrKeyManager;
  let attacker: NostrKeyManager;
  let resolver: NostrClient;

  const NOW = Math.floor(Date.now() / 1000);
  const victimChain = chainKey('a');
  const attackerChain = chainKey('f');
  // The attacker's own, legitimately owned nametag: its marked binding passes the relay.
  const attackerOwnD = NametagUtils.hashNametag('mallory');

  beforeEach(() => {
    victim = NostrKeyManager.generate();
    attacker = NostrKeyManager.generate();
    resolver = new NostrClient(NostrKeyManager.generate(), { queryTimeoutMs: 1000 });
  });

  afterEach(() => {
    resolver.disconnect();
    vi.restoreAllMocks();
  });

  describe('nametag lookup', () => {
    const victimTag = NametagUtils.hashNametag('alice');

    it('ignores a marked binding for another nametag that carries the victim nametag in a t tag', async () => {
      const owner = await signedBindingAt(victim, 'alice', victimChain, NOW, true);
      const rogue = eventCarryingTags(attacker, attackerOwnD, [attackerOwnD, victimTag],
        { public_key: attackerChain, nametag: 'alice' }, NOW, true);
      stubSubscribe(resolver, [owner, rogue]);

      expect(await resolver.queryPubkeyByNametag('alice')).toBe(victim.getPublicKeyHex());
    });

    it('a marked binding for another nametag cannot take over a legacy nametag', async () => {
      const legacy = await signedBindingAt(victim, 'alice', victimChain, NOW, false);
      const rogue = eventCarryingTags(attacker, attackerOwnD, [attackerOwnD, victimTag],
        { public_key: attackerChain, nametag: 'alice' }, NOW, true);
      stubSubscribe(resolver, [legacy, rogue]);

      const info = await resolver.queryBindingByNametag('alice');
      expect(info?.transportPubkey).toBe(victim.getPublicKeyHex());
      expect(info?.publicKey).toBe(victimChain);
    });

    it('a backdated unmarked event under another d tag cannot take over a legacy nametag', async () => {
      const legacy = await signedBindingAt(victim, 'alice', victimChain, NOW, false);
      const rogue = eventCarryingTags(attacker, 'atk-d', [victimTag],
        { public_key: attackerChain, nametag: 'alice' }, 1, false);
      stubSubscribe(resolver, [legacy, rogue]);

      expect(await resolver.queryPubkeyByNametag('alice')).toBe(victim.getPublicKeyHex());
    });

    it('publishNametagBinding is not blocked by a binding for another nametag', async () => {
      const client = new NostrClient(victim, { queryTimeoutMs: 1000 });
      const rogue = eventCarryingTags(attacker, attackerOwnD, [attackerOwnD, NametagUtils.hashNametag('fresh')],
        { nametag: 'fresh' }, NOW, true);
      stubSubscribe(client, [rogue]);
      vi.spyOn(client, 'publishEvent').mockResolvedValue('event-id');

      await expect(client.publishNametagBinding('fresh', `DIRECT://${victimChain}`)).resolves.toBe(true);
      client.disconnect();
    });
  });

  describe('address lookup', () => {
    const address = 'DIRECT://victim-address';
    const addressTag = NametagUtils.hashAddressForTag(address);
    const victimIdentity = (): Event =>
      createIdentityBindingEvent(victim, { publicKey: victimChain, directAddress: address });

    it('resolves the only author advertising the address', async () => {
      stubSubscribe(resolver, [victimIdentity()]);

      const info = await resolver.queryBindingByAddress(address);
      expect(info?.transportPubkey).toBe(victim.getPublicKeyHex());
      expect(info?.publicKey).toBe(victimChain);
    });

    it('two authors advertising the address are ambiguous (null), never decided by created_at', async () => {
      const rogue = eventCarryingTags(attacker, 'atk-d', [addressTag],
        { public_key: attackerChain, direct_address: address }, NOW - 60 * 86400, false);
      stubSubscribe(resolver, [victimIdentity(), rogue]);

      expect(await resolver.queryBindingByAddress(address)).toBeNull();
    });

    it('ignores the ownership marker: a marked binding vouches for its nametag, not for an address', async () => {
      const rogue = eventCarryingTags(attacker, attackerOwnD, [attackerOwnD, addressTag],
        { public_key: attackerChain, direct_address: address }, NOW, true);
      stubSubscribe(resolver, [victimIdentity(), rogue]);

      expect(await resolver.queryBindingByAddress(address)).toBeNull();
    });

    it('ignores relay-injected events that do not carry the queried address tag', async () => {
      const unrelated = eventCarryingTags(attacker, 'atk-d', [NametagUtils.hashAddressForTag('DIRECT://other')],
        { public_key: attackerChain, direct_address: address }, 1, false);
      stubSubscribe(resolver, [victimIdentity(), unrelated]);

      expect((await resolver.queryBindingByAddress(address))?.transportPubkey).toBe(victim.getPublicKeyHex());
    });
  });
});
