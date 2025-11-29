/**
 * NIP-17 Private Direct Messages Protocol.
 * Implements gift-wrapping for sender anonymity using NIP-44 encryption.
 *
 * Message flow:
 * 1. Create Rumor (kind 14, unsigned) with actual message content
 * 2. Create Seal (kind 13, signed by sender) encrypting the rumor
 * 3. Create Gift Wrap (kind 1059, signed by random ephemeral key) encrypting the seal
 *
 * Only the recipient can decrypt and verify the true sender.
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { NostrKeyManager } from '../NostrKeyManager.js';
import { Event, SignedEventData, EventTag } from '../protocol/Event.js';
import * as EventKinds from '../protocol/EventKinds.js';
import * as NIP44 from '../crypto/nip44.js';
import * as Schnorr from '../crypto/schnorr.js';
import { Rumor, PrivateMessage, PrivateMessageOptions } from './types.js';

// Randomization window for timestamps (+/- 2 days in seconds)
const TIMESTAMP_RANDOMIZATION = 2 * 24 * 60 * 60;

/**
 * Create a gift-wrapped private message.
 *
 * @param senderKeys Sender's key manager
 * @param recipientPubkeyHex Recipient's public key (hex)
 * @param content Message content
 * @param options Optional message options (reply-to, etc.)
 * @returns Gift-wrapped event (kind 1059)
 */
export function createGiftWrap(
  senderKeys: NostrKeyManager,
  recipientPubkeyHex: string,
  content: string,
  options?: PrivateMessageOptions
): Event {
  // 1. Create Rumor (kind 14, unsigned)
  const rumor = createRumor(
    senderKeys.getPublicKeyHex(),
    recipientPubkeyHex,
    content,
    EventKinds.CHAT_MESSAGE,
    options?.replyToEventId
  );

  // 2. Create Seal (kind 13, signed by sender, encrypts rumor)
  const seal = createSeal(senderKeys, recipientPubkeyHex, rumor);

  // 3. Create Gift Wrap (kind 1059, signed by ephemeral key, encrypts seal)
  return wrapSeal(seal, recipientPubkeyHex);
}

/**
 * Create a gift-wrapped read receipt.
 *
 * @param senderKeys Sender's key manager
 * @param recipientPubkeyHex Recipient (original sender) public key
 * @param messageEventId Event ID of the message being acknowledged
 * @returns Gift-wrapped read receipt event
 */
export function createReadReceipt(
  senderKeys: NostrKeyManager,
  recipientPubkeyHex: string,
  messageEventId: string
): Event {
  // Create rumor with kind 15 (read receipt)
  const tags: EventTag[] = [
    ['p', recipientPubkeyHex],
    ['e', messageEventId],
  ];

  // Use actual timestamp for rumor (privacy via outer layers)
  const actualTimestamp = Math.floor(Date.now() / 1000);

  const rumor: Rumor = {
    id: '', // Will be computed
    pubkey: senderKeys.getPublicKeyHex(),
    created_at: actualTimestamp,
    kind: EventKinds.READ_RECEIPT,
    tags,
    content: '', // Read receipts have empty content
  };

  // Compute the rumor ID
  rumor.id = computeRumorId(rumor);

  const seal = createSeal(senderKeys, recipientPubkeyHex, rumor);
  return wrapSeal(seal, recipientPubkeyHex);
}

/**
 * Unwrap a gift-wrapped message.
 *
 * @param giftWrap Gift wrap event (kind 1059)
 * @param recipientKeys Recipient's key manager
 * @returns Parsed private message
 */
export function unwrap(giftWrap: Event, recipientKeys: NostrKeyManager): PrivateMessage {
  if (giftWrap.kind !== EventKinds.GIFT_WRAP) {
    throw new Error(`Event is not a gift wrap (kind ${giftWrap.kind})`);
  }

  // Get ephemeral sender's pubkey from gift wrap
  const ephemeralPubkey = giftWrap.pubkey;
  const ephemeralPubkeyBytes = hexToBytes(ephemeralPubkey);

  // Decrypt seal from gift wrap content
  const sealJson = NIP44.decrypt(
    giftWrap.content,
    recipientKeys.getPrivateKey(),
    ephemeralPubkeyBytes
  );

  const sealData = JSON.parse(sealJson) as SignedEventData;

  if (sealData.kind !== EventKinds.SEAL) {
    throw new Error(`Inner event is not a seal (kind ${sealData.kind})`);
  }

  // Verify seal signature
  const sealPubkey = sealData.pubkey;
  const sealIdBytes = hexToBytes(sealData.id);
  const sigBytes = hexToBytes(sealData.sig);
  const pubkeyBytes = hexToBytes(sealPubkey);

  if (!Schnorr.verify(sigBytes, sealIdBytes, pubkeyBytes)) {
    throw new Error('Seal signature verification failed');
  }

  // Decrypt rumor from seal content
  const rumorJson = NIP44.decrypt(sealData.content, recipientKeys.getPrivateKey(), pubkeyBytes);

  const rumor = JSON.parse(rumorJson) as Rumor;

  // Extract reply-to event ID if present
  const replyToEventId = getTagValue(rumor.tags, 'e');

  return {
    eventId: giftWrap.id,
    senderPubkey: sealPubkey,
    recipientPubkey: recipientKeys.getPublicKeyHex(),
    content: rumor.content,
    timestamp: rumor.created_at,
    kind: rumor.kind,
    replyToEventId,
  };
}

