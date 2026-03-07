# Unicity Nostr SDK

A TypeScript SDK for Nostr protocol with Unicity extensions. Works in both Node.js and browser environments.

## Features

- **NIP-17 Private Messages** - Gift-wrapped private direct messages with sender anonymity
- **NIP-42 Client Authentication** - Automatic relay authentication for protected relays
- **NIP-44 Encryption** - Modern ChaCha20-Poly1305 AEAD encryption with HKDF
- **BIP-340 Schnorr Signatures** - Full support for secp256k1 Schnorr signatures
- **NIP-04 Encryption** - Legacy AES-256-CBC encryption with ECDH key agreement
- **GZIP Compression** - Automatic compression for large messages (>1KB)
- **Multi-Relay Support** - Connect to multiple relays with automatic reconnection
- **Token Transfers** - Encrypted Unicity token transfers over Nostr
- **Payment Requests** - Request payments from other users via encrypted Nostr messages
- **Nametag Bindings** - Privacy-preserving identity bindings (phone numbers, usernames)
- **Cross-Platform** - Works in Node.js 18+ and modern browsers

## Installation

```bash
npm install @unicitylabs/nostr-sdk
```

## Quick Start

### Key Management

```typescript
import { NostrKeyManager } from '@unicitylabs/nostr-sdk';

// Generate new keys
const keyManager = NostrKeyManager.generate();

// Or import existing keys
const keyManager = NostrKeyManager.fromPrivateKeyHex('...');
const keyManager = NostrKeyManager.fromNsec('nsec1...');

// Export keys
console.log(keyManager.getNpub());  // npub1...
console.log(keyManager.getNsec()); // nsec1...
console.log(keyManager.getPublicKeyHex());
```

### Connecting to Relays

```typescript
import { NostrClient, NostrKeyManager, ConnectionEventListener } from '@unicitylabs/nostr-sdk';

const keyManager = NostrKeyManager.generate();

// Create client with default options (auto-reconnect enabled)
const client = new NostrClient(keyManager);

// Or configure with custom options
const client = new NostrClient(keyManager, {
  queryTimeoutMs: 15000,        // Query timeout (default: 5000ms)
  autoReconnect: true,          // Auto-reconnect on connection loss (default: true)
  reconnectIntervalMs: 1000,    // Initial reconnect delay (default: 1000ms)
  maxReconnectIntervalMs: 30000, // Max backoff interval (default: 30000ms)
  pingIntervalMs: 30000,        // Health check interval (default: 30000ms, 0 to disable)
});

// Monitor connection events
client.addConnectionListener({
  onConnect: (url) => console.log(`Connected to ${url}`),
  onDisconnect: (url, reason) => console.log(`Disconnected from ${url}: ${reason}`),
  onReconnecting: (url, attempt) => console.log(`Reconnecting to ${url} (attempt ${attempt})...`),
  onReconnected: (url) => console.log(`Reconnected to ${url}`),
});

// Connect to relays
await client.connect(
  'wss://relay.damus.io',
  'wss://nos.lol'
);

// Check connection status
console.log(client.isConnected());
console.log(client.getConnectedRelays());

// Adjust timeout dynamically
client.setQueryTimeout(30000);  // 30 seconds
```

### Publishing Events

```typescript
import { Event, EventKinds } from '@unicitylabs/nostr-sdk';

// Create and publish a text note
const event = Event.create(keyManager, {
  kind: EventKinds.TEXT_NOTE,
  tags: [['t', 'unicity']],
  content: 'Hello, Nostr!',
});

const eventId = await client.publishEvent(event);
```

### Encrypted Direct Messages (NIP-04 Legacy)

```typescript
// Send encrypted DM
const recipientPubkey = '...';
await client.publishEncryptedMessage(recipientPubkey, 'Secret message');

// Or encrypt manually
const encrypted = await keyManager.encryptHex('Hello!', recipientPubkey);
const decrypted = await keyManager.decryptHex(encrypted, senderPubkey);
```

### NIP-17 Private Messages (Recommended)

NIP-17 provides enhanced privacy using gift-wrapping with ephemeral keys:

