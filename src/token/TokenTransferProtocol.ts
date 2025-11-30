/**
 * TokenTransferProtocol - Encapsulate Unicity token transfers over Nostr.
 * Uses NIP-04 encryption with optional GZIP compression.
 */

import { NostrKeyManager } from '../NostrKeyManager.js';
import { Event } from '../protocol/Event.js';
import * as EventKinds from '../protocol/EventKinds.js';

/** Prefix for token transfer messages */
const MESSAGE_PREFIX = 'token_transfer:';

/**
 * Options for creating a token transfer event.
 */
export interface TokenTransferOptions {
  /** Optional amount for metadata */
  amount?: number | bigint;
  /** Optional token symbol for metadata */
  symbol?: string;
  /** Optional event ID this transfer is responding to (e.g., payment request) */
  replyToEventId?: string;
}

/**
 * Create a token transfer event.
 *
 * Event structure:
 * - Kind: 31113 (TOKEN_TRANSFER - Unicity custom)
 * - Tags:
 *   - ["p", "<recipient_pubkey_hex>"] - Recipient
 *   - ["type", "token_transfer"] - Event type
 *   - ["amount", "<amount>"] - Optional amount
 *   - ["symbol", "<symbol>"] - Optional token symbol
 *   - ["e", "<event_id>", "", "reply"] - Optional reply-to event (for payment request correlation)
 * - Content: NIP-04 encrypted "token_transfer:{tokenJson}"
 *
 * @param keyManager Key manager with signing keys
 * @param recipientPubkeyHex Recipient's public key (hex)
 * @param tokenJson Token JSON string
 * @param amountOrOptions Optional amount for metadata, or options object
 * @param symbol Optional token symbol for metadata (ignored if options object used)
 * @returns Signed event
 */
export async function createTokenTransferEvent(
  keyManager: NostrKeyManager,
  recipientPubkeyHex: string,
  tokenJson: string,
  amountOrOptions?: number | bigint | TokenTransferOptions,
  symbol?: string
): Promise<Event> {
  // Parse options (support both old and new signatures)
  let amount: number | bigint | undefined;
  let tokenSymbol: string | undefined;
  let replyToEventId: string | undefined;

  if (amountOrOptions !== undefined && typeof amountOrOptions === 'object') {
    // New options object signature
    amount = amountOrOptions.amount;
    tokenSymbol = amountOrOptions.symbol;
    replyToEventId = amountOrOptions.replyToEventId;
  } else {
    // Old positional arguments signature
    amount = amountOrOptions;
    tokenSymbol = symbol;
  }

  // Encrypt the token data
  const message = MESSAGE_PREFIX + tokenJson;
  const encryptedContent = await keyManager.encryptHex(message, recipientPubkeyHex);

  // Build tags
  const tags: string[][] = [
    ['p', recipientPubkeyHex],
    ['type', 'token_transfer'],
  ];

  if (amount !== undefined) {
    tags.push(['amount', String(amount)]);
  }

  if (tokenSymbol !== undefined) {
    tags.push(['symbol', tokenSymbol]);
  }

  // Add optional reply-to event reference (for payment request correlation)
  if (replyToEventId !== undefined && replyToEventId.length > 0) {
    tags.push(['e', replyToEventId, '', 'reply']);
  }

  const event = Event.create(keyManager, {
    kind: EventKinds.TOKEN_TRANSFER,
    tags,
    content: encryptedContent,
  });

  return event;
}

/**
 * Parse a token transfer event.
 * Decrypts and decompresses the token data.
 *
 * @param event Token transfer event
 * @param keyManager Key manager for decryption
 * @returns Token JSON string
 * @throws Error if the event is not a valid token transfer
 */
export async function parseTokenTransfer(
  event: Event,
  keyManager: NostrKeyManager
): Promise<string> {
  // Verify event kind
  if (event.kind !== EventKinds.TOKEN_TRANSFER) {
    throw new Error('Event is not a token transfer');
  }

  // Verify event type tag
  const eventType = event.getTagValue('type');
  if (eventType !== 'token_transfer') {
    throw new Error('Event type is not token_transfer');
  }

  // Determine the sender's public key
  let senderPubkeyHex: string;
  if (keyManager.isMyPublicKey(event.pubkey)) {
    // We sent this event, decrypt with recipient's key
    const recipientPubkey = event.getTagValue('p');
    if (!recipientPubkey) {
      throw new Error('No recipient found in event');
    }
    senderPubkeyHex = recipientPubkey;
  } else {
    // We received this event, decrypt with sender's key
    senderPubkeyHex = event.pubkey;
  }

  // Decrypt the content
  let decrypted: string;
  try {
    decrypted = await keyManager.decryptHex(event.content, senderPubkeyHex);
  } catch (error) {
    // Fallback: try hex decoding for backward compatibility
    try {
      const { hexToBytes } = await import('@noble/hashes/utils');
      decrypted = new TextDecoder().decode(hexToBytes(event.content));
    } catch {
      throw error; // Re-throw original error
    }
  }

  // Strip the message prefix
  if (!decrypted.startsWith(MESSAGE_PREFIX)) {
    throw new Error('Invalid token transfer format');
  }

  return decrypted.slice(MESSAGE_PREFIX.length);
}

/**
 * Get the amount from a token transfer event.
 * @param event Token transfer event
 * @returns Amount, or undefined if not specified
 */
export function getAmount(event: Event): bigint | undefined {
  const amount = event.getTagValue('amount');
  if (amount === undefined) {
    return undefined;
  }
  try {
    return BigInt(amount);
  } catch {
    return undefined;
  }
}

/**
 * Get the symbol from a token transfer event.
 * @param event Token transfer event
 * @returns Symbol, or undefined if not specified
 */
export function getSymbol(event: Event): string | undefined {
  return event.getTagValue('symbol');
}

/**
 * Get the reply-to event ID from a token transfer event.
 * Used to correlate token transfers with payment requests.
 * @param event Token transfer event
 * @returns Referenced event ID, or undefined if not present
 */
export function getReplyToEventId(event: Event): string | undefined {
  return event.getTagValue('e');
}

/**
 * Check if an event is a token transfer.
 * @param event Event to check
 * @returns true if the event is a token transfer
 */
export function isTokenTransfer(event: Event): boolean {
  return (
    event.kind === EventKinds.TOKEN_TRANSFER &&
    event.getTagValue('type') === 'token_transfer'
  );
}

/**
 * Get the recipient public key from a token transfer event.
 * @param event Token transfer event
 * @returns Recipient public key (hex), or undefined if not found
 */
export function getRecipient(event: Event): string | undefined {
  return event.getTagValue('p');
}

/**
 * Get the sender public key from a token transfer event.
 * @param event Token transfer event
 * @returns Sender public key (hex)
 */
export function getSender(event: Event): string {
  return event.pubkey;
}
