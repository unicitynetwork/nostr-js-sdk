/**
 * Unit tests for PaymentRequestProtocol
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as PaymentRequestProtocol from '../../src/payment/PaymentRequestProtocol.js';
import { NostrKeyManager } from '../../src/NostrKeyManager.js';
import * as EventKinds from '../../src/protocol/EventKinds.js';

describe('PaymentRequestProtocol', () => {
  let requester: NostrKeyManager;
  let target: NostrKeyManager;

  // Solana coin ID (example)
  const SOLANA_COIN_ID = 'dee5f8ce778562eec90e9c38a91296a023210ccc76ff4c29d527ac3eb64ade93';

  beforeEach(() => {
    requester = NostrKeyManager.generate();
    target = NostrKeyManager.generate();
  });

  describe('createPaymentRequestEvent', () => {
    it('should create a valid payment request event', async () => {
      const request: PaymentRequestProtocol.PaymentRequest = {
        amount: BigInt(1000000),
        coinId: SOLANA_COIN_ID,
        message: 'Payment for coffee',
        recipientNametag: 'alice',
      };

      const event = await PaymentRequestProtocol.createPaymentRequestEvent(
        requester,
        target.getPublicKeyHex(),
        request
      );

      expect(event.kind).toBe(EventKinds.PAYMENT_REQUEST);
      expect(event.pubkey).toBe(requester.getPublicKeyHex());
      expect(event.verify()).toBe(true);
    });

    it('should include target p tag', async () => {
      const request: PaymentRequestProtocol.PaymentRequest = {
        amount: 1000000,
        coinId: SOLANA_COIN_ID,
        recipientNametag: 'alice',
      };

      const event = await PaymentRequestProtocol.createPaymentRequestEvent(
        requester,
        target.getPublicKeyHex(),
        request
      );

      expect(event.getTagValue('p')).toBe(target.getPublicKeyHex());
    });

    it('should include type tag', async () => {
      const request: PaymentRequestProtocol.PaymentRequest = {
        amount: 1000000,
        coinId: SOLANA_COIN_ID,
        recipientNametag: 'alice',
      };

      const event = await PaymentRequestProtocol.createPaymentRequestEvent(
        requester,
        target.getPublicKeyHex(),
        request
      );

      expect(event.getTagValue('type')).toBe('payment_request');
    });

    it('should include amount and recipient tags', async () => {
      const request: PaymentRequestProtocol.PaymentRequest = {
        amount: BigInt(1500000),
        coinId: SOLANA_COIN_ID,
        recipientNametag: 'merchant-1',
      };

      const event = await PaymentRequestProtocol.createPaymentRequestEvent(
        requester,
        target.getPublicKeyHex(),
        request
      );

      expect(event.getTagValue('amount')).toBe('1500000');
      expect(event.getTagValue('recipient')).toBe('merchant-1');
    });

    it('should handle number amount', async () => {
      const request: PaymentRequestProtocol.PaymentRequest = {
        amount: 2000000,
        coinId: SOLANA_COIN_ID,
        recipientNametag: 'shop',
      };

      const event = await PaymentRequestProtocol.createPaymentRequestEvent(
        requester,
        target.getPublicKeyHex(),
        request
      );

      expect(event.getTagValue('amount')).toBe('2000000');
    });

    it('should encrypt the content', async () => {
      const request: PaymentRequestProtocol.PaymentRequest = {
        amount: 1000000,
        coinId: SOLANA_COIN_ID,
        message: 'Secret payment message',
        recipientNametag: 'alice',
      };

      const event = await PaymentRequestProtocol.createPaymentRequestEvent(
        requester,
        target.getPublicKeyHex(),
        request
      );

      // Content should not contain the original data in plaintext
      expect(event.content).not.toContain('Secret');
      expect(event.content).not.toContain('alice');

      // Content should be in NIP-04 format
      expect(event.content).toContain('?iv=');
    });

    it('should generate requestId if not provided', async () => {
      const request: PaymentRequestProtocol.PaymentRequest = {
        amount: 1000000,
        coinId: SOLANA_COIN_ID,
        recipientNametag: 'alice',
      };

      const event = await PaymentRequestProtocol.createPaymentRequestEvent(
        requester,
        target.getPublicKeyHex(),
        request
      );

      const parsed = await PaymentRequestProtocol.parsePaymentRequest(event, target);
      expect(parsed.requestId).toBeDefined();
      expect(parsed.requestId.length).toBe(8); // 4 bytes = 8 hex chars
    });

    it('should use provided requestId', async () => {
      const request: PaymentRequestProtocol.PaymentRequest = {
        amount: 1000000,
        coinId: SOLANA_COIN_ID,
        recipientNametag: 'alice',
        requestId: 'custom123',
      };

      const event = await PaymentRequestProtocol.createPaymentRequestEvent(
        requester,
        target.getPublicKeyHex(),
        request
      );

      const parsed = await PaymentRequestProtocol.parsePaymentRequest(event, target);
      expect(parsed.requestId).toBe('custom123');
    });
  });

  describe('parsePaymentRequest', () => {
    it('should decrypt and parse payment request as target', async () => {
      const request: PaymentRequestProtocol.PaymentRequest = {
        amount: BigInt(1000000),
        coinId: SOLANA_COIN_ID,
        message: 'Coffee payment',
        recipientNametag: 'alice',
      };

      const event = await PaymentRequestProtocol.createPaymentRequestEvent(
        requester,
        target.getPublicKeyHex(),
        request
      );

      const parsed = await PaymentRequestProtocol.parsePaymentRequest(event, target);

      expect(parsed.amount).toBe(BigInt(1000000));
      expect(parsed.coinId).toBe(SOLANA_COIN_ID);
      expect(parsed.message).toBe('Coffee payment');
      expect(parsed.recipientNametag).toBe('alice');
      expect(parsed.senderPubkey).toBe(requester.getPublicKeyHex());
      expect(parsed.eventId).toBe(event.id);
    });

    it('should decrypt and parse payment request as requester', async () => {
      const request: PaymentRequestProtocol.PaymentRequest = {
        amount: 2000000,
        coinId: SOLANA_COIN_ID,
        recipientNametag: 'merchant',
      };

      const event = await PaymentRequestProtocol.createPaymentRequestEvent(
        requester,
        target.getPublicKeyHex(),
        request
      );

      const parsed = await PaymentRequestProtocol.parsePaymentRequest(event, requester);

      expect(parsed.amount).toBe(BigInt(2000000));
      expect(parsed.recipientNametag).toBe('merchant');
    });

    it('should include timestamp in milliseconds', async () => {
      const request: PaymentRequestProtocol.PaymentRequest = {
        amount: 1000000,
        coinId: SOLANA_COIN_ID,
        recipientNametag: 'alice',
      };

      const before = Date.now();
      const event = await PaymentRequestProtocol.createPaymentRequestEvent(
        requester,
        target.getPublicKeyHex(),
        request
      );
      const after = Date.now();

      const parsed = await PaymentRequestProtocol.parsePaymentRequest(event, target);

      // Timestamp should be within range (allowing for 1 second tolerance)
      expect(parsed.timestamp).toBeGreaterThanOrEqual(before - 1000);
      expect(parsed.timestamp).toBeLessThanOrEqual(after + 1000);
    });

    it('should reject non-payment-request events', async () => {
      const { Event } = await import('../../src/protocol/Event.js');
      const event = Event.create(requester, {
        kind: 1, // Wrong kind
        tags: [],
        content: 'test',
      });

      await expect(
        PaymentRequestProtocol.parsePaymentRequest(event, target)
      ).rejects.toThrow(/not a payment request/);
    });

    it('should reject events with wrong type tag', async () => {
      const { Event } = await import('../../src/protocol/Event.js');
      const event = Event.create(requester, {
        kind: EventKinds.PAYMENT_REQUEST,
        tags: [['type', 'wrong_type']],
        content: 'test',
      });

      await expect(
        PaymentRequestProtocol.parsePaymentRequest(event, target)
      ).rejects.toThrow(/type is not payment_request/);
    });
  });

  describe('getAmount', () => {
    it('should return amount from tag', async () => {
      const request: PaymentRequestProtocol.PaymentRequest = {
        amount: BigInt(12345678),
        coinId: SOLANA_COIN_ID,
        recipientNametag: 'alice',
      };

      const event = await PaymentRequestProtocol.createPaymentRequestEvent(
        requester,
        target.getPublicKeyHex(),
        request
      );

      expect(PaymentRequestProtocol.getAmount(event)).toBe(BigInt(12345678));
    });
  });

  describe('getRecipientNametag', () => {
    it('should return recipient nametag from tag', async () => {
      const request: PaymentRequestProtocol.PaymentRequest = {
        amount: 1000000,
        coinId: SOLANA_COIN_ID,
        recipientNametag: 'my-nametag-123',
      };

      const event = await PaymentRequestProtocol.createPaymentRequestEvent(
        requester,
        target.getPublicKeyHex(),
        request
      );

      expect(PaymentRequestProtocol.getRecipientNametag(event)).toBe('my-nametag-123');
    });
  });

  describe('getTarget', () => {
    it('should return target public key', async () => {
      const request: PaymentRequestProtocol.PaymentRequest = {
        amount: 1000000,
        coinId: SOLANA_COIN_ID,
        recipientNametag: 'alice',
      };

      const event = await PaymentRequestProtocol.createPaymentRequestEvent(
        requester,
        target.getPublicKeyHex(),
        request
      );

      expect(PaymentRequestProtocol.getTarget(event)).toBe(target.getPublicKeyHex());
    });
  });

  describe('getSender', () => {
    it('should return sender public key', async () => {
      const request: PaymentRequestProtocol.PaymentRequest = {
        amount: 1000000,
        coinId: SOLANA_COIN_ID,
        recipientNametag: 'alice',
      };

      const event = await PaymentRequestProtocol.createPaymentRequestEvent(
        requester,
        target.getPublicKeyHex(),
        request
      );

      expect(PaymentRequestProtocol.getSender(event)).toBe(requester.getPublicKeyHex());
    });
  });

  describe('isPaymentRequest', () => {
    it('should return true for valid payment request', async () => {
      const request: PaymentRequestProtocol.PaymentRequest = {
        amount: 1000000,
        coinId: SOLANA_COIN_ID,
        recipientNametag: 'alice',
      };

      const event = await PaymentRequestProtocol.createPaymentRequestEvent(
        requester,
        target.getPublicKeyHex(),
        request
      );

      expect(PaymentRequestProtocol.isPaymentRequest(event)).toBe(true);
    });

    it('should return false for non-payment-request events', async () => {
      const { Event } = await import('../../src/protocol/Event.js');
      const event = Event.create(requester, {
        kind: 1,
        tags: [],
        content: 'test',
      });

      expect(PaymentRequestProtocol.isPaymentRequest(event)).toBe(false);
    });

    it('should return false for token transfer events', async () => {
      const { Event } = await import('../../src/protocol/Event.js');
      const event = Event.create(requester, {
        kind: EventKinds.TOKEN_TRANSFER,
        tags: [['type', 'token_transfer']],
        content: 'encrypted',
      });

      expect(PaymentRequestProtocol.isPaymentRequest(event)).toBe(false);
    });
  });

  describe('formatAmount', () => {
    it('should format amounts with 9 decimals', () => {
      expect(PaymentRequestProtocol.formatAmount(BigInt(1_000_000_000), 9)).toBe('1');
      expect(PaymentRequestProtocol.formatAmount(BigInt(1_500_000_000), 9)).toBe('1.5');
      expect(PaymentRequestProtocol.formatAmount(BigInt(1_000_000), 9)).toBe('0.001');
      expect(PaymentRequestProtocol.formatAmount(BigInt(1), 9)).toBe('0.000000001');
    });

    it('should format amounts with 8 decimals (default)', () => {
      expect(PaymentRequestProtocol.formatAmount(BigInt(100_000_000), 8)).toBe('1');
      expect(PaymentRequestProtocol.formatAmount(BigInt(150_000_000), 8)).toBe('1.5');
      expect(PaymentRequestProtocol.formatAmount(BigInt(1), 8)).toBe('0.00000001');
    });

    it('should format amounts with 6 decimals', () => {
      expect(PaymentRequestProtocol.formatAmount(BigInt(1_000_000), 6)).toBe('1');
      expect(PaymentRequestProtocol.formatAmount(BigInt(1_500_000), 6)).toBe('1.5');
      expect(PaymentRequestProtocol.formatAmount(BigInt(1), 6)).toBe('0.000001');
    });

    it('should handle number input', () => {
      expect(PaymentRequestProtocol.formatAmount(1_000_000_000, 9)).toBe('1');
    });

    it('should remove trailing zeros', () => {
      expect(PaymentRequestProtocol.formatAmount(BigInt(1_100_000_000), 9)).toBe('1.1');
      expect(PaymentRequestProtocol.formatAmount(BigInt(1_010_000_000), 9)).toBe('1.01');
    });

    it('should use default 8 decimals', () => {
      expect(PaymentRequestProtocol.formatAmount(BigInt(100_000_000))).toBe('1');
    });
  });

  describe('parseAmount', () => {
    it('should parse amounts with 9 decimals', () => {
      expect(PaymentRequestProtocol.parseAmount('1', 9)).toBe(BigInt(1_000_000_000));
      expect(PaymentRequestProtocol.parseAmount('1.5', 9)).toBe(BigInt(1_500_000_000));
      expect(PaymentRequestProtocol.parseAmount('0.001', 9)).toBe(BigInt(1_000_000));
    });

    it('should parse amounts with 8 decimals (default)', () => {
      expect(PaymentRequestProtocol.parseAmount('1', 8)).toBe(BigInt(100_000_000));
      expect(PaymentRequestProtocol.parseAmount('0.00000001', 8)).toBe(BigInt(1));
    });

    it('should parse amounts with 6 decimals', () => {
      expect(PaymentRequestProtocol.parseAmount('1', 6)).toBe(BigInt(1_000_000));
      expect(PaymentRequestProtocol.parseAmount('1.5', 6)).toBe(BigInt(1_500_000));
    });

    it('should round-trip format and parse', () => {
      const amounts = [
        BigInt(1),
        BigInt(1_000_000),
        BigInt(1_500_000_000),
        BigInt(123_456_789),
      ];

      for (const amount of amounts) {
        const formatted = PaymentRequestProtocol.formatAmount(amount, 9);
        const parsed = PaymentRequestProtocol.parseAmount(formatted, 9);
        expect(parsed).toBe(amount);
      }
    });

    it('should use default 8 decimals', () => {
      expect(PaymentRequestProtocol.parseAmount('1')).toBe(BigInt(100_000_000));
    });
  });
});