```typescript
// Send private message by nametag (auto-resolves to pubkey)
const eventId = await client.sendPrivateMessageToNametag(
  'alice',                              // recipient nametag
  'Hello, this is a private message!'
);

// Or send by pubkey directly
const recipientPubkey = '...';
const eventId = await client.sendPrivateMessage(
  recipientPubkey,
  'Hello, this is a private message!'
);

// Send reply to a previous message
const eventId = await client.sendPrivateMessage(
  recipientPubkey,
  'This is a reply!',
  { replyToEventId: originalEventId }
);

// Send read receipt
await client.sendReadReceipt(senderPubkey, messageEventId);
```

Receive and unwrap private messages:

```typescript
import { Filter, EventKinds } from '@unicitylabs/nostr-sdk';

// Subscribe to gift-wrapped messages
const filter = Filter.builder()
  .kinds(EventKinds.GIFT_WRAP)
  .pTags(keyManager.getPublicKeyHex())
  .build();

client.subscribe(filter, {
  onEvent: (event) => {
    try {
      const message = client.unwrapPrivateMessage(event);

      if (message.kind === EventKinds.CHAT_MESSAGE) {
        console.log('From:', message.senderPubkey);
        console.log('Content:', message.content);

        // Send read receipt
        client.sendReadReceipt(message.senderPubkey, message.eventId);
      } else if (message.kind === EventKinds.READ_RECEIPT) {
        console.log('Read receipt for:', message.replyToEventId);
      }
    } catch (e) {
      // Message not for us or decryption failed
    }
  },
});
```

### Subscriptions

```typescript
import { Filter } from '@unicitylabs/nostr-sdk';

// Create a filter
const filter = Filter.builder()
  .kinds(EventKinds.TEXT_NOTE)
  .authors('pubkey1', 'pubkey2')
  .limit(10)
  .build();

// Subscribe
const subId = client.subscribe(filter, {
  onEvent: (event) => {
    console.log('Received event:', event.content);
  },
  onEndOfStoredEvents: (subId) => {
    console.log('All stored events received');
  },
});

// Unsubscribe
client.unsubscribe(subId);
```

### Token Transfers

```typescript
import { NostrClient, TokenTransferProtocol } from '@unicitylabs/nostr-sdk';

// Simple token transfer using NostrClient
const eventId = await client.sendTokenTransfer(recipientPubkey, tokenJson);

// Token transfer with metadata
const eventId = await client.sendTokenTransfer(recipientPubkey, tokenJson, {
  amount: 100n,
  symbol: 'UNIT'
});

// Token transfer in response to a payment request (with correlation)
const paymentRequestEventId = '...'; // Event ID of the original payment request
const eventId = await client.sendTokenTransfer(recipientPubkey, tokenJson, {
  amount: 100n,
  symbol: 'UNIT',
  replyToEventId: paymentRequestEventId  // Links transfer to the payment request
});

// Parse received token transfer
const tokenJson = await TokenTransferProtocol.parseTokenTransfer(event, keyManager);

// Get reply-to event ID (for payment request correlation)
const replyToId = TokenTransferProtocol.getReplyToEventId(event);
if (replyToId) {
  // This transfer is in response to a payment request
  const originalRequest = pendingRequests.get(replyToId);
}
```

### Payment Requests

```typescript
import { NostrClient, PaymentRequestProtocol } from '@unicitylabs/nostr-sdk';

// Send a payment request
const targetPubkey = await client.queryPubkeyByNametag('bob');

const eventId = await client.sendPaymentRequest(targetPubkey, {
  amount: BigInt(1_000_000_000),  // 1 SOL (9 decimals)
  coinId: 'f8aa1383...',          // Coin ID (hex) - precisely defines the token
  message: 'Payment for coffee',
  recipientNametag: 'alice',      // Your nametag (where to receive payment)
});

// Subscribe to incoming payment requests
const filter = Filter.builder()
  .kinds(EventKinds.PAYMENT_REQUEST)
  .pTags(keyManager.getPublicKeyHex())
  .build();

client.subscribe(filter, {
  onEvent: async (event) => {
    const request = await PaymentRequestProtocol.parsePaymentRequest(event, keyManager);
    console.log(`Payment request: ${request.amount}`);
    console.log(`Coin ID: ${request.coinId}`);
    console.log(`Pay to: ${request.recipientNametag}`);
    console.log(`Message: ${request.message}`);
  },
});

// Format amounts for display (with decimals parameter)
PaymentRequestProtocol.formatAmount(BigInt(1_500_000_000), 9); // "1.5" (9 decimals for SOL)
PaymentRequestProtocol.formatAmount(BigInt(150_000_000), 8);   // "1.5" (8 decimals - default)

// Parse amounts from strings
PaymentRequestProtocol.parseAmount('1.5', 9); // BigInt(1_500_000_000) (9 decimals for SOL)
PaymentRequestProtocol.parseAmount('1.5', 8); // BigInt(150_000_000) (8 decimals - default)
```

