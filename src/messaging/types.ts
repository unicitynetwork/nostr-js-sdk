/**
 * NIP-17 Messaging Types - Private Direct Messages
 */

import { EventTag } from '../protocol/Event.js';

/**
 * Rumor - An unsigned inner event for NIP-17 private messages.
 * Rumors are wrapped in seals and gift wraps for sender privacy.
 * Unlike regular Events, Rumors do NOT have a signature field.
 */
export interface Rumor {
  /** Event ID (SHA-256 hash of serialized rumor) */
  id: string;

  /** Public key of rumor creator (real sender) */
  pubkey: string;

  /** Unix timestamp in seconds */
  created_at: number;

  /** Event kind (14 for chat message, 15 for read receipt) */
  kind: number;

  /** Event tags */
  tags: EventTag[];

  /** Message content */
  content: string;
}

/**
 * Parsed private message from NIP-17 gift-wrapped event.
 * Contains the decrypted message content and metadata.
 */
export interface PrivateMessage {
  /** Nostr event ID of the gift wrap (for deduplication) */
  eventId: string;

  /** Sender's public key (from the seal, not the gift wrap) */
  senderPubkey: string;

  /** Recipient's public key */
  recipientPubkey: string;

  /** Message content */
  content: string;

  /** Message timestamp (from the rumor) */
  timestamp: number;

  /** Original rumor kind (14 for chat, 15 for read receipt) */
  kind: number;

  /** Reply-to event ID (if this is a reply) */
  replyToEventId?: string;
}

/**
 * Check if a message is a chat message (kind 14).
 */
export function isChatMessage(message: PrivateMessage): boolean {
  return message.kind === 14;
}

/**
 * Check if a message is a read receipt (kind 15).
 */
export function isReadReceipt(message: PrivateMessage): boolean {
  return message.kind === 15;
}

/**
 * Options for creating a private message.
 */
export interface PrivateMessageOptions {
  /** Optional event ID this message is replying to */
  replyToEventId?: string;
}
