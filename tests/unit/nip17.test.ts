/**
 * Unit tests for NIP-17 Private Direct Messages Protocol
 */

import { describe, it, expect } from 'vitest';
import { NostrKeyManager } from '../../src/NostrKeyManager.js';
import * as NIP17 from '../../src/messaging/nip17.js';
import * as EventKinds from '../../src/protocol/EventKinds.js';
import { isChatMessage, isReadReceipt } from '../../src/messaging/types.js';

describe('NIP17 Private Direct Messages', () => {
  describe('createGiftWrap and unwrap', () => {
    it('should create and unwrap a gift-wrapped message', () => {
      const alice = NostrKeyManager.generate();
      const bob = NostrKeyManager.generate();

      const message = 'Hello Bob! This is a private message.';

      // Alice creates a gift-wrapped message for Bob
      const giftWrap = NIP17.createGiftWrap(alice, bob.getPublicKeyHex(), message);

      // Verify gift wrap structure
      expect(giftWrap).toBeDefined();
      expect(giftWrap.kind).toBe(EventKinds.GIFT_WRAP);
      expect(giftWrap.id).toBeDefined();
      expect(giftWrap.sig).toBeDefined();
      expect(giftWrap.content).toBeDefined();

      // Gift wrap pubkey should be ephemeral (not Alice's)
      expect(giftWrap.pubkey).not.toBe(alice.getPublicKeyHex());

      // Gift wrap should have a "p" tag pointing to recipient
      const pTag = giftWrap.getTagValue('p');
      expect(pTag).toBe(bob.getPublicKeyHex());

      // Bob unwraps the message
      const privateMessage = NIP17.unwrap(giftWrap, bob);

      // Verify the unwrapped message
      expect(privateMessage).toBeDefined();
      expect(privateMessage.content).toBe(message);
      expect(privateMessage.senderPubkey).toBe(alice.getPublicKeyHex());
      expect(privateMessage.recipientPubkey).toBe(bob.getPublicKeyHex());
      expect(privateMessage.kind).toBe(EventKinds.CHAT_MESSAGE);
      expect(isChatMessage(privateMessage)).toBe(true);
      expect(isReadReceipt(privateMessage)).toBe(false);
      expect(privateMessage.replyToEventId).toBeUndefined();
    });

    it('should create and unwrap a reply message', () => {
      const alice = NostrKeyManager.generate();
      const bob = NostrKeyManager.generate();

      const originalEventId = 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd';
      const message = 'This is a reply!';

      // Alice creates a reply message
      const giftWrap = NIP17.createGiftWrap(
        alice,
        bob.getPublicKeyHex(),
        message,
        { replyToEventId: originalEventId }
      );

      // Bob unwraps
      const privateMessage = NIP17.unwrap(giftWrap, bob);

      expect(privateMessage.content).toBe(message);
      expect(privateMessage.replyToEventId).toBe(originalEventId);
    });

    it('should handle unicode messages', () => {
      const alice = NostrKeyManager.generate();
      const bob = NostrKeyManager.generate();

      const message = 'Hello! 中文 😀 Русский';

      const giftWrap = NIP17.createGiftWrap(alice, bob.getPublicKeyHex(), message);
      const privateMessage = NIP17.unwrap(giftWrap, bob);

      expect(privateMessage.content).toBe(message);
    });

    it('should handle minimal message (1 byte)', () => {
      const alice = NostrKeyManager.generate();
      const bob = NostrKeyManager.generate();

      const message = 'a';

      const giftWrap = NIP17.createGiftWrap(alice, bob.getPublicKeyHex(), message);
      const privateMessage = NIP17.unwrap(giftWrap, bob);

      expect(privateMessage.content).toBe(message);
    });

    it('should handle long messages', () => {
      const alice = NostrKeyManager.generate();
      const bob = NostrKeyManager.generate();

      // Create a reasonably long message (keep under ~30KB due to JSON overhead)
      const lines: string[] = [];
      for (let i = 0; i < 500; i++) {
        lines.push(`This is line ${i}. `);
      }
      const message = lines.join('');

      const giftWrap = NIP17.createGiftWrap(alice, bob.getPublicKeyHex(), message);
      const privateMessage = NIP17.unwrap(giftWrap, bob);

      expect(privateMessage.content).toBe(message);
    });
  });

  describe('createReadReceipt', () => {
    it('should create and unwrap a read receipt', () => {
      const alice = NostrKeyManager.generate();
      const bob = NostrKeyManager.generate();

      const messageEventId = 'msg123def456abc123def456abc123def456abc123def456abc123def456abcd';

      // Bob sends a read receipt to Alice
      const giftWrap = NIP17.createReadReceipt(bob, alice.getPublicKeyHex(), messageEventId);

      // Verify gift wrap structure
      expect(giftWrap.kind).toBe(EventKinds.GIFT_WRAP);

      // Alice unwraps the read receipt
      const receipt = NIP17.unwrap(giftWrap, alice);

      expect(receipt).toBeDefined();
      expect(receipt.kind).toBe(EventKinds.READ_RECEIPT);
      expect(isReadReceipt(receipt)).toBe(true);
      expect(isChatMessage(receipt)).toBe(false);
      expect(receipt.content).toBe(''); // Read receipts have empty content
      expect(receipt.senderPubkey).toBe(bob.getPublicKeyHex());
      expect(receipt.replyToEventId).toBe(messageEventId);
    });
  });

  describe('security', () => {
    it('should fail to unwrap with wrong recipient', () => {
      const alice = NostrKeyManager.generate();
      const bob = NostrKeyManager.generate();
      const eve = NostrKeyManager.generate();

      const message = 'Secret message for Bob only';

      // Alice creates a message for Bob
      const giftWrap = NIP17.createGiftWrap(alice, bob.getPublicKeyHex(), message);

      // Eve should not be able to unwrap
      expect(() => NIP17.unwrap(giftWrap, eve)).toThrow();
    });

    it('should use ephemeral key for gift wrap (different each time)', () => {
      const alice = NostrKeyManager.generate();
      const bob = NostrKeyManager.generate();

      // Create multiple gift wraps
      const giftWrap1 = NIP17.createGiftWrap(alice, bob.getPublicKeyHex(), 'Message 1');
      const giftWrap2 = NIP17.createGiftWrap(alice, bob.getPublicKeyHex(), 'Message 2');

      // Each should have a different ephemeral pubkey
      expect(giftWrap1.pubkey).not.toBe(giftWrap2.pubkey);

      // Neither should be Alice's pubkey
      expect(giftWrap1.pubkey).not.toBe(alice.getPublicKeyHex());
      expect(giftWrap2.pubkey).not.toBe(alice.getPublicKeyHex());

      // Both should still unwrap correctly
      const msg1 = NIP17.unwrap(giftWrap1, bob);
      const msg2 = NIP17.unwrap(giftWrap2, bob);

      expect(msg1.content).toBe('Message 1');
      expect(msg2.content).toBe('Message 2');

      // Both should identify Alice as the sender
      expect(msg1.senderPubkey).toBe(alice.getPublicKeyHex());
      expect(msg2.senderPubkey).toBe(alice.getPublicKeyHex());
    });

    it('should randomize gift wrap timestamp (+/- 2 days)', () => {
      const alice = NostrKeyManager.generate();
      const bob = NostrKeyManager.generate();

      const now = Math.floor(Date.now() / 1000);
      const giftWrap = NIP17.createGiftWrap(alice, bob.getPublicKeyHex(), 'Test message');

      // Gift wrap timestamp should be randomized (+/- 2 days)
      const twoDays = 2 * 24 * 60 * 60;
      const timestamp = giftWrap.created_at;
      const buffer = 60; // 1 minute buffer for test execution

      expect(timestamp).toBeGreaterThanOrEqual(now - twoDays - buffer);
      expect(timestamp).toBeLessThanOrEqual(now + twoDays + buffer);
    });

    it('should produce unique event IDs', () => {
      const alice = NostrKeyManager.generate();
      const bob = NostrKeyManager.generate();

      const giftWrap1 = NIP17.createGiftWrap(alice, bob.getPublicKeyHex(), 'Message');
      const giftWrap2 = NIP17.createGiftWrap(alice, bob.getPublicKeyHex(), 'Message');

      // Event IDs should be unique
      expect(giftWrap1.id).not.toBe(giftWrap2.id);
    });
  });

  describe('validation', () => {
    it('should reject event with wrong kind', () => {
      const bob = NostrKeyManager.generate();

      // Create a fake event with wrong kind
      const fakeEvent = {
        id: 'abc123',
        pubkey: 'def456',
        created_at: Date.now() / 1000,
        kind: EventKinds.ENCRYPTED_DM, // Wrong kind (should be GIFT_WRAP)
        tags: [],
        content: 'fake',
        sig: 'fake',
        getTagValue: () => null,
      };

      expect(() => NIP17.unwrap(fakeEvent as any, bob))
        .toThrow(/not a gift wrap/);
    });
  });

  describe('message types helper functions', () => {
    it('should correctly identify chat messages', () => {
      const message = {
        eventId: 'test',
        senderPubkey: 'sender',
        recipientPubkey: 'recipient',
        content: 'Hello',
        timestamp: Date.now() / 1000,
        kind: EventKinds.CHAT_MESSAGE,
      };

      expect(isChatMessage(message)).toBe(true);
      expect(isReadReceipt(message)).toBe(false);
    });

    it('should correctly identify read receipts', () => {
      const receipt = {
        eventId: 'test',
        senderPubkey: 'sender',
        recipientPubkey: 'recipient',
        content: '',
        timestamp: Date.now() / 1000,
        kind: EventKinds.READ_RECEIPT,
        replyToEventId: 'original',
      };

      expect(isReadReceipt(receipt)).toBe(true);
      expect(isChatMessage(receipt)).toBe(false);
    });
  });
});