### Nametag Bindings

Nametags are human-readable identifiers (`[a-z0-9_-]`, 3–20 chars) or phone numbers (E.164). All input is normalized to lowercase before hashing. Use `isValidNametag(input)` to validate.

#### Publishing a Binding

```typescript
// Publish nametag binding with identity info
const success = await client.publishNametagBinding(
  'alice',                           // nametag
  keyManager.getPublicKeyHex(),      // Nostr pubkey (stored in event's address field)
  {                                  // optional extended identity
    publicKey: '02abc...',           // 33-byte compressed secp256k1 chain pubkey
    l1Address: 'alpha1...',          // L1 bech32 address
    directAddress: 'DIRECT://...',   // L3 direct address
    proxyAddress: 'PROXY://...',     // proxy address (derived from nametag)
  },
);
// Throws if nametag is already claimed by another pubkey.
// Returns true on success, false if publish fails.
```

#### Resolving a Nametag

```typescript
// Simple: get the owner pubkey
const pubkey = await client.queryPubkeyByNametag('alice');

// Extended: get full binding info (addresses, nametag, etc.)
const info = await client.queryBindingByNametag('alice');
// info: { transportPubkey, publicKey?, l1Address?, directAddress?, proxyAddress?, nametag?, timestamp }

// Reverse lookup: address → binding
const info = await client.queryBindingByAddress('alpha1abc...');
```

#### Event Format (kind 30078)

Nametag bindings use NIP-78 parameterized replaceable events. Only the original author can update their own event (same pubkey + d-tag = replacement).

**Nametag binding event** (with identity):

```json
{
  "kind": 30078,
  "pubkey": "<32-byte x-only Nostr pubkey>",
  "tags": [
    ["d", "<SHA256('unicity:nametag:' + normalizedNametag)>"],
    ["nametag", "<hashed_nametag>"],
    ["t", "<hashed_nametag>"],
    ["address", "<nostr_pubkey>"],
    ["t", "<SHA256('unicity:address:' + chainPubkey)>"],
    ["pubkey", "<chainPubkey>"],
    ["t", "<SHA256('unicity:address:' + l1Address)>"],
    ["l1", "<l1Address>"],
    ["t", "<SHA256('unicity:address:' + directAddress)>"],
    ["t", "<SHA256('unicity:address:' + proxyAddress)>"]
  ],
  "content": "{\"nametag_hash\":\"...\",\"address\":\"...\",\"verified\":...,\"nametag\":\"alice\",\"encrypted_nametag\":\"...\",\"public_key\":\"02...\",\"l1_address\":\"alpha1...\",\"direct_address\":\"DIRECT://...\",\"proxy_address\":\"PROXY://...\"}"
}
```

Key fields in content:
- `nametag` — plaintext nametag (for display)
- `encrypted_nametag` — AES-GCM encrypted nametag (for recovery by private key owner)
- `public_key`, `l1_address`, `direct_address`, `proxy_address` — identity addresses
- `nametag_hash` — `SHA256('unicity:nametag:' + normalizedNametag)`

Tags enable indexed lookups:
- `d` tag: makes event replaceable per nametag per author
- `t` tags: hashed nametag + hashed addresses for relay search (privacy-preserving)
- `pubkey`, `l1` tags: unhashed for backward-compatible lookups

#### Anti-Hijacking Resolution Strategy

All query methods use **first-seen-wins across authors, latest-wins for same author**:

1. **First-seen-wins across authors** — if multiple pubkeys claim the same nametag, the author who published the earliest `created_at` event wins. Ties are broken deterministically by lexicographic pubkey comparison. This prevents hijacking.

