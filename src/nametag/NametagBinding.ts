/**
 * NametagBinding - Create and parse nametag binding events.
 * Uses kind 30078 (APP_DATA) for parameterized replaceable events.
 */

import { NostrKeyManager } from '../NostrKeyManager.js';
import { Event } from '../protocol/Event.js';
import { Filter } from '../protocol/Filter.js';
import * as EventKinds from '../protocol/EventKinds.js';
import * as NametagUtils from './NametagUtils.js';

/** Default country code for phone number normalization (shared with NametagUtils) */
const DEFAULT_COUNTRY = 'US';

/**
 * Binding event content structure
 */
interface BindingContent {
  nametag_hash: string;
  address: string;
  verified: number;
  // Extended identity fields (optional for backward compat)
  public_key?: string;
  l1_address?: string;
  direct_address?: string;
  proxy_address?: string;
  encrypted_nametag?: string;
  nametag?: string;
}

/**
 * Extended identity parameters for richer binding events.
 * All fields are optional — when provided, they are included in the
 * event content and indexed via 't' tags for reverse lookup.
 */
export interface IdentityBindingParams {
  /** 33-byte compressed secp256k1 public key */
  publicKey?: string;
  /** L1 bech32 address (e.g., alpha1...) */
  l1Address?: string;
  /** Direct address identifier */
  directAddress?: string;
  /** Proxy address (derived from nametag) */
  proxyAddress?: string;
}

/**
 * Parsed binding info returned by query methods.
 */
export interface BindingInfo {
  /** Event author's 32-byte Nostr public key (hex) */
  transportPubkey: string;
  /** 33-byte compressed secp256k1 public key (from content) */
  publicKey?: string;
  /** L1 bech32 address (from content) */
  l1Address?: string;
  /** Direct address (from content) */
  directAddress?: string;
  /** Proxy address (from content) */
  proxyAddress?: string;
  /** Plaintext nametag (from content, if present) */
  nametag?: string;
  /** Event timestamp in milliseconds */
  timestamp: number;
}

/**
 * Create a nametag binding event.
 *
 * Event structure:
 * - Kind: 30078 (APP_DATA - parameterized replaceable)
 * - Tags:
 *   - ["d", "<hashed_nametag>"] - Required for parameterized replaceable
 *   - ["nametag", "<hashed_nametag>"] - Hashed for privacy
 *   - ["t", "<hashed_nametag>"] - Indexed tag for relay search
 *   - ["address", "<unicity_addr>"] - Unicity blockchain address
 * - Content: JSON with nametag_hash, address, verified timestamp
 *
 * @param keyManager Key manager with signing keys
 * @param nametagId Nametag identifier (phone number or username)
 * @param unicityAddress Unicity blockchain address
 * @param defaultCountry Default country code for phone normalization
 * @param identity Optional extended identity parameters
 * @returns Signed event
 */
export async function createBindingEvent(
  keyManager: NostrKeyManager,
  nametagId: string,
  unicityAddress: string,
  defaultCountry: string = DEFAULT_COUNTRY,
  identity?: IdentityBindingParams,
): Promise<Event> {
  if (!NametagUtils.isValidNametag(nametagId, defaultCountry)) {
    throw new Error(`Invalid nametag: "${nametagId}". Must be 3-20 chars [a-z0-9_-] or a valid phone number.`);
  }

  const hashedNametag = NametagUtils.hashNametag(nametagId, defaultCountry);

  const content: BindingContent = {
    nametag_hash: hashedNametag,
    address: unicityAddress,
    verified: Math.floor(Date.now() / 1000),
  };

  const tags: string[][] = [
    ['d', hashedNametag],
    ['nametag', hashedNametag],
    ['t', hashedNametag],
    ['address', unicityAddress],
    ['t', NametagUtils.hashAddressForTag(unicityAddress)],
  ];

  // Add extended identity fields when provided
  if (identity) {
    const encryptedNametag = await NametagUtils.encryptNametag(
      nametagId,
      keyManager.getPrivateKeyHex(),
    );
    content.encrypted_nametag = encryptedNametag;
    // Plaintext nametag is intentionally stored in content for public resolution.
    // Nametags must be publicly resolvable (sending to @alice requires knowing her
    // addresses). Tag hashing provides relay-level privacy (operators see hashes in
    // indexed tags, not plaintext). The encrypted copy enables private key recovery.
    content.nametag = nametagId;

    if (identity.publicKey) {
      content.public_key = identity.publicKey;
      tags.push(['t', NametagUtils.hashAddressForTag(identity.publicKey)]);
      tags.push(['pubkey', identity.publicKey]);
    }
    if (identity.l1Address) {
      content.l1_address = identity.l1Address;
      tags.push(['t', NametagUtils.hashAddressForTag(identity.l1Address)]);
      tags.push(['l1', identity.l1Address]);
    }
    if (identity.directAddress) {
      content.direct_address = identity.directAddress;
      tags.push(['t', NametagUtils.hashAddressForTag(identity.directAddress)]);
    }
    if (identity.proxyAddress) {
      content.proxy_address = identity.proxyAddress;
      tags.push(['t', NametagUtils.hashAddressForTag(identity.proxyAddress)]);
    }
  }

  const event = Event.create(keyManager, {
    kind: EventKinds.APP_DATA,
    tags,
    content: JSON.stringify(content),
  });

  return event;
}

