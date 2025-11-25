/**
 * Event - Represents a Nostr event (NIP-01).
 * Provides serialization, signing, and verification functionality.
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { NostrKeyManager } from '../NostrKeyManager.js';
import * as Schnorr from '../crypto/schnorr.js';

/**
 * Type for event tags - arrays of strings where the first element is the tag name.
 */
export type EventTag = string[];

/**
 * Interface for unsigned event data (before signing).
 */
export interface UnsignedEventData {
  kind: number;
  tags: EventTag[];
  content: string;
  created_at?: number;
}

/**
 * Interface for signed event data (complete event).
 */
export interface SignedEventData {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: EventTag[];
  content: string;
  sig: string;
}

/**
 * Event class representing a Nostr event (NIP-01).
 */
export class Event implements SignedEventData {
  /** Event ID - SHA-256 hash of the serialized event data (hex) */
  id: string;

  /** Creator's x-only public key (hex) */
  pubkey: string;

  /** Unix timestamp in seconds */
  created_at: number;

  /** Event kind (type) */
  kind: number;

  /** Event tags */
  tags: EventTag[];

  /** Event content */
  content: string;

  /** Schnorr signature (hex) */
  sig: string;

  /**
   * Create an Event instance.
   * @param data Signed event data
   */
  constructor(data: SignedEventData) {
    this.id = data.id;
    this.pubkey = data.pubkey;
    this.created_at = data.created_at;
    this.kind = data.kind;
    this.tags = data.tags;
    this.content = data.content;
    this.sig = data.sig;
  }

  /**
   * Create and sign a new event.
   * @param keyManager Key manager with signing key
   * @param data Unsigned event data
   * @returns Signed Event instance
   */
  static create(keyManager: NostrKeyManager, data: UnsignedEventData): Event {
    const pubkey = keyManager.getPublicKeyHex();
    const created_at = data.created_at ?? Math.floor(Date.now() / 1000);

    // Calculate event ID
    const id = Event.calculateId(pubkey, created_at, data.kind, data.tags, data.content);

    // Sign the event ID
    const idBytes = hexToBytes(id);
    const sig = keyManager.signHex(idBytes);

    return new Event({
      id,
      pubkey,
      created_at,
      kind: data.kind,
      tags: data.tags,
      content: data.content,
      sig,
    });
  }

  /**
   * Calculate the event ID from event data.
   * ID = SHA-256(serialized event data)
   * Serialized format: [0, pubkey, created_at, kind, tags, content]
   */
  static calculateId(
    pubkey: string,
    created_at: number,
    kind: number,
    tags: EventTag[],
    content: string
  ): string {
    const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
    const hash = sha256(new TextEncoder().encode(serialized));
    return bytesToHex(hash);
  }

  /**
   * Verify the event signature.
   * @returns true if the signature is valid
   */
  verify(): boolean {
    try {
      // Verify the ID
      const calculatedId = Event.calculateId(
        this.pubkey,
        this.created_at,
        this.kind,
        this.tags,
        this.content
      );

      if (calculatedId !== this.id) {
        return false;
      }

      // Verify the signature
      const idBytes = hexToBytes(this.id);
      const sigBytes = hexToBytes(this.sig);
      const pubkeyBytes = hexToBytes(this.pubkey);

      return Schnorr.verify(sigBytes, idBytes, pubkeyBytes);
    } catch {
      return false;
    }
  }

  /**
   * Parse an event from JSON data.
   * @param json JSON object or string
   * @returns Event instance
   */
  static fromJSON(json: unknown): Event {
    const data = typeof json === 'string' ? JSON.parse(json) : json;

    if (!Event.isValidEventData(data)) {
      throw new Error('Invalid event data');
    }

    return new Event(data as SignedEventData);
  }

  /**
   * Check if data has valid event structure.
   */
  static isValidEventData(data: unknown): boolean {
    if (typeof data !== 'object' || data === null) {
      return false;
    }

    const obj = data as Record<string, unknown>;

    return (
      typeof obj.id === 'string' &&
      typeof obj.pubkey === 'string' &&
      typeof obj.created_at === 'number' &&
      typeof obj.kind === 'number' &&
      Array.isArray(obj.tags) &&
      typeof obj.content === 'string' &&
      typeof obj.sig === 'string'
    );
  }

  /**
   * Convert the event to a plain object.
   * @returns Plain object representation
   */
  toJSON(): SignedEventData {
    return {
      id: this.id,
      pubkey: this.pubkey,
      created_at: this.created_at,
      kind: this.kind,
      tags: this.tags,
      content: this.content,
      sig: this.sig,
    };
  }

  /**
   * Get the first value of a tag by name.
   * @param tagName Tag name to find
   * @returns First value of the tag, or undefined if not found
   */
  getTagValue(tagName: string): string | undefined {
    const tag = this.tags.find((t) => t[0] === tagName);
    return tag?.[1];
  }

  /**
   * Get all values of a tag by name.
   * @param tagName Tag name to find
   * @returns Array of tag values
   */
  getTagValues(tagName: string): string[] {
    return this.tags.filter((t) => t[0] === tagName).map((t) => t[1] ?? '');
  }

  /**
   * Check if a tag exists.
   * @param tagName Tag name to check
   * @returns true if the tag exists
   */
  hasTag(tagName: string): boolean {
    return this.tags.some((t) => t[0] === tagName);
  }

  /**
   * Get all values from a single tag entry (excluding the tag name).
   * @param tagName Tag name to find
   * @returns Array of values from the first matching tag, or empty array
   */
  getTagEntryValues(tagName: string): string[] {
    const tag = this.tags.find((t) => t[0] === tagName);
    return tag ? tag.slice(1) : [];
  }
}