2. **Latest-wins for same author** — if the rightful owner publishes multiple events (e.g., initial binding without nametag, then updated binding with nametag), the most recent event is returned. This ensures queries return the most complete data.

3. **Signature verification** — events with invalid signatures are silently skipped, preventing malicious relays from injecting forged events.

This two-level strategy is critical for the wallet workflow where a binding may be published first without a nametag, then updated later when the user registers one. Both events share address `#t` tags, so address-based lookups see both — the strategy ensures the latest (most complete) event from the original author is returned.

#### Privacy

Nametags are never stored as plaintext in tags. All `t` and `d` tags use `SHA256('unicity:nametag:' + name)` or `SHA256('unicity:address:' + address)` hashes. The plaintext nametag is only in the event content (JSON), and an encrypted copy (`encrypted_nametag`) allows the private key owner to recover it.

## Token Transfer Format

Token transfers use Nostr event kind 31113 with NIP-04 encryption.

### Event Structure

```json
{
  "id": "<sha256_event_hash>",
  "pubkey": "<sender_pubkey_hex>",
  "created_at": 1234567890,
  "kind": 31113,
  "tags": [
    ["p", "<recipient_pubkey_hex>"],
    ["type", "token_transfer"],
    ["amount", "1000000000000000000"],
    ["symbol", "UNIT"]
  ],
  "content": "<NIP-04 encrypted content>",
  "sig": "<schnorr_signature_hex>"
}
```

### Tags

| Tag | Required | Description |
|-----|----------|-------------|
| `p` | Yes | Recipient's public key (hex) |
| `type` | Yes | Always `"token_transfer"` |
| `amount` | No | Transfer amount (metadata for filtering) |
| `symbol` | No | Token symbol (metadata for filtering) |
| `e` | No | Reply-to event ID (for payment request correlation) |

### Encrypted Content

The `content` field is NIP-04 encrypted. When decrypted, it contains:

```
token_transfer:<token_transfer_package_json>
```

The **Token Transfer Package** is a JSON structure containing the source token and the transaction, passed to `createTokenTransferEvent()`.

For payloads >1KB, GZIP compression is automatically applied before encryption:

```
gz:<base64_ciphertext>?iv=<base64_iv>
```

### Helper Functions

```typescript
// Check if event is a token transfer
TokenTransferProtocol.isTokenTransfer(event); // boolean

// Get metadata from tags
TokenTransferProtocol.getAmount(event);         // bigint | undefined
TokenTransferProtocol.getSymbol(event);         // string | undefined
TokenTransferProtocol.getRecipient(event);      // string | undefined
TokenTransferProtocol.getSender(event);         // string
TokenTransferProtocol.getReplyToEventId(event); // string | undefined (payment request correlation)
```

## Payment Request Format

Payment requests use Nostr event kind 31115 with NIP-04 encryption.

### Event Structure

```json
{
  "id": "<sha256_event_hash>",
  "pubkey": "<requester_pubkey_hex>",
  "created_at": 1234567890,
  "kind": 31115,
  "tags": [
    ["p", "<target_pubkey_hex>"],
    ["type", "payment_request"],
    ["amount", "1000000000"],
    ["recipient", "alice"]
  ],
  "content": "<NIP-04 encrypted content>",
  "sig": "<schnorr_signature_hex>"
}
```

### Tags

| Tag | Required | Description |
|-----|----------|-------------|
| `p` | Yes | Target's public key (who should pay) |
| `type` | Yes | Always `"payment_request"` |
| `amount` | Yes | Amount in smallest units (for filtering) |
| `recipient` | No | Recipient nametag (where to send payment) |

### Encrypted Content

The `content` field is NIP-04 encrypted. When decrypted:

```
payment_request:{"amount":"1000000000","coinId":"...","message":"...","recipientNametag":"alice","requestId":"a1b2c3d4"}
```

Note: The `coinId` precisely identifies the token type, so no separate symbol field is needed.

### Helper Functions

```typescript
// Check if event is a payment request
PaymentRequestProtocol.isPaymentRequest(event); // boolean

// Get metadata from tags
PaymentRequestProtocol.getAmount(event);           // bigint | undefined
PaymentRequestProtocol.getRecipientNametag(event); // string | undefined
PaymentRequestProtocol.getTarget(event);           // string | undefined
PaymentRequestProtocol.getSender(event);           // string

// Parse full request (requires decryption)
const parsed = await PaymentRequestProtocol.parsePaymentRequest(event, keyManager);
// Returns: { amount, coinId, message, recipientNametag, requestId, senderPubkey, timestamp, eventId }
```

