/**
 * Unit tests for Schnorr signing edge cases
 * Covers input validation for wrong key/message lengths
 * Techniques: [BVA] Boundary Value Analysis, [EG] Error Guessing
 */

import { describe, it, expect } from 'vitest';
import * as Schnorr from '../../src/crypto/schnorr.js';

describe('Schnorr Edge Cases', () => {
  const validPrivateKey = new Uint8Array(32).fill(0x42);
  const validMessage = new Uint8Array(32).fill(0xAB);
  const validPublicKey = Schnorr.getPublicKey(validPrivateKey);
  const validSignature = Schnorr.sign(validMessage, validPrivateKey);

  // ==========================================================
  // getPublicKey input validation
  // ==========================================================
  describe('getPublicKey input validation', () => {
    it('should reject empty private key', () => {
      expect(() => Schnorr.getPublicKey(new Uint8Array(0))).toThrow('Private key must be 32 bytes');
    });

    it('should reject 31-byte private key', () => {
      expect(() => Schnorr.getPublicKey(new Uint8Array(31))).toThrow('Private key must be 32 bytes');
    });

    it('should reject 33-byte private key', () => {
      expect(() => Schnorr.getPublicKey(new Uint8Array(33))).toThrow('Private key must be 32 bytes');
    });

    it('should reject 64-byte private key', () => {
      expect(() => Schnorr.getPublicKey(new Uint8Array(64))).toThrow('Private key must be 32 bytes');
    });

    it('should accept 32-byte private key', () => {
      const pubkey = Schnorr.getPublicKey(validPrivateKey);
      expect(pubkey.length).toBe(32);
    });

    it('should handle private key with leading zeros', () => {
      const keyWithLeadingZeros = new Uint8Array(32);
      keyWithLeadingZeros[31] = 0x01; // Only last byte is non-zero
      const pubkey = Schnorr.getPublicKey(keyWithLeadingZeros);
      expect(pubkey.length).toBe(32);
    });
  });

  // ==========================================================
  // sign input validation
  // ==========================================================
  describe('sign input validation', () => {
    it('should reject empty message', () => {
      expect(() => Schnorr.sign(new Uint8Array(0), validPrivateKey)).toThrow('Message must be 32 bytes');
    });

    it('should reject 31-byte message', () => {
      expect(() => Schnorr.sign(new Uint8Array(31), validPrivateKey)).toThrow('Message must be 32 bytes');
    });

    it('should reject 33-byte message', () => {
      expect(() => Schnorr.sign(new Uint8Array(33), validPrivateKey)).toThrow('Message must be 32 bytes');
    });

    it('should reject empty private key in sign', () => {
      expect(() => Schnorr.sign(validMessage, new Uint8Array(0))).toThrow('Private key must be 32 bytes');
    });

    it('should reject 31-byte private key in sign', () => {
      expect(() => Schnorr.sign(validMessage, new Uint8Array(31))).toThrow('Private key must be 32 bytes');
    });

    it('should reject 33-byte private key in sign', () => {
      expect(() => Schnorr.sign(validMessage, new Uint8Array(33))).toThrow('Private key must be 32 bytes');
    });

    it('should produce 64-byte signature', () => {
      const sig = Schnorr.sign(validMessage, validPrivateKey);
      expect(sig.length).toBe(64);
    });

    it('should produce valid signatures (BIP-340 uses randomness)', () => {
      // Note: BIP-340 Schnorr signatures use auxiliary randomness
      // So two signatures of the same message are NOT identical
      const sig1 = Schnorr.sign(validMessage, validPrivateKey);
      const sig2 = Schnorr.sign(validMessage, validPrivateKey);

      // Both should be valid, even if different
      expect(Schnorr.verify(sig1, validMessage, validPublicKey)).toBe(true);
      expect(Schnorr.verify(sig2, validMessage, validPublicKey)).toBe(true);
    });

    it('should produce different signatures for different messages', () => {
      const msg1 = new Uint8Array(32).fill(0x01);
      const msg2 = new Uint8Array(32).fill(0x02);
      const sig1 = Schnorr.sign(msg1, validPrivateKey);
      const sig2 = Schnorr.sign(msg2, validPrivateKey);
      expect(sig1).not.toEqual(sig2);
    });
  });

  // ==========================================================
  // verify input validation
  // ==========================================================
  describe('verify input validation', () => {
    it('should return false for empty signature', () => {
      expect(Schnorr.verify(new Uint8Array(0), validMessage, validPublicKey)).toBe(false);
    });

    it('should return false for 63-byte signature', () => {
      expect(Schnorr.verify(new Uint8Array(63), validMessage, validPublicKey)).toBe(false);
    });

    it('should return false for 65-byte signature', () => {
      expect(Schnorr.verify(new Uint8Array(65), validMessage, validPublicKey)).toBe(false);
    });

    it('should return false for empty message', () => {
      expect(Schnorr.verify(validSignature, new Uint8Array(0), validPublicKey)).toBe(false);
    });

    it('should return false for 31-byte message', () => {
      expect(Schnorr.verify(validSignature, new Uint8Array(31), validPublicKey)).toBe(false);
    });

    it('should return false for 33-byte message', () => {
      expect(Schnorr.verify(validSignature, new Uint8Array(33), validPublicKey)).toBe(false);
    });

    it('should return false for empty public key', () => {
      expect(Schnorr.verify(validSignature, validMessage, new Uint8Array(0))).toBe(false);
    });

    it('should return false for 31-byte public key', () => {
      expect(Schnorr.verify(validSignature, validMessage, new Uint8Array(31))).toBe(false);
    });

    it('should return false for 33-byte public key', () => {
      expect(Schnorr.verify(validSignature, validMessage, new Uint8Array(33))).toBe(false);
    });

    it('should return false for all-zero inputs', () => {
      expect(Schnorr.verify(
        new Uint8Array(64),
        new Uint8Array(32),
        new Uint8Array(32)
      )).toBe(false);
    });

    it('should return false for wrong public key', () => {
      const otherKey = Schnorr.getPublicKey(new Uint8Array(32).fill(0x99));
      expect(Schnorr.verify(validSignature, validMessage, otherKey)).toBe(false);
    });

    it('should return false for tampered message', () => {
      const tamperedMessage = new Uint8Array(validMessage);
      tamperedMessage[0] ^= 0xFF;
      expect(Schnorr.verify(validSignature, tamperedMessage, validPublicKey)).toBe(false);
    });

    it('should return false for tampered signature', () => {
      const tamperedSig = new Uint8Array(validSignature);
      tamperedSig[0] ^= 0xFF;
      expect(Schnorr.verify(tamperedSig, validMessage, validPublicKey)).toBe(false);
    });

    it('should return true for valid signature', () => {
      expect(Schnorr.verify(validSignature, validMessage, validPublicKey)).toBe(true);
    });
  });

  // ==========================================================
  // verifyHex edge cases
  // ==========================================================
  describe('verifyHex edge cases', () => {
    it('should return false for invalid hex in signature', () => {
      expect(Schnorr.verifyHex('ZZZZ', validMessage, '00'.repeat(32))).toBe(false);
    });

    it('should return false for odd-length hex signature', () => {
      expect(Schnorr.verifyHex('abc', validMessage, '00'.repeat(32))).toBe(false);
    });

    it('should return false for invalid hex in public key', () => {
      expect(Schnorr.verifyHex('00'.repeat(64), validMessage, 'ZZZZ')).toBe(false);
    });
  });

  // ==========================================================
  // Multiple keypairs
  // ==========================================================
  describe('multiple keypairs', () => {
    it('should correctly sign and verify with different keypairs', () => {
      // Note: 0xFF fill is invalid for secp256k1 (exceeds curve order)
      const keypairs = [
        new Uint8Array(32).fill(0x01),
        new Uint8Array(32).fill(0x42),
        new Uint8Array(32).fill(0x7F), // Valid key (not 0xFF which exceeds N)
      ];

      for (const privateKey of keypairs) {
        const publicKey = Schnorr.getPublicKey(privateKey);
        const signature = Schnorr.sign(validMessage, privateKey);

        expect(Schnorr.verify(signature, validMessage, publicKey)).toBe(true);

        // Cross-verify should fail
        for (const otherKey of keypairs) {
          if (otherKey !== privateKey) {
            const otherPubkey = Schnorr.getPublicKey(otherKey);
            expect(Schnorr.verify(signature, validMessage, otherPubkey)).toBe(false);
          }
        }
      }
    });
  });
});