// ========== Helper Functions ==========

/**
 * Create an unsigned rumor (kind 14 or 15).
 * Note: Rumor uses actual timestamp for correct message ordering.
 * Only seal and gift wrap use randomized timestamps for privacy.
 */
function createRumor(
  senderPubkey: string,
  recipientPubkey: string,
  content: string,
  kind: number,
  replyToEventId?: string
): Rumor {
  const tags: EventTag[] = [['p', recipientPubkey]];

  if (replyToEventId) {
    tags.push(['e', replyToEventId, '', 'reply']);
  }

  // Use actual timestamp for rumor (inner message) - needed for correct ordering
  // Privacy is provided by randomized timestamps on seal and gift wrap layers
  const actualTimestamp = Math.floor(Date.now() / 1000);

  const rumor: Rumor = {
    id: '', // Will be computed
    pubkey: senderPubkey,
    created_at: actualTimestamp,
    kind,
    tags,
    content,
  };

  // Compute the rumor ID
  rumor.id = computeRumorId(rumor);

  return rumor;
}

/**
 * Compute the rumor ID from serialized data.
 * ID = SHA-256([0, pubkey, created_at, kind, tags, content])
 */
function computeRumorId(rumor: Rumor): string {
  const serialized = JSON.stringify([
    0,
    rumor.pubkey,
    rumor.created_at,
    rumor.kind,
    rumor.tags,
    rumor.content,
  ]);
  const hash = sha256(new TextEncoder().encode(serialized));
  return bytesToHex(hash);
}

/**
 * Create a seal (kind 13) that encrypts a rumor.
 */
function createSeal(
  senderKeys: NostrKeyManager,
  recipientPubkeyHex: string,
  rumor: Rumor
): Event {
  const rumorJson = JSON.stringify(rumor);

  // Encrypt rumor with NIP-44
  const recipientPubkey = hexToBytes(recipientPubkeyHex);
  const encryptedRumor = NIP44.encrypt(rumorJson, senderKeys.getPrivateKey(), recipientPubkey);

  // Create seal data
  const pubkey = senderKeys.getPublicKeyHex();
  const created_at = randomizeTimestamp();
  const kind = EventKinds.SEAL;
  const tags: EventTag[] = []; // Seals have no tags
  const content = encryptedRumor;

  // Calculate ID
  const sealId = Event.calculateId(pubkey, created_at, kind, tags, content);

  // Sign
  const sealIdBytes = hexToBytes(sealId);
  const sig = senderKeys.signHex(sealIdBytes);

  return new Event({
    id: sealId,
    pubkey,
    created_at,
    kind,
    tags,
    content,
    sig,
  });
}

/**
 * Wrap a seal in a gift wrap (kind 1059) using an ephemeral key.
 */
function wrapSeal(seal: Event, recipientPubkeyHex: string): Event {
  // Generate ephemeral key for the gift wrap
  const ephemeralKeys = NostrKeyManager.generate();

  const sealJson = JSON.stringify(seal.toJSON());

  // Encrypt seal with NIP-44 using ephemeral key
  const recipientPubkey = hexToBytes(recipientPubkeyHex);
  const encryptedSeal = NIP44.encrypt(sealJson, ephemeralKeys.getPrivateKey(), recipientPubkey);

  // Create gift wrap data
  const pubkey = ephemeralKeys.getPublicKeyHex();
  const created_at = randomizeTimestamp();
  const kind = EventKinds.GIFT_WRAP;
  const tags: EventTag[] = [['p', recipientPubkeyHex]];
  const content = encryptedSeal;

  // Calculate ID
  const giftWrapId = Event.calculateId(pubkey, created_at, kind, tags, content);

  // Sign with ephemeral key
  const giftWrapIdBytes = hexToBytes(giftWrapId);
  const sig = ephemeralKeys.signHex(giftWrapIdBytes);

  // Clear ephemeral key from memory
  ephemeralKeys.clear();

  return new Event({
    id: giftWrapId,
    pubkey,
    created_at,
    kind,
    tags,
    content,
    sig,
  });
}

/**
 * Generate a randomized timestamp for privacy (+/- 2 days).
 */
function randomizeTimestamp(): number {
  const now = Math.floor(Date.now() / 1000);
  const randomOffset =
    Math.floor(Math.random() * 2 * TIMESTAMP_RANDOMIZATION) - TIMESTAMP_RANDOMIZATION;
  return now + randomOffset;
}

/**
 * Get the first value of a tag by name from a tags array.
 */
function getTagValue(tags: EventTag[], tagName: string): string | undefined {
  const tag = tags.find((t) => t[0] === tagName);
  return tag?.[1];
}