## Browser Usage

### ES Modules

```html
<script type="module">
  import { NostrKeyManager, NostrClient } from '@unicitylabs/nostr-sdk';

  const keyManager = NostrKeyManager.generate();
  console.log(keyManager.getNpub());
</script>
```

### UMD (Script Tag)

```html
<script src="node_modules/@unicitylabs/nostr-sdk/dist/browser/index.umd.min.js"></script>
<script>
  const { NostrKeyManager, NostrClient } = UnicityNostr;

  const keyManager = NostrKeyManager.generate();
  console.log(keyManager.getNpub());
</script>
```

## API Reference

### Classes

- **NostrKeyManager** - Key pair management, signing, encryption
- **NostrClient** - Relay connections, event publishing, subscriptions
- **Event** - Nostr event creation, signing, verification
- **Filter** - Subscription filter building

### Modules

- **Bech32** - Bech32 encoding/decoding (npub, nsec)
- **SchnorrSigner** - BIP-340 Schnorr signatures
- **NIP04** - NIP-04 encryption/decryption (legacy)
- **NIP44** - NIP-44 encryption/decryption (ChaCha20-Poly1305)
- **NIP17** - NIP-17 private direct messages with gift-wrapping
- **EventKinds** - Event kind constants
- **NametagUtils** - Nametag normalization and hashing
- **NametagBinding** - Nametag binding event creation
- **TokenTransferProtocol** - Token transfer protocol
- **PaymentRequestProtocol** - Payment request protocol

## Event Kinds

| Kind | Name | Description |
|------|------|-------------|
| 0 | PROFILE | User profile metadata |
| 1 | TEXT_NOTE | Short text note |
| 4 | ENCRYPTED_DM | Encrypted direct message (NIP-04) |
| 13 | SEAL | Encrypted seal for gift-wrapping (NIP-17) |
| 14 | CHAT_MESSAGE | Private direct message rumor (NIP-17) |
| 15 | READ_RECEIPT | Read receipt rumor (NIP-17) |
| 1059 | GIFT_WRAP | Gift-wrapped message (NIP-17) |
| 22242 | AUTH | Client authentication to relay (NIP-42) |
| 30078 | APP_DATA | Application-specific data (nametag bindings) |
| 31111 | AGENT_PROFILE | Agent profile information |
| 31112 | AGENT_LOCATION | Agent GPS location |
| 31113 | TOKEN_TRANSFER | Unicity token transfer |
| 31114 | FILE_METADATA | File metadata |
| 31115 | PAYMENT_REQUEST | Payment request |

## Development

```bash
# Install dependencies
npm install

# Type checking
npm run build:check

# Run tests
npm test

# Build all bundles
npm run build

# Lint
npm run lint
```

## E2E Testing with Relay

### NIP-17 Private Messages

```bash
# Run NIP-17 E2E tests against real relay
npm test tests/integration/nip17-relay.test.ts

# Use a custom relay
NOSTR_TEST_RELAY=wss://your-relay.com npm test tests/integration/nip17-relay.test.ts
```

### Payment Requests (Manual)

To test payment requests against a real wallet:

```bash
# Send a single payment request
TARGET_NAMETAG=mp-9 npm test -- --testNamePattern="send single payment request"

# Send multiple payment requests (for UI testing)
TARGET_NAMETAG=mp-9 npm test -- --testNamePattern="send multiple payment requests"

# Full flow with token transfer verification (requires wallet interaction)
TARGET_NAMETAG=mp-9 npm test -- --testNamePattern="full payment request flow"
```

Environment variables:
- `TARGET_NAMETAG` - Nametag of the wallet to send requests to (required)
- `NOSTR_TEST_RELAY` - Relay URL (default: `wss://nostr-relay.testnet.unicity.network`)
- `AMOUNT` - Amount in smallest units (default: `1000000`)
- `TIMEOUT` - Timeout in seconds for full flow test (default: `120`)

## License

MIT
