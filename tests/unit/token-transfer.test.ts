/**
 * Unit tests for TokenTransferProtocol
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as TokenTransferProtocol from '../../src/token/TokenTransferProtocol.js';
import { NostrKeyManager } from '../../src/NostrKeyManager.js';
import * as EventKinds from '../../src/protocol/EventKinds.js';

describe('TokenTransferProtocol', () => {
  let sender: NostrKeyManager;
  let recipient: NostrKeyManager;

  beforeEach(() => {
    sender = NostrKeyManager.generate();
    recipient = NostrKeyManager.generate();
  });

  describe('createTokenTransferEvent', () => {
    it('should create a valid token transfer event', async () => {
      const tokenJson = JSON.stringify({ type: 'token', amount: 100 });

      const event = await TokenTransferProtocol.createTokenTransferEvent(
        sender,
        recipient.getPublicKeyHex(),
        tokenJson
      );

      expect(event.kind).toBe(EventKinds.TOKEN_TRANSFER);
      expect(event.pubkey).toBe(sender.getPublicKeyHex());
      expect(event.verify()).toBe(true);
    });

    it('should include recipient tag', async () => {
      const tokenJson = '{"test": true}';

      const event = await TokenTransferProtocol.createTokenTransferEvent(
        sender,
        recipient.getPublicKeyHex(),
        tokenJson
      );

      expect(event.getTagValue('p')).toBe(recipient.getPublicKeyHex());
    });

    it('should include type tag', async () => {
      const tokenJson = '{"test": true}';

      const event = await TokenTransferProtocol.createTokenTransferEvent(
        sender,
        recipient.getPublicKeyHex(),
        tokenJson
      );

      expect(event.getTagValue('type')).toBe('token_transfer');
    });

    it('should include optional amount and symbol', async () => {
      const tokenJson = '{"test": true}';

      const event = await TokenTransferProtocol.createTokenTransferEvent(
        sender,
        recipient.getPublicKeyHex(),
        tokenJson,
        1000,
        'UNIT'
      );

      expect(event.getTagValue('amount')).toBe('1000');
      expect(event.getTagValue('symbol')).toBe('UNIT');
    });

    it('should handle bigint amount', async () => {
      const tokenJson = '{"test": true}';

      const event = await TokenTransferProtocol.createTokenTransferEvent(
        sender,
        recipient.getPublicKeyHex(),
        tokenJson,
        BigInt('1000000000000000000'),
        'TOKEN'
      );

      expect(event.getTagValue('amount')).toBe('1000000000000000000');
    });

    it('should encrypt the content', async () => {
      const tokenJson = '{"secret": "data"}';

      const event = await TokenTransferProtocol.createTokenTransferEvent(
        sender,
        recipient.getPublicKeyHex(),
        tokenJson
      );

      // Content should not contain the original JSON in plaintext
      expect(event.content).not.toContain('secret');
      expect(event.content).not.toContain('data');

      // Content should be in NIP-04 format
      expect(event.content).toContain('?iv=');
    });
  });

  describe('parseTokenTransfer', () => {
    it('should decrypt and parse token transfer as recipient', async () => {
      const tokenJson = JSON.stringify({ type: 'token', amount: 100 });

      const event = await TokenTransferProtocol.createTokenTransferEvent(
        sender,
        recipient.getPublicKeyHex(),
        tokenJson
      );

      const parsed = await TokenTransferProtocol.parseTokenTransfer(event, recipient);

      expect(JSON.parse(parsed)).toEqual({ type: 'token', amount: 100 });
    });

    it('should decrypt and parse token transfer as sender', async () => {
      const tokenJson = JSON.stringify({ message: 'test' });

      const event = await TokenTransferProtocol.createTokenTransferEvent(
        sender,
        recipient.getPublicKeyHex(),
        tokenJson
      );

      const parsed = await TokenTransferProtocol.parseTokenTransfer(event, sender);

      expect(JSON.parse(parsed)).toEqual({ message: 'test' });
    });

    it('should handle complex JSON token data', async () => {
      const tokenJson = JSON.stringify({
        id: 'token123',
        owner: 'address456',
        history: [
          { type: 'mint', timestamp: 1234567890 },
          { type: 'transfer', timestamp: 1234567900 },
        ],
        metadata: {
          name: 'Test Token',
          decimals: 18,
        },
      });

      const event = await TokenTransferProtocol.createTokenTransferEvent(
        sender,
        recipient.getPublicKeyHex(),
        tokenJson
      );

      const parsed = await TokenTransferProtocol.parseTokenTransfer(event, recipient);

      expect(JSON.parse(parsed).id).toBe('token123');
      expect(JSON.parse(parsed).history).toHaveLength(2);
    });

    it('should reject non-token-transfer events', async () => {
      const { Event } = await import('../../src/protocol/Event.js');
      const event = Event.create(sender, {
        kind: 1, // Wrong kind
        tags: [],
        content: 'test',
      });

      await expect(
        TokenTransferProtocol.parseTokenTransfer(event, recipient)
      ).rejects.toThrow(/not a token transfer/);
    });

    it('should reject events with wrong type tag', async () => {
      const { Event } = await import('../../src/protocol/Event.js');
      const event = Event.create(sender, {
        kind: EventKinds.TOKEN_TRANSFER,
        tags: [['type', 'wrong_type']],
        content: 'test',
      });

      await expect(
        TokenTransferProtocol.parseTokenTransfer(event, recipient)
      ).rejects.toThrow(/type is not token_transfer/);
    });
  });

  describe('getAmount', () => {
    it('should return amount from tag', async () => {
      const event = await TokenTransferProtocol.createTokenTransferEvent(
        sender,
        recipient.getPublicKeyHex(),
        '{}',
        12345
      );

      expect(TokenTransferProtocol.getAmount(event)).toBe(BigInt(12345));
    });

    it('should return undefined when no amount', async () => {
      const event = await TokenTransferProtocol.createTokenTransferEvent(
        sender,
        recipient.getPublicKeyHex(),
        '{}'
      );

      expect(TokenTransferProtocol.getAmount(event)).toBeUndefined();
    });
  });

  describe('getSymbol', () => {
    it('should return symbol from tag', async () => {
      const event = await TokenTransferProtocol.createTokenTransferEvent(
        sender,
        recipient.getPublicKeyHex(),
        '{}',
        100,
        'UNIT'
      );

      expect(TokenTransferProtocol.getSymbol(event)).toBe('UNIT');
    });

    it('should return undefined when no symbol', async () => {
      const event = await TokenTransferProtocol.createTokenTransferEvent(
        sender,
        recipient.getPublicKeyHex(),
        '{}'
      );

      expect(TokenTransferProtocol.getSymbol(event)).toBeUndefined();
    });
  });

  describe('isTokenTransfer', () => {
    it('should return true for valid token transfer', async () => {
      const event = await TokenTransferProtocol.createTokenTransferEvent(
        sender,
        recipient.getPublicKeyHex(),
        '{}'
      );

      expect(TokenTransferProtocol.isTokenTransfer(event)).toBe(true);
    });

    it('should return false for non-token events', async () => {
      const { Event } = await import('../../src/protocol/Event.js');
      const event = Event.create(sender, {
        kind: 1,
        tags: [],
        content: 'test',
      });

      expect(TokenTransferProtocol.isTokenTransfer(event)).toBe(false);
    });
  });

  describe('getRecipient', () => {
    it('should return recipient public key', async () => {
      const event = await TokenTransferProtocol.createTokenTransferEvent(
        sender,
        recipient.getPublicKeyHex(),
        '{}'
      );

      expect(TokenTransferProtocol.getRecipient(event)).toBe(recipient.getPublicKeyHex());
    });
  });

  describe('getSender', () => {
    it('should return sender public key', async () => {
      const event = await TokenTransferProtocol.createTokenTransferEvent(
        sender,
        recipient.getPublicKeyHex(),
        '{}'
      );

      expect(TokenTransferProtocol.getSender(event)).toBe(sender.getPublicKeyHex());
    });
  });

  describe('compression', () => {
    it('should compress large token data', async () => {
      // Create a large, compressible token JSON
      const largeData = {
        transactions: Array(100).fill({
          type: 'transfer',
          amount: 1000,
          timestamp: 1234567890,
          signature: 'a'.repeat(64),
        }),
      };
      const tokenJson = JSON.stringify(largeData);

      expect(tokenJson.length).toBeGreaterThan(1024);

      const event = await TokenTransferProtocol.createTokenTransferEvent(
        sender,
        recipient.getPublicKeyHex(),
        tokenJson
      );

      // Should still be able to parse
      const parsed = await TokenTransferProtocol.parseTokenTransfer(event, recipient);
      expect(JSON.parse(parsed).transactions).toHaveLength(100);
    });
  });
});
