/**
 * PaymentRequestProtocol - Request payments from other users over Nostr.
 * Uses NIP-04 encryption for secure payment request transmission.
 */

import { NostrKeyManager } from '../NostrKeyManager.js';
import { Event } from '../protocol/Event.js';
import * as EventKinds from '../protocol/EventKinds.js';

/** Prefix for payment request messages */
const MESSAGE_PREFIX = 'payment_request:';

/** Prefix for payment request response messages */
const RESPONSE_PREFIX = 'payment_request_response:';

/** Default deadline duration: 5 minutes in milliseconds */
export const DEFAULT_DEADLINE_MS = 5 * 60 * 1000;

/**
 * Payment request response status.
 */
export enum ResponseStatus {
  /** Payment request was declined by the recipient */
  DECLINED = 'DECLINED',
  /** Payment request expired (deadline passed) */
  EXPIRED = 'EXPIRED',
}

/**
 * Payment request data structure.
 */
export interface PaymentRequest {
  /** Amount in smallest units (e.g., lamports for SOL) */
  amount: bigint | number;
  /** Coin ID (hex string identifying the token type) */
  coinId: string;
  /** Optional message describing the payment */
  message?: string;
  /** Nametag where tokens should be sent (the requester's nametag) */
  recipientNametag: string;
  /** Unique request ID for tracking (auto-generated if not provided) */
  requestId?: string;
  /** Deadline timestamp in milliseconds (Unix epoch). Null/undefined means default deadline (5 min). */
  deadline?: number | null;
}

/**
 * Payment request response data structure.
 */
export interface PaymentRequestResponse {
  /** The original request ID being responded to */
  requestId: string;
  /** The original event ID being responded to */
  originalEventId: string;
  /** Response status (DECLINED, EXPIRED) */
  status: ResponseStatus;
  /** Optional reason for decline/expiration */
  reason?: string;
}

/**
 * Parsed payment request from an event.
 */
export interface ParsedPaymentRequest {
  /** Amount in smallest units */
  amount: bigint;
  /** Coin ID (hex string) */
  coinId: string;
  /** Optional message */
  message?: string;
  /** Nametag where tokens should be sent */
  recipientNametag: string;
  /** Unique request ID */
  requestId: string;
  /** Sender's public key (who is requesting payment) */
  senderPubkey: string;
  /** Event timestamp */
  timestamp: number;
  /** Original event ID */
  eventId: string;
  /** Deadline timestamp in milliseconds, null if no deadline */
  deadline: number | null;
}

/**
 * Parsed payment request response from an event.
 */
export interface ParsedPaymentRequestResponse {
  /** The original request ID */
  requestId: string;
  /** The original event ID */
  originalEventId: string;
  /** Response status */
  status: ResponseStatus;
  /** Optional reason */
  reason?: string;
  /** Sender's public key (who sent the response) */
  senderPubkey: string;
  /** Response event ID */
  eventId: string;
  /** Event timestamp */
  timestamp: number;
}

/**
 * Generate a short unique request ID.
 */
