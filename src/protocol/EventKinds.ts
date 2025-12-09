/**
 * EventKinds - Standardized Nostr event kind definitions.
 * Includes both standard NIP kinds and Unicity custom kinds.
 */

// ============================================================================
// Standard NIP Event Kinds
// ============================================================================

/** NIP-01: User profile metadata */
export const PROFILE = 0;

/** NIP-01: Short text note */
export const TEXT_NOTE = 1;

/** NIP-01: Recommend relay to followers */
export const RECOMMEND_RELAY = 2;

/** NIP-02: Contact list (follows) */
export const CONTACTS = 3;

/** NIP-04: Encrypted direct messages */
export const ENCRYPTED_DM = 4;

/** NIP-09: Event deletion */
export const DELETION = 5;

/** NIP-17: Seal (signed, encrypted rumor) */
export const SEAL = 13;

/** NIP-17: Private chat message (rumor - unsigned inner event) */
export const CHAT_MESSAGE = 14;

/** NIP-17: Read receipt (rumor kind) */
export const READ_RECEIPT = 15;

/** NIP-25: Reactions (likes, etc.) */
export const REACTION = 7;

/** NIP-59: Gift wrap for private events */
export const GIFT_WRAP = 1059;

/** NIP-65: Relay list metadata */
export const RELAY_LIST = 10002;

/** NIP-78: Application-specific data (parameterized replaceable) */
export const APP_DATA = 30078;

// ============================================================================
// Unicity Custom Event Kinds
// ============================================================================

/** Unicity: Agent profile information */
export const AGENT_PROFILE = 31111;

/** Unicity: Agent GPS location */
export const AGENT_LOCATION = 31112;

/** Unicity: Token transfer event */
export const TOKEN_TRANSFER = 31113;

/** Unicity: File metadata */
export const FILE_METADATA = 31114;

/** Unicity: Payment request */
export const PAYMENT_REQUEST = 31115;

/** Unicity: Payment request response (accept/decline) */
export const PAYMENT_REQUEST_RESPONSE = 31116;

// ============================================================================
// Event Kind Classification Functions
// ============================================================================

/**
 * Check if an event kind is replaceable.
 * Replaceable events (kinds 0, 3, or 10000-19999) are replaced when a new
 * event with the same kind and pubkey is published.
 * @param kind Event kind number
 * @returns true if the event kind is replaceable
 */
export function isReplaceable(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
}

/**
 * Check if an event kind is ephemeral.
 * Ephemeral events (kinds 20000-29999) are not stored by relays.
 * @param kind Event kind number
 * @returns true if the event kind is ephemeral
 */
export function isEphemeral(kind: number): boolean {
  return kind >= 20000 && kind < 30000;
}

/**
 * Check if an event kind is parameterized replaceable.
 * Parameterized replaceable events (kinds 30000-39999) are replaced when a
 * new event with the same kind, pubkey, and "d" tag value is published.
 * @param kind Event kind number
 * @returns true if the event kind is parameterized replaceable
 */
export function isParameterizedReplaceable(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

/**
 * Get a human-readable name for an event kind.
 * @param kind Event kind number
 * @returns Human-readable name for the event kind
 */
export function getName(kind: number): string {
  switch (kind) {
    case PROFILE:
      return 'Profile';
    case TEXT_NOTE:
      return 'Text Note';
    case RECOMMEND_RELAY:
      return 'Recommend Relay';
    case CONTACTS:
      return 'Contacts';
    case ENCRYPTED_DM:
      return 'Encrypted DM';
    case DELETION:
      return 'Deletion';
    case SEAL:
      return 'Seal';
    case CHAT_MESSAGE:
      return 'Chat Message';
    case READ_RECEIPT:
      return 'Read Receipt';
    case REACTION:
      return 'Reaction';
    case GIFT_WRAP:
      return 'Gift Wrap';
    case RELAY_LIST:
      return 'Relay List';
    case APP_DATA:
      return 'App Data';
    case AGENT_PROFILE:
      return 'Agent Profile';
    case AGENT_LOCATION:
      return 'Agent Location';
    case TOKEN_TRANSFER:
      return 'Token Transfer';
    case FILE_METADATA:
      return 'File Metadata';
    case PAYMENT_REQUEST:
      return 'Payment Request';
    case PAYMENT_REQUEST_RESPONSE:
      return 'Payment Request Response';
    default:
      if (isReplaceable(kind)) {
        return `Replaceable (${kind})`;
      }
      if (isEphemeral(kind)) {
        return `Ephemeral (${kind})`;
      }
      if (isParameterizedReplaceable(kind)) {
        return `Parameterized Replaceable (${kind})`;
      }
      return `Unknown (${kind})`;
  }
}
