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
 *   - when no marked binding exists (an identifier not yet migrated), resolution
 *     falls back to legacy first-seen-wins by `created_at` for compatibility.
 *
 * Tests use REAL signatures (no `verify()` stub). `createBindingEvent` now emits
 * the marker, so the helper strips it to simulate legacy/unmarked bindings.
 *
 * See: unicity-tokens-relay/docs/UNIP-01.md
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { NostrClient } from '../../src/client/NostrClient.js';
import { NostrKeyManager } from '../../src/NostrKeyManager.js';
import {
  createBindingEvent,
  UNICITY_NAMETAG_NAMESPACE,
} from '../../src/nametag/NametagBinding.js';
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

  it('falls back to legacy first-seen-wins when no marked binding exists', async () => {
    keyA = NostrKeyManager.generate();
    keyB = NostrKeyManager.generate();

    const a = await signedBindingAt(keyA, 'alice', chainA, 1000, false); // unmarked
    const b = await signedBindingAt(keyB, 'alice', chainB, 2000, false); // unmarked

    resolver = new NostrClient(NostrKeyManager.generate(), { queryTimeoutMs: 1000 });
    stubSubscribe(resolver, [b, a]);

    const resolved = await resolver.queryPubkeyByNametag('alice');
    // No UNIP-01 claim present: earliest created_at among legacy bindings wins.
    expect(resolved).toBe(keyA.getPublicKeyHex());
  });
});