function generateRequestId(): string {
  const bytes = new Uint8Array(4);
  // eslint-disable-next-line no-undef
  if (typeof crypto !== 'undefined' && (crypto as Crypto).getRandomValues) {
    // eslint-disable-next-line no-undef
    (crypto as Crypto).getRandomValues(bytes);
  } else {
    // Fallback for environments without crypto.getRandomValues
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Create a payment request event.
 *
 * Event structure:
 * - Kind: 31115 (PAYMENT_REQUEST - Unicity custom)
 * - Tags:
 *   - ["p", "<target_pubkey_hex>"] - Target (who should pay)
 *   - ["type", "payment_request"] - Event type
 *   - ["amount", "<amount>"] - Amount for relay filtering
 *   - ["recipient", "<nametag>"] - Recipient nametag
 * - Content: NIP-04 encrypted "payment_request:{json}"
 *
 * @param keyManager Key manager with signing keys
 * @param targetPubkeyHex Target's public key (who should pay)
 * @param request Payment request details
 * @returns Signed event
 */
export async function createPaymentRequestEvent(
  keyManager: NostrKeyManager,
  targetPubkeyHex: string,
  request: PaymentRequest
): Promise<Event> {
  // Generate request ID if not provided
  const requestId = request.requestId || generateRequestId();

  // Calculate deadline: use provided value, or default to 5 minutes from now
  // If explicitly set to null, no deadline
  const deadline =
    request.deadline === null
      ? null
      : request.deadline !== undefined
        ? request.deadline
        : Date.now() + DEFAULT_DEADLINE_MS;

  // Serialize request to JSON
  const requestJson = JSON.stringify({
    amount: String(request.amount), // Convert to string for JSON compatibility with bigint
    coinId: request.coinId,
    message: request.message,
    recipientNametag: request.recipientNametag,
    requestId: requestId,
    deadline: deadline,
  });

  // Add prefix and encrypt
  const message = MESSAGE_PREFIX + requestJson;
  const encryptedContent = await keyManager.encryptHex(message, targetPubkeyHex);

  // Build tags
  const tags: string[][] = [
    ['p', targetPubkeyHex],
    ['type', 'payment_request'],
    ['amount', String(request.amount)],
  ];

  if (request.recipientNametag) {
    tags.push(['recipient', request.recipientNametag]);
  }

  const event = Event.create(keyManager, {
    kind: EventKinds.PAYMENT_REQUEST,
    tags,
    content: encryptedContent,
  });

  return event;
}

/**
 * Parse a payment request event.
 * Decrypts and parses the payment request data.
 *
 * @param event Payment request event
 * @param keyManager Key manager for decryption
 * @returns Parsed payment request
 * @throws Error if the event is not a valid payment request
 */
export async function parsePaymentRequest(
  event: Event,
  keyManager: NostrKeyManager
): Promise<ParsedPaymentRequest> {
  // Verify event kind
  if (event.kind !== EventKinds.PAYMENT_REQUEST) {
    throw new Error('Event is not a payment request');
  }

  // Verify event type tag
  const eventType = event.getTagValue('type');
  if (eventType !== 'payment_request') {
    throw new Error('Event type is not payment_request');
  }

  // Determine the peer's public key for decryption
  let peerPubkeyHex: string;
  if (keyManager.isMyPublicKey(event.pubkey)) {
    // We sent this event, decrypt with target's key
    const targetPubkey = event.getTagValue('p');
    if (!targetPubkey) {
      throw new Error('No target found in event');
    }
    peerPubkeyHex = targetPubkey;
  } else {
    // We received this event, decrypt with sender's key
    peerPubkeyHex = event.pubkey;
  }

  // Decrypt the content
  const decrypted = await keyManager.decryptHex(event.content, peerPubkeyHex);

  // Validate prefix
  if (!decrypted.startsWith(MESSAGE_PREFIX)) {
    throw new Error('Invalid payment request format: missing prefix');
  }

  // Parse JSON
  const requestJson = decrypted.slice(MESSAGE_PREFIX.length);
  const parsed = JSON.parse(requestJson);

  return {
    amount: BigInt(parsed.amount),
    coinId: parsed.coinId,
    message: parsed.message,
    recipientNametag: parsed.recipientNametag,
    requestId: parsed.requestId,
    senderPubkey: event.pubkey,
    timestamp: event.created_at * 1000, // Convert to milliseconds
    eventId: event.id,
    deadline: parsed.deadline !== undefined ? parsed.deadline : null,
  };
}

/**
 * Check if an event is a payment request.
 * @param event Event to check
 * @returns true if the event is a payment request
 */
export function isPaymentRequest(event: Event): boolean {
  return (
    event.kind === EventKinds.PAYMENT_REQUEST &&
    event.getTagValue('type') === 'payment_request'
  );
}

/**
 * Get the amount from a payment request event (from unencrypted tag).
 * @param event Payment request event
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
 * Get the recipient nametag from a payment request event (from unencrypted tag).
 * @param event Payment request event
 * @returns Recipient nametag, or undefined if not specified
 */
export function getRecipientNametag(event: Event): string | undefined {
  return event.getTagValue('recipient');
}

/**
 * Get the target public key from a payment request event.
 * @param event Payment request event
 * @returns Target public key (hex), or undefined if not found
 */
export function getTarget(event: Event): string | undefined {
  return event.getTagValue('p');
}

/**
 * Get the sender public key from a payment request event.
 * @param event Payment request event
 * @returns Sender public key (hex)
 */
export function getSender(event: Event): string {
  return event.pubkey;
}

/**
 * Format an amount for display with proper decimals.
 * @param amount Amount in smallest units
 * @param decimals Number of decimal places (default: 8)
 * @returns Formatted amount string
 */
export function formatAmount(amount: bigint | number, decimals: number = 8): string {
  const amountBigInt = typeof amount === 'bigint' ? amount : BigInt(amount);
  const divisor = BigInt(10) ** BigInt(decimals);

  const wholePart = amountBigInt / divisor;
  const fractionalPart = amountBigInt % divisor;

  if (fractionalPart === BigInt(0)) {
    return wholePart.toString();
  }

  // Format fractional part with leading zeros
  const fractionalStr = fractionalPart.toString().padStart(decimals, '0');
  // Remove trailing zeros
  const trimmedFractional = fractionalStr.replace(/0+$/, '');

  return `${wholePart}.${trimmedFractional}`;
}

/**
 * Parse an amount string to smallest units.
 * @param amountStr Amount string (e.g., "1.5")
 * @param decimals Number of decimal places (default: 8)
 * @returns Amount in smallest units
 */
export function parseAmount(amountStr: string, decimals: number = 8): bigint {
  const multiplier = BigInt(10) ** BigInt(decimals);

  const parts = amountStr.split('.');
  const wholePart = BigInt(parts[0] || '0');

  if (parts.length === 1) {
    return wholePart * multiplier;
  }

  // Handle fractional part
  let fractionalStr = parts[1] || '0';
  // Pad or truncate to correct number of decimals
  if (fractionalStr.length < decimals) {
    fractionalStr = fractionalStr.padEnd(decimals, '0');
  } else if (fractionalStr.length > decimals) {
    fractionalStr = fractionalStr.slice(0, decimals);
  }

  const fractionalPart = BigInt(fractionalStr);

  return wholePart * multiplier + fractionalPart;
}

// ============================================================================
// Payment Request Response Functions
// ============================================================================

/**
 * Check if a parsed payment request has expired.
 * @param request Parsed payment request
 * @returns true if the request has a deadline and it has passed
 */
export function isExpired(request: ParsedPaymentRequest): boolean {
  return request.deadline !== null && Date.now() > request.deadline;
}

/**
 * Get remaining time until deadline in milliseconds.
 * @param request Parsed payment request
 * @returns Remaining time in ms, 0 if expired, null if no deadline
 */
export function getRemainingTimeMs(request: ParsedPaymentRequest): number | null {
  if (request.deadline === null) return null;
  const remaining = request.deadline - Date.now();
  return remaining > 0 ? remaining : 0;
}

/**
 * Create a payment request response event (for decline/expiration).
 *
 * Event structure:
 * - Kind: 31116 (PAYMENT_REQUEST_RESPONSE)
 * - Tags:
 *   - ["p", "<target_pubkey_hex>"] - Original requester
 *   - ["type", "payment_request_response"]
 *   - ["status", "DECLINED" | "EXPIRED"]
 *   - ["e", "<original_event_id>", "", "reply"] - Reference to original request
 * - Content: NIP-04 encrypted response JSON
 *
 * @param keyManager Key manager with signing keys
 * @param targetPubkeyHex Original requester's public key
 * @param response Response details
 * @returns Signed event
 */
export async function createPaymentRequestResponseEvent(
  keyManager: NostrKeyManager,
  targetPubkeyHex: string,
  response: PaymentRequestResponse
): Promise<Event> {
  // Serialize response to JSON
  const responseJson = JSON.stringify({
    requestId: response.requestId,
    originalEventId: response.originalEventId,
    status: response.status,
    reason: response.reason,
  });

  // Add prefix and encrypt
  const message = RESPONSE_PREFIX + responseJson;
  const encryptedContent = await keyManager.encryptHex(message, targetPubkeyHex);

  // Build tags
  const tags: string[][] = [
    ['p', targetPubkeyHex],
    ['type', 'payment_request_response'],
    ['status', response.status],
  ];

  // Add reference to original event
  if (response.originalEventId) {
    tags.push(['e', response.originalEventId, '', 'reply']);
  }

  const event = Event.create(keyManager, {
    kind: EventKinds.PAYMENT_REQUEST_RESPONSE,
    tags,
    content: encryptedContent,
  });

  return event;
}

/**
 * Parse a payment request response event.
 * Decrypts and parses the response data.
 *
 * @param event Payment request response event
 * @param keyManager Key manager for decryption
 * @returns Parsed payment request response
 * @throws Error if the event is not a valid payment request response
 */
export async function parsePaymentRequestResponse(
  event: Event,
  keyManager: NostrKeyManager
): Promise<ParsedPaymentRequestResponse> {
  // Verify event kind
  if (event.kind !== EventKinds.PAYMENT_REQUEST_RESPONSE) {
    throw new Error('Event is not a payment request response');
  }

  // Determine the peer's public key for decryption
  let peerPubkeyHex: string;
  if (keyManager.isMyPublicKey(event.pubkey)) {
    // We sent this response, decrypt with target's key
    const targetPubkey = event.getTagValue('p');
    if (!targetPubkey) {
      throw new Error('No target found in event');
    }
    peerPubkeyHex = targetPubkey;
  } else {
    // We received this response, decrypt with sender's key
    peerPubkeyHex = event.pubkey;
  }

  // Decrypt the content
  const decrypted = await keyManager.decryptHex(event.content, peerPubkeyHex);

  // Validate prefix
  if (!decrypted.startsWith(RESPONSE_PREFIX)) {
    throw new Error('Invalid payment request response format: missing prefix');
  }

  // Parse JSON
  const responseJson = decrypted.slice(RESPONSE_PREFIX.length);
  const parsed = JSON.parse(responseJson);

  return {
    requestId: parsed.requestId,
    originalEventId: parsed.originalEventId,
    status: parsed.status as ResponseStatus,
    reason: parsed.reason,
    senderPubkey: event.pubkey,
    eventId: event.id,
    timestamp: event.created_at * 1000,
  };
}

/**
 * Check if an event is a payment request response.
 * @param event Event to check
 * @returns true if the event is a payment request response
 */
export function isPaymentRequestResponse(event: Event): boolean {
  return (
    event.kind === EventKinds.PAYMENT_REQUEST_RESPONSE &&
    event.getTagValue('type') === 'payment_request_response'
  );
}

/**
 * Get the response status from a payment request response event (from unencrypted tag).
 * @param event Payment request response event
 * @returns Status string, or undefined if not found
 */
export function getResponseStatus(event: Event): string | undefined {
  return event.getTagValue('status');
}

/**
 * Get the referenced original event ID from the response event.
 * @param event Payment request response event
 * @returns Original event ID, or undefined if not found
 */
export function getOriginalEventId(event: Event): string | undefined {
  return event.getTagValue('e');
}
