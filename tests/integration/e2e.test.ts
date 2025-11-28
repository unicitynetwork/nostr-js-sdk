/**
 * End-to-end tests for the complete SDK workflow
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  NostrKeyManager,
  Event,
  Filter,
  EventKinds,
  NametagUtils,
  NametagBinding,
  TokenTransferProtocol,
  PaymentRequestProtocol,
} from '../../src/index.js';

describe('E2E: Key Management', () => {
  it('should complete full key lifecycle', () => {
    // Generate new keys
    const keyManager = NostrKeyManager.generate();

    // Export in various formats
    const privateKeyHex = keyManager.getPrivateKeyHex();
    const nsec = keyManager.getNsec();
    const npub = keyManager.getNpub();

    // Import from each format and verify
    const fromHex = NostrKeyManager.fromPrivateKeyHex(privateKeyHex);
    const fromNsec = NostrKeyManager.fromNsec(nsec);

    expect(fromHex.getPublicKeyHex()).toBe(keyManager.getPublicKeyHex());
    expect(fromNsec.getPublicKeyHex()).toBe(keyManager.getPublicKeyHex());
    expect(fromHex.getNpub()).toBe(npub);
  });

  it('should sign and verify messages', () => {
    const keyManager = NostrKeyManager.generate();
    const message = new Uint8Array(32).fill(0x42);

    // Sign
    const signature = keyManager.sign(message);

    // Verify
    const valid = NostrKeyManager.verify(
      signature,
      message,
      keyManager.getPublicKey()
    );

    expect(valid).toBe(true);
  });
});

describe('E2E: Encrypted Communication', () => {
  it('should encrypt and decrypt messages between two users', async () => {
    const alice = NostrKeyManager.generate();
    const bob = NostrKeyManager.generate();

    const originalMessage = 'Hello Bob! This is a secret message from Alice.';

    // Alice encrypts for Bob
    const encrypted = await alice.encryptHex(originalMessage, bob.getPublicKeyHex());

    // Bob decrypts from Alice
    const decrypted = await bob.decryptHex(encrypted, alice.getPublicKeyHex());

    expect(decrypted).toBe(originalMessage);

    // Also verify Alice can decrypt her own message
    const aliceDecrypted = await alice.decryptHex(encrypted, bob.getPublicKeyHex());
    expect(aliceDecrypted).toBe(originalMessage);
  });

  it('should handle unicode and special characters', async () => {
    const alice = NostrKeyManager.generate();
    const bob = NostrKeyManager.generate();

    const messages = [
      '🚀 Emoji test! 🎉',
      '中文测试',
      'مرحبا',
      'שלום',
      'Special chars: <>&"\' `~!@#$%^&*()',
      'Newlines:\nLine 1\nLine 2\nLine 3',
      'Tab:\tIndented',
    ];

    for (const message of messages) {
      const encrypted = await alice.encryptHex(message, bob.getPublicKeyHex());
      const decrypted = await bob.decryptHex(encrypted, alice.getPublicKeyHex());
      expect(decrypted).toBe(message);
    }
  });

  it('should compress large messages', async () => {
    const alice = NostrKeyManager.generate();
    const bob = NostrKeyManager.generate();

    // Create a large, compressible message (> 1KB)
    const largeMessage = 'This is a repetitive message. '.repeat(100);
    expect(largeMessage.length).toBeGreaterThan(1024);

    const encrypted = await alice.encryptHex(largeMessage, bob.getPublicKeyHex());

    // Verify compression is being used
    expect(encrypted.startsWith('gz:')).toBe(true);

    // Verify decryption works
    const decrypted = await bob.decryptHex(encrypted, alice.getPublicKeyHex());
    expect(decrypted).toBe(largeMessage);
  });
});

describe('E2E: Event Creation and Verification', () => {
  it('should create valid Nostr events', () => {
    const keyManager = NostrKeyManager.generate();

    const event = Event.create(keyManager, {
      kind: EventKinds.TEXT_NOTE,
      tags: [
        ['t', 'test'],
        ['e', 'referenced_event_id'],
      ],
      content: 'This is a test event',
    });

    // Verify event structure
    expect(event.id).toHaveLength(64);
    expect(event.pubkey).toBe(keyManager.getPublicKeyHex());
    expect(event.kind).toBe(1);
    expect(event.sig).toHaveLength(128);

    // Verify signature
    expect(event.verify()).toBe(true);

    // Verify JSON round-trip
    const json = event.toJSON();
    const restored = Event.fromJSON(json);
    expect(restored.verify()).toBe(true);
    expect(restored.id).toBe(event.id);
  });

  it('should detect tampered events', () => {
    const keyManager = NostrKeyManager.generate();

    const event = Event.create(keyManager, {
      kind: EventKinds.TEXT_NOTE,
      tags: [],
      content: 'Original content',
    });

    expect(event.verify()).toBe(true);

    // Tamper with content
    event.content = 'Tampered content';
    expect(event.verify()).toBe(false);
  });
});

describe('E2E: Token Transfer', () => {
  it('should complete token transfer workflow', async () => {
    const sender = NostrKeyManager.generate();
    const recipient = NostrKeyManager.generate();

    // Create token data
    const tokenData = {
      id: 'token-12345',
      type: 'fungible',
      amount: '1000000000000000000', // 1 token with 18 decimals
      symbol: 'UNIT',
      owner: recipient.getPublicKeyHex(),
      previousOwner: sender.getPublicKeyHex(),
      transferHistory: [
        { from: 'mint', to: sender.getPublicKeyHex(), timestamp: Date.now() - 86400000 },
        { from: sender.getPublicKeyHex(), to: recipient.getPublicKeyHex(), timestamp: Date.now() },
      ],
    };

    // Create transfer event
    const event = await TokenTransferProtocol.createTokenTransferEvent(
      sender,
      recipient.getPublicKeyHex(),
      JSON.stringify(tokenData),
      BigInt(tokenData.amount),
      tokenData.symbol
    );

    // Verify event structure
    expect(event.kind).toBe(EventKinds.TOKEN_TRANSFER);
    expect(event.verify()).toBe(true);
    expect(TokenTransferProtocol.isTokenTransfer(event)).toBe(true);
    expect(TokenTransferProtocol.getRecipient(event)).toBe(recipient.getPublicKeyHex());
    expect(TokenTransferProtocol.getSender(event)).toBe(sender.getPublicKeyHex());
    expect(TokenTransferProtocol.getAmount(event)).toBe(BigInt(tokenData.amount));
    expect(TokenTransferProtocol.getSymbol(event)).toBe('UNIT');

    // Recipient parses the transfer
    const parsedJson = await TokenTransferProtocol.parseTokenTransfer(event, recipient);
    const parsed = JSON.parse(parsedJson);

    expect(parsed.id).toBe(tokenData.id);
    expect(parsed.amount).toBe(tokenData.amount);
    expect(parsed.transferHistory).toHaveLength(2);

    // Sender can also parse (to verify what was sent)
    const senderParsed = await TokenTransferProtocol.parseTokenTransfer(event, sender);
    expect(JSON.parse(senderParsed).id).toBe(tokenData.id);
  });
});

describe('E2E: Nametag Binding', () => {
  it('should complete nametag binding workflow', async () => {
    const keyManager = NostrKeyManager.generate();
    const unicityAddress = 'unicity_addr_0x' + '1234567890abcdef'.repeat(4);

    // Test different nametag formats
    const nametags = [
      'alice',
      'Alice@unicity',
      '+14155551234',
      '(415) 555-1234',
    ];

    for (const nametag of nametags) {
      // Create binding event
      const event = await NametagBinding.createBindingEvent(
        keyManager,
        nametag,
        unicityAddress
      );

      // Verify event
      expect(event.verify()).toBe(true);
      expect(NametagBinding.isValidBindingEvent(event)).toBe(true);

      // Parse binding
      const hash = NametagBinding.parseNametagHashFromEvent(event);
      const address = NametagBinding.parseAddressFromEvent(event);

      expect(hash).toBe(NametagUtils.hashNametag(nametag));
      expect(address).toBe(unicityAddress);
    }
  });

  it('should match nametags correctly', () => {
    // These should all hash to the same value
    const phoneVariants = ['+14155551234', '415-555-1234', '(415) 555-1234'];

    const hashes = phoneVariants.map((p) => NametagUtils.hashNametag(p, 'US'));

    // All hashes should be the same
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[1]).toBe(hashes[2]);

    // Username variations
    expect(NametagUtils.hashNametag('alice')).toBe(NametagUtils.hashNametag('Alice'));
    expect(NametagUtils.hashNametag('bob')).toBe(NametagUtils.hashNametag('bob@unicity'));
  });

  it('should create correct filters', () => {
    const nametag = 'alice';
    const pubkey = 'a'.repeat(64);

    // Nametag to pubkey filter
    const ntpFilter = NametagBinding.createNametagToPubkeyFilter(nametag);
    expect(ntpFilter.kinds).toContain(EventKinds.APP_DATA);
    expect(ntpFilter['#t']).toContain(NametagUtils.hashNametag(nametag));

    // Pubkey to nametag filter
    const ptnFilter = NametagBinding.createPubkeyToNametagFilter(pubkey);
    expect(ptnFilter.kinds).toContain(EventKinds.APP_DATA);
    expect(ptnFilter.authors).toContain(pubkey);
  });
});

describe('E2E: Filter Building', () => {
  it('should build complex filters', () => {
    const now = Math.floor(Date.now() / 1000);
    const dayAgo = now - 86400;

    const filter = Filter.builder()
      .authors('author1', 'author2')
      .kinds(EventKinds.TEXT_NOTE, EventKinds.ENCRYPTED_DM)
      .pTags('mentioned_pubkey')
      .since(dayAgo)
      .until(now)
      .limit(100)
      .build();

    const json = filter.toJSON();

    expect(json.authors).toEqual(['author1', 'author2']);
    expect(json.kinds).toEqual([1, 4]);
    expect(json['#p']).toEqual(['mentioned_pubkey']);
    expect(json.since).toBe(dayAgo);
    expect(json.until).toBe(now);
    expect(json.limit).toBe(100);
  });
});

describe('E2E: Payment Request', () => {
  it('should complete payment request workflow', async () => {
    const requester = NostrKeyManager.generate();
    const target = NostrKeyManager.generate();

    // Solana coin ID (example)
    const SOLANA_COIN_ID = 'dee5f8ce778562eec90e9c38a91296a023210ccc76ff4c29d527ac3eb64ade93';

    // Create payment request
    const request = {
      amount: BigInt(1_000_000_000), // 1 SOL (9 decimals)
      coinId: SOLANA_COIN_ID,
      message: 'Payment for services rendered',
      recipientNametag: 'alice-merchant',
    };

    // Create payment request event
    const event = await PaymentRequestProtocol.createPaymentRequestEvent(
      requester,
      target.getPublicKeyHex(),
      request
    );

    // Verify event structure
    expect(event.kind).toBe(EventKinds.PAYMENT_REQUEST);
    expect(event.verify()).toBe(true);
    expect(PaymentRequestProtocol.isPaymentRequest(event)).toBe(true);
    expect(PaymentRequestProtocol.getTarget(event)).toBe(target.getPublicKeyHex());
    expect(PaymentRequestProtocol.getSender(event)).toBe(requester.getPublicKeyHex());
    expect(PaymentRequestProtocol.getAmount(event)).toBe(BigInt(1_000_000_000));
    expect(PaymentRequestProtocol.getRecipientNametag(event)).toBe('alice-merchant');

    // Target parses the request
    const parsed = await PaymentRequestProtocol.parsePaymentRequest(event, target);

    expect(parsed.amount).toBe(BigInt(1_000_000_000));
    expect(parsed.coinId).toBe(SOLANA_COIN_ID);
    expect(parsed.message).toBe('Payment for services rendered');
    expect(parsed.recipientNametag).toBe('alice-merchant');
    expect(parsed.senderPubkey).toBe(requester.getPublicKeyHex());

    // Requester can also verify (to check what was sent)
    const requesterParsed = await PaymentRequestProtocol.parsePaymentRequest(event, requester);
    expect(requesterParsed.amount).toBe(parsed.amount);
    expect(requesterParsed.recipientNametag).toBe(parsed.recipientNametag);
  });

  it('should handle multiple payment requests', async () => {
    const merchant = NostrKeyManager.generate();
    const customer = NostrKeyManager.generate();

    const SOLANA_COIN_ID = 'dee5f8ce778562eec90e9c38a91296a023210ccc76ff4c29d527ac3eb64ade93';

    const requests = [
      { amount: BigInt(500_000_000), message: 'Coffee' },
      { amount: BigInt(1_500_000_000), message: 'Lunch' },
      { amount: BigInt(10_000_000_000), message: 'Subscription' },
    ];

    const events = [];
    for (const req of requests) {
      const event = await PaymentRequestProtocol.createPaymentRequestEvent(
        merchant,
        customer.getPublicKeyHex(),
        {
          ...req,
          coinId: SOLANA_COIN_ID,
          recipientNametag: 'merchant-store',
        }
      );
      events.push(event);
    }

    // All events should be valid
    for (let i = 0; i < events.length; i++) {
      expect(events[i].verify()).toBe(true);
      const parsed = await PaymentRequestProtocol.parsePaymentRequest(events[i], customer);
      expect(parsed.amount).toBe(requests[i].amount);
      expect(parsed.message).toBe(requests[i].message);
    }
  });

  it('should format and display amounts correctly', () => {
    // Test amount formatting with different decimal places
    expect(PaymentRequestProtocol.formatAmount(BigInt(1_000_000_000), 9)).toBe('1');     // 9 decimals (SOL)
    expect(PaymentRequestProtocol.formatAmount(BigInt(500_000_000), 9)).toBe('0.5');     // 9 decimals (SOL)
    expect(PaymentRequestProtocol.formatAmount(BigInt(1_000_000), 9)).toBe('0.001');     // 9 decimals (SOL)
    expect(PaymentRequestProtocol.formatAmount(BigInt(100_000_000), 8)).toBe('1');       // 8 decimals (BTC)
    expect(PaymentRequestProtocol.formatAmount(BigInt(1_000_000), 6)).toBe('1');         // 6 decimals (USDC)
  });

  it('should work with subscription filters', () => {
    const customer = NostrKeyManager.generate();

    // Create filter for incoming payment requests
    const filter = Filter.builder()
      .kinds(EventKinds.PAYMENT_REQUEST)
      .pTags(customer.getPublicKeyHex())
      .since(Math.floor(Date.now() / 1000) - 3600)
      .build();

    const json = filter.toJSON();

    expect(json.kinds).toContain(EventKinds.PAYMENT_REQUEST);
    expect(json['#p']).toContain(customer.getPublicKeyHex());
    expect(json.since).toBeDefined();
  });
});

describe('E2E: Complete Communication Flow', () => {
  it('should simulate full messaging flow', async () => {
    // Setup users
    const alice = NostrKeyManager.generate();
    const bob = NostrKeyManager.generate();

    // Alice creates a public text note
    const publicNote = Event.create(alice, {
      kind: EventKinds.TEXT_NOTE,
      tags: [['p', bob.getPublicKeyHex()]], // Mentions Bob
      content: 'Hello everyone! @bob',
    });

    expect(publicNote.verify()).toBe(true);

    // Bob creates a filter to find mentions
    const mentionFilter = Filter.builder()
      .kinds(EventKinds.TEXT_NOTE)
      .pTags(bob.getPublicKeyHex())
      .build();

    // The filter would match Alice's note (in a real relay scenario)
    expect(mentionFilter['#p']).toContain(bob.getPublicKeyHex());

    // Alice sends an encrypted DM to Bob
    const secretMessage = 'Hey Bob, check out this token!';
    const encryptedContent = await alice.encryptHex(secretMessage, bob.getPublicKeyHex());

    const dmEvent = Event.create(alice, {
      kind: EventKinds.ENCRYPTED_DM,
      tags: [['p', bob.getPublicKeyHex()]],
      content: encryptedContent,
    });

    expect(dmEvent.verify()).toBe(true);

    // Bob receives and decrypts the DM
    const decrypted = await bob.decryptHex(dmEvent.content, alice.getPublicKeyHex());
    expect(decrypted).toBe(secretMessage);

    // Alice sends a token transfer to Bob
    const tokenJson = JSON.stringify({
      tokenId: 'token-abc-123',
      amount: '100',
    });

    const transferEvent = await TokenTransferProtocol.createTokenTransferEvent(
      alice,
      bob.getPublicKeyHex(),
      tokenJson,
      100,
      'UNIC'
    );

    expect(transferEvent.verify()).toBe(true);

    // Bob parses the token transfer
    const receivedToken = await TokenTransferProtocol.parseTokenTransfer(transferEvent, bob);
    expect(JSON.parse(receivedToken).tokenId).toBe('token-abc-123');
  });
});
