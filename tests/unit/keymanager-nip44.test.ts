/**
 * Unit tests for NostrKeyManager NIP-44 encryption methods
 * Feature 11: KeyManager NIP-44 Encryption
 * Techniques: [EP] Equivalence Partitioning, [BVA] Boundary Value Analysis, [ST] State Transition
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';
import { NostrKeyManager } from '../../src/NostrKeyManager.js';

describe('NostrKeyManager NIP-44 Encryption', () => {
  let alice: NostrKeyManager;
  let bob: NostrKeyManager;

  beforeEach(() => {
    alice = NostrKeyManager.generate();
    bob = NostrKeyManager.generate();
  });

  // [EP] Valid: encrypt/decrypt with byte keys
  describe('encryptNip44 / decryptNip44 (bytes keys)', () => {
    it('should encrypt and decrypt a message', () => {
      const encrypted = alice.encryptNip44('Hello Bob', bob.getPublicKey());
      const decrypted = bob.decryptNip44(encrypted, alice.getPublicKey());
      expect(decrypted).toBe('Hello Bob');
    });

    it('should handle unicode content', () => {
      const message = '\u041f\u0440\u0438\u0432\u0456\u0442 \ud83c\udf0d \u0645\u0631\u062d\u0628\u0627';
      const encrypted = alice.encryptNip44(message, bob.getPublicKey());
      const decrypted = bob.decryptNip44(encrypted, alice.getPublicKey());
      expect(decrypted).toBe(message);
    });

    it('should produce different ciphertext each time (random nonce)', () => {
      const ct1 = alice.encryptNip44('same message', bob.getPublicKey());
      const ct2 = alice.encryptNip44('same message', bob.getPublicKey());
      expect(ct1).not.toBe(ct2);
    });
  });

  // [EP] Valid: encrypt/decrypt with hex keys
  describe('encryptNip44Hex / decryptNip44Hex (hex keys)', () => {
    it('should encrypt and decrypt a message', () => {
      const encrypted = alice.encryptNip44Hex('Hello Bob', bob.getPublicKeyHex());
      const decrypted = bob.decryptNip44Hex(encrypted, alice.getPublicKeyHex());
      expect(decrypted).toBe('Hello Bob');
    });

    it('should produce base64-encoded output', () => {
      const encrypted = alice.encryptNip44Hex('test', bob.getPublicKeyHex());
      // base64 characters are alphanumeric + /+=
      expect(encrypted).toMatch(/^[A-Za-z0-9+/=]+$/);
    });
  });

  // [BVA] Message length boundaries
  describe('message length boundaries', () => {
    it('should encrypt 1-byte message', () => {
      const encrypted = alice.encryptNip44('x', bob.getPublicKey());
      const decrypted = bob.decryptNip44(encrypted, alice.getPublicKey());
      expect(decrypted).toBe('x');
    });

    it('should encrypt a long message (close to max)', () => {
      // 60000 bytes is well under 65535 limit but large enough to stress test
      const message = 'A'.repeat(60000);
      const encrypted = alice.encryptNip44(message, bob.getPublicKey());
      const decrypted = bob.decryptNip44(encrypted, alice.getPublicKey());
      expect(decrypted).toBe(message);
    });

    it('should reject empty message', () => {
      expect(() => alice.encryptNip44('', bob.getPublicKey())).toThrow(/too short/);
    });
  });

  // [EP] Invalid: wrong key decryption
  describe('wrong key decryption', () => {
    it('should fail when decrypting with wrong key', () => {
      const eve = NostrKeyManager.generate();
      const encrypted = alice.encryptNip44('secret', bob.getPublicKey());

      expect(() => eve.decryptNip44(encrypted, alice.getPublicKey())).toThrow();
    });
  });

  // [ST] Cleared key manager
  describe('cleared key manager', () => {
    it('encryptNip44 should throw after clear', () => {
      alice.clear();
      expect(() => alice.encryptNip44('test', bob.getPublicKey()))
        .toThrow(/has been cleared/);
    });

    it('decryptNip44 should throw after clear', () => {
      const encrypted = alice.encryptNip44('test', bob.getPublicKey());
      bob.clear();
      expect(() => bob.decryptNip44(encrypted, alice.getPublicKey()))
        .toThrow(/has been cleared/);
    });

    it('encryptNip44Hex should throw after clear', () => {
      alice.clear();
      expect(() => alice.encryptNip44Hex('test', bob.getPublicKeyHex()))
        .toThrow(/has been cleared/);
    });

    it('decryptNip44Hex should throw after clear', () => {
      const encrypted = alice.encryptNip44Hex('test', bob.getPublicKeyHex());
      bob.clear();
      expect(() => bob.decryptNip44Hex(encrypted, alice.getPublicKeyHex()))
        .toThrow(/has been cleared/);
    });

    it('deriveConversationKey should throw after clear', () => {
      alice.clear();
      expect(() => alice.deriveConversationKey(bob.getPublicKey()))
        .toThrow(/has been cleared/);
    });
  });

  // Conversation key derivation
  describe('deriveConversationKey', () => {
    it('should produce consistent result', () => {
      const key1 = alice.deriveConversationKey(bob.getPublicKey());
      const key2 = alice.deriveConversationKey(bob.getPublicKey());
      expect(bytesToHex(key1)).toBe(bytesToHex(key2));
    });

    it('should be symmetric (A->B equals B->A)', () => {
      const keyAB = alice.deriveConversationKey(bob.getPublicKey());
      const keyBA = bob.deriveConversationKey(alice.getPublicKey());
      expect(bytesToHex(keyAB)).toBe(bytesToHex(keyBA));
    });

    it('should differ for different key pairs', () => {
      const charlie = NostrKeyManager.generate();
      const keyAB = alice.deriveConversationKey(bob.getPublicKey());
      const keyAC = alice.deriveConversationKey(charlie.getPublicKey());
      expect(bytesToHex(keyAB)).not.toBe(bytesToHex(keyAC));
    });

    it('should return 32-byte key', () => {
      const key = alice.deriveConversationKey(bob.getPublicKey());
      expect(key.length).toBe(32);
    });
  });
});
