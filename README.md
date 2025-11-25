# Unicity Nostr SDK

A TypeScript SDK for Nostr protocol with Unicity extensions. Works in both Node.js and browser environments.

## Features

- **BIP-340 Schnorr Signatures** - Full support for secp256k1 Schnorr signatures
- **NIP-04 Encryption** - AES-256-CBC encryption with ECDH key agreement
- **GZIP Compression** - Automatic compression for large messages (>1KB)
- **Multi-Relay Support** - Connect to multiple relays with automatic reconnection
- **Token Transfers** - Encrypted Unicity token transfers over Nostr
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
import { NostrClient, NostrKeyManager } from '@unicitylabs/nostr-sdk';

const keyManager = NostrKeyManager.generate();
const client = new NostrClient(keyManager);

// Connect to relays
await client.connect(
  'wss://relay.damus.io',
  'wss://nos.lol'
);

// Check connection status
console.log(client.isConnected());
console.log(client.getConnectedRelays());
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

### Encrypted Direct Messages

```typescript
// Send encrypted DM
const recipientPubkey = '...';
await client.publishEncryptedMessage(recipientPubkey, 'Secret message');

// Or encrypt manually
const encrypted = await keyManager.encryptHex('Hello!', recipientPubkey);
const decrypted = await keyManager.decryptHex(encrypted, senderPubkey);
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
import { TokenTransferProtocol } from '@unicitylabs/nostr-sdk';

// Create token transfer event
const event = await TokenTransferProtocol.createTokenTransferEvent(
  keyManager,
  recipientPubkey,
  JSON.stringify({ tokenId: '...', amount: 100 }),
  100n,  // amount (optional metadata)
  'UNIT' // symbol (optional metadata)
);

await client.publishEvent(event);

// Parse received token transfer
const tokenJson = await TokenTransferProtocol.parseTokenTransfer(event, keyManager);
```

### Nametag Bindings

```typescript
import { NametagBinding, NametagUtils } from '@unicitylabs/nostr-sdk';

// Hash a nametag (privacy-preserving)
const hash = NametagUtils.hashNametag('+14155551234', 'US');

// Create binding event
const event = await NametagBinding.createBindingEvent(
  keyManager,
  '+14155551234',
  'unicity_address_...'
);

await client.publishEvent(event);

// Query pubkey by nametag
const pubkey = await client.queryPubkeyByNametag('+14155551234');
```

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
TokenTransferProtocol.getAmount(event);    // bigint | undefined
TokenTransferProtocol.getSymbol(event);    // string | undefined
TokenTransferProtocol.getRecipient(event); // string | undefined
TokenTransferProtocol.getSender(event);    // string
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
- **NIP04** - NIP-04 encryption/decryption
- **EventKinds** - Event kind constants
- **NametagUtils** - Nametag normalization and hashing
- **NametagBinding** - Nametag binding event creation
- **TokenTransferProtocol** - Token transfer protocol

## Event Kinds

| Kind | Name | Description |
|------|------|-------------|
| 0 | PROFILE | User profile metadata |
| 1 | TEXT_NOTE | Short text note |
| 4 | ENCRYPTED_DM | Encrypted direct message |
| 30078 | APP_DATA | Application-specific data |
| 31113 | TOKEN_TRANSFER | Unicity token transfer |

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

## License

MIT