/**
 * Create a filter to query pubkey by nametag.
 * Query direction: nametag → pubkey
 *
 * @param nametagId Nametag identifier
 * @param defaultCountry Default country code for phone normalization
 * @returns Filter for nametag binding events
 */
export function createNametagToPubkeyFilter(
  nametagId: string,
  defaultCountry: string = DEFAULT_COUNTRY
): Filter {
  const hashedNametag = NametagUtils.hashNametag(nametagId, defaultCountry);

  return Filter.builder()
    .kinds(EventKinds.APP_DATA)
    .tTags(hashedNametag)
    .build();
}

/**
 * Create a filter to query binding events by address hash.
 * Query direction: address → binding event
 *
 * @param address Address string (DIRECT://..., alpha1..., PROXY://..., or chain pubkey)
 * @returns Filter for nametag binding events
 */
export function createAddressToBindingFilter(address: string): Filter {
  const hashedAddress = NametagUtils.hashAddressForTag(address);

  return Filter.builder()
    .kinds(EventKinds.APP_DATA)
    .tTags(hashedAddress)
    .build();
}

/**
 * Create a filter to query nametags by pubkey.
 * Query direction: pubkey → nametags
 *
 * @param nostrPubkey Nostr public key (hex)
 * @returns Filter for nametag binding events
 */
export function createPubkeyToNametagFilter(nostrPubkey: string): Filter {
  return Filter.builder()
    .kinds(EventKinds.APP_DATA)
    .authors(nostrPubkey)
    .limit(10)
    .build();
}

/**
 * Parse binding info from an event.
 * Extracts both basic and extended identity fields from event content when possible.
 * On parse failure, returns minimal binding info.
 *
 * @param event Binding event
 * @returns BindingInfo with parsed fields when possible, or minimal info if content cannot be parsed
 */
export function parseBindingInfo(event: Event): BindingInfo {
  try {
    const content = JSON.parse(event.content) as BindingContent;
    return {
      transportPubkey: event.pubkey,
      publicKey: content.public_key,
      l1Address: content.l1_address,
      directAddress: content.direct_address,
      proxyAddress: content.proxy_address,
      nametag: content.nametag,
      timestamp: event.created_at * 1000,
    };
  } catch (e) {
    // Content is not valid JSON — return minimal info.
    // This can happen with old-format events or data corruption.
    if (typeof console !== 'undefined') {
      console.warn(`[nostr-sdk] Failed to parse binding event content (event ${event.id?.slice(0, 8)}):`, e);
    }
    return {
      transportPubkey: event.pubkey,
      timestamp: event.created_at * 1000,
    };
  }
}

/**
 * Parse the hashed nametag from a binding event.
 * Tries tags first, then content JSON.
 *
 * @param event Binding event
 * @returns Hashed nametag, or undefined if not found
 */
export function parseNametagHashFromEvent(event: Event): string | undefined {
  // Try "nametag" tag first
  const fromTag = event.getTagValue('nametag');
  if (fromTag) {
    return fromTag;
  }

  // Try "d" tag
  const fromDTag = event.getTagValue('d');
  if (fromDTag) {
    return fromDTag;
  }

  // Try content JSON
  try {
    const content = JSON.parse(event.content) as BindingContent;
    return content.nametag_hash;
  } catch {
    return undefined;
  }
}

/**
 * Parse the Unicity address from a binding event.
 * Tries tags first, then content JSON.
 *
 * @param event Binding event
 * @returns Unicity address, or undefined if not found
 */
export function parseAddressFromEvent(event: Event): string | undefined {
  // Try "address" tag first
  const fromTag = event.getTagValue('address');
  if (fromTag) {
    return fromTag;
  }

  // Try content JSON
  try {
    const content = JSON.parse(event.content) as BindingContent;
    return content.address;
  } catch {
    return undefined;
  }
}

/**
 * Verify that a binding event is valid.
 * Checks signature and structure.
 *
 * @param event Event to verify
 * @returns true if the binding event is valid
 */
export function isValidBindingEvent(event: Event): boolean {
  // Check event kind
  if (event.kind !== EventKinds.APP_DATA) {
    return false;
  }

  // Check required tags
  if (!event.hasTag('d')) {
    return false;
  }

  // Check content structure
  try {
    const content = JSON.parse(event.content) as BindingContent;
    if (!content.nametag_hash || !content.address) {
      return false;
    }
  } catch {
    return false;
  }

  // Verify signature
  return event.verify();
}
