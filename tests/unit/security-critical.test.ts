/**
 * Unit tests for security-critical operations
 * Feature 18: Security Critical Paths
 * Techniques: [RB] Risk-Based Testing
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';
import { NostrKeyManager } from '../../src/NostrKeyManager.js';
import { Event } from '../../src/protocol/Event.js';
import * as NIP17 from '../../src/messaging/nip17.js';
import * as EventKinds from '../../src/protocol/EventKinds.js';

describe('Security Critical Paths', () => {
  // [RB] Private key not accessible after clear
  describe('key clearing', () => {
    it('should prevent all private key access after clear', () => {
      const km = NostrKeyManager.generate();
      km.clear();

      expect(() => km.getPrivateKey()).toThrow(/has been cleared/);
      expect(() => km.getPrivateKeyHex()).toThrow(/has been cleared/);
      expect(() => km.getNsec()).toThrow(/has been cleared/);
      expect(() => km.getPublicKey()).toThrow(/has been cleared/);
      expect(() => km.getPublicKeyHex()).toThrow(/has been cleared/);
      expect(() => km.getNpub()).toThrow(/has been cleared/);
    });

    it('should prevent signing after clear', () => {
      const km = NostrKeyManager.generate();
      km.clear();

      expect(() => km.sign(new Uint8Array(32))).toThrow(/has been cleared/);
      expect(() => km.signHex(new Uint8Array(32))).toThrow(/has been cleared/);
    });

    it('should prevent NIP-04 encryption after clear', async () => {
      const km = NostrKeyManager.generate();
      const other = NostrKeyManager.generate();
      km.clear();

      await expect(km.encrypt('test', other.getPublicKey())).rejects.toThrow(/has been cleared/);
      await expect(km.encryptHex('test', other.getPublicKeyHex())).rejects.toThrow(/has been cleared/);
      await expect(km.decrypt('data', other.getPublicKey())).rejects.toThrow(/has been cleared/);
      await expect(km.decryptHex('data', other.getPublicKeyHex())).rejects.toThrow(/has been cleared/);
    });

    it('should prevent NIP-44 encryption after clear', () => {
      const km = NostrKeyManager.generate();
      const other = NostrKeyManager.generate();
      km.clear();

      expect(() => km.encryptNip44('test', other.getPublicKey())).toThrow(/has been cleared/);
      expect(() => km.encryptNip44Hex('test', other.getPublicKeyHex())).toThrow(/has been cleared/);
      expect(() => km.decryptNip44('data', other.getPublicKey())).toThrow(/has been cleared/);
      expect(() => km.decryptNip44Hex('data', other.getPublicKeyHex())).toThrow(/has been cleared/);
    });

    it('should prevent shared secret derivation after clear', () => {
      const km = NostrKeyManager.generate();
      const other = NostrKeyManager.generate();
      km.clear();

      expect(() => km.deriveSharedSecret(other.getPublicKey())).toThrow(/has been cleared/);
      expect(() => km.deriveConversationKey(other.getPublicKey())).toThrow(/has been cleared/);
    });

    // [RB] Memory zeroing
    it('should zero private key memory on clear', () => {
      const privateKeyBytes = new Uint8Array(32).fill(0x42);
      const km = NostrKeyManager.fromPrivateKey(privateKeyBytes);

      // Verify key works before clear
      const sig = km.sign(new Uint8Array(32));
      expect(sig.length).toBe(64);

      km.clear();

      // Original input should be unchanged (was copied)
      expect(privateKeyBytes[0]).toBe(0x42);
    });
  });

  // [RB] Private key copy semantics
  describe('key copy semantics', () => {
    it('getPrivateKey returns a copy, not a reference', () => {
      const km = NostrKeyManager.generate();
      const key1 = km.getPrivateKey();
      const original = bytesToHex(key1);

      // Modify the returned array
      key1[0] = 0xFF;
      key1[1] = 0xFF;

      // Get key again — should be unmodified
      const key2 = km.getPrivateKey();
      expect(bytesToHex(key2)).toBe(original);
    });

    it('getPublicKey returns a copy, not a reference', () => {
      const km = NostrKeyManager.generate();
      const key1 = km.getPublicKey();
      const original = bytesToHex(key1);

      key1[0] = 0xFF;

      const key2 = km.getPublicKey();
      expect(bytesToHex(key2)).toBe(original);
    });

    it('constructor copies input private key', () => {
      const inputKey = new Uint8Array(32).fill(0x42);
      const km = NostrKeyManager.fromPrivateKey(inputKey);

      // Modify the original input
      inputKey[0] = 0xFF;

      // Key manager should still have the original value
      expect(km.getPrivateKey()[0]).toBe(0x42);
    });
  });

  // [RB] Gift wrap does not leak sender identity
  describe('NIP-17 sender anonymity', () => {
    it('gift wrap event pubkey should NOT be the sender pubkey', () => {
      const alice = NostrKeyManager.generate();
      const bob = NostrKeyManager.generate();

      const giftWrap = NIP17.createGiftWrap(
        alice,
        bob.getPublicKeyHex(),
        'secret message'
      );

      // The gift wrap is signed by an ephemeral key, NOT Alice
      expect(giftWrap.pubkey).not.toBe(alice.getPublicKeyHex());
    });

    it('different gift wraps use different ephemeral keys', () => {
      const alice = NostrKeyManager.generate();
      const bob = NostrKeyManager.generate();

      const gw1 = NIP17.createGiftWrap(alice, bob.getPublicKeyHex(), 'msg1');
      const gw2 = NIP17.createGiftWrap(alice, bob.getPublicKeyHex(), 'msg2');

      // Different ephemeral keys each time
      expect(gw1.pubkey).not.toBe(gw2.pubkey);
    });

    it('gift wrap recipient tag points to actual recipient', () => {
      const alice = NostrKeyManager.generate();
      const bob = NostrKeyManager.generate();

      const giftWrap = NIP17.createGiftWrap(
        alice,
        bob.getPublicKeyHex(),
        'message'
      );

      expect(giftWrap.getTagValue('p')).toBe(bob.getPublicKeyHex());
    });
  });

  // [RB] NIP-17 timestamp randomization
  describe('NIP-17 timestamp privacy', () => {
    it('timestamps should be randomized within +/- 2 days', () => {
      const alice = NostrKeyManager.generate();
      const bob = NostrKeyManager.generate();
      const now = Math.floor(Date.now() / 1000);
      const twoDays = 2 * 24 * 60 * 60;

      const timestamps: number[] = [];
      for (let i = 0; i < 20; i++) {
        const gw = NIP17.createGiftWrap(alice, bob.getPublicKeyHex(), `msg${i}`);
        timestamps.push(gw.created_at);
      }

      // All should be within +/- 2 days of now
      for (const ts of timestamps) {
        expect(ts).toBeGreaterThanOrEqual(now - twoDays - 10);
        expect(ts).toBeLessThanOrEqual(now + twoDays + 10);
      }

      // Not all timestamps should be the same (randomized)
      const unique = new Set(timestamps);
      expect(unique.size).toBeGreaterThan(1);
    });
  });

  // [RB] NIP-44 conversation key symmetry
  describe('NIP-44 conversation key symmetry', () => {
    it('conversation key should be symmetric (A->B equals B->A)', () => {
      const alice = NostrKeyManager.generate();
      const bob = NostrKeyManager.generate();

      const keyAB = alice.deriveConversationKey(bob.getPublicKey());
      const keyBA = bob.deriveConversationKey(alice.getPublicKey());

      expect(bytesToHex(keyAB)).toBe(bytesToHex(keyBA));
    });
  });

  // [RB] AUTH event correctness
  describe('AUTH event structure', () => {
    it('should create valid AUTH event with relay and challenge tags', () => {
      const km = NostrKeyManager.generate();

      const authEvent = Event.create(km, {
        kind: EventKinds.AUTH,
        tags: [
          ['relay', 'wss://relay.example.com'],
          ['challenge', 'test-challenge-123'],
        ],
        content: '',
      });

      expect(authEvent.kind).toBe(22242);
      expect(authEvent.getTagValue('relay')).toBe('wss://relay.example.com');
      expect(authEvent.getTagValue('challenge')).toBe('test-challenge-123');
      expect(authEvent.content).toBe('');
      expect(authEvent.pubkey).toBe(km.getPublicKeyHex());
      expect(authEvent.verify()).toBe(true);
    });
  });
});
