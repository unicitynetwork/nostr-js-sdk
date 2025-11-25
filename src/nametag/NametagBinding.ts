/**
 * NametagBinding - Create and parse nametag binding events.
 * Uses kind 30078 (APP_DATA) for parameterized replaceable events.
 */

import { NostrKeyManager } from '../NostrKeyManager.js';
import { Event } from '../protocol/Event.js';
import { Filter } from '../protocol/Filter.js';
import * as EventKinds from '../protocol/EventKinds.js';
import * as NametagUtils from './NametagUtils.js';

/** Default country code for phone number normalization */
const DEFAULT_COUNTRY = 'US';

/**
 * Binding event content structure
 */
interface BindingContent {
  nametag_hash: string;
  address: string;
  verified: number;
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
 * @returns Signed event
 */
export async function createBindingEvent(
  keyManager: NostrKeyManager,
  nametagId: string,
  unicityAddress: string,
  defaultCountry: string = DEFAULT_COUNTRY
): Promise<Event> {
  const hashedNametag = NametagUtils.hashNametag(nametagId, defaultCountry);

  const content: BindingContent = {
    nametag_hash: hashedNametag,
    address: unicityAddress,
    verified: Date.now(),
  };

  const event = Event.create(keyManager, {
    kind: EventKinds.APP_DATA,
    tags: [
      ['d', hashedNametag],
      ['nametag', hashedNametag],
      ['t', hashedNametag],
      ['address', unicityAddress],
    ],
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
