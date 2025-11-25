/**
 * Unit tests for Schnorr signatures (BIP-340)
 */

import { describe, it, expect } from 'vitest';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import * as Schnorr from '../../src/crypto/schnorr.js';

describe('SchnorrSigner', () => {
  // Test vectors from BIP-340
  const testVectors = [
    {
      privateKey: '0000000000000000000000000000000000000000000000000000000000000001',
      publicKey: '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      message: '0000000000000000000000000000000000000000000000000000000000000000',
    },
    {
      privateKey: '0000000000000000000000000000000000000000000000000000000000000003',
      publicKey: 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9',
      message: '0000000000000000000000000000000000000000000000000000000000000000',
    },
  ];

  describe('getPublicKey', () => {
    it('should derive public key from private key', () => {
      for (const vector of testVectors) {
        const privateKey = hexToBytes(vector.privateKey);
        const publicKey = Schnorr.getPublicKey(privateKey);
        expect(bytesToHex(publicKey)).toBe(vector.publicKey);
      }
    });

    it('should return 32-byte x-only public key', () => {
      const privateKey = new Uint8Array(32).fill(0x42);
      const publicKey = Schnorr.getPublicKey(privateKey);
      expect(publicKey.length).toBe(32);
    });

    it('should reject invalid private key length', () => {
      expect(() => Schnorr.getPublicKey(new Uint8Array(16))).toThrow();
    });
  });

  describe('getPublicKeyHex', () => {
    it('should return hex-encoded public key', () => {
      const privateKeyHex = testVectors[0]!.privateKey;
      const publicKeyHex = Schnorr.getPublicKeyHex(privateKeyHex);
      expect(publicKeyHex).toBe(testVectors[0]!.publicKey);
    });
  });

  describe('sign/verify', () => {
    it('should sign and verify a message', () => {
      const privateKey = hexToBytes(testVectors[0]!.privateKey);
      const message = hexToBytes(testVectors[0]!.message);
      const publicKey = Schnorr.getPublicKey(privateKey);

      const signature = Schnorr.sign(message, privateKey);
      expect(signature.length).toBe(64);

      const valid = Schnorr.verify(signature, message, publicKey);
      expect(valid).toBe(true);
    });

    it('should produce valid signatures that verify', () => {
      const privateKey = new Uint8Array(32).fill(0x01);
      const message = new Uint8Array(32).fill(0x02);
      const publicKey = Schnorr.getPublicKey(privateKey);

      // Sign the message
      const sig = Schnorr.sign(message, privateKey);

      // Both signatures should verify (even if not identical due to randomization)
      expect(Schnorr.verify(sig, message, publicKey)).toBe(true);
    });

    it('should reject tampered signature', () => {
      const privateKey = new Uint8Array(32).fill(0x01);
      const message = new Uint8Array(32).fill(0x02);
      const publicKey = Schnorr.getPublicKey(privateKey);

      const signature = Schnorr.sign(message, privateKey);

      // Tamper with signature
      signature[0] = (signature[0]! + 1) % 256;

      const valid = Schnorr.verify(signature, message, publicKey);
      expect(valid).toBe(false);
    });

    it('should reject tampered message', () => {
      const privateKey = new Uint8Array(32).fill(0x01);
      const message = new Uint8Array(32).fill(0x02);
      const publicKey = Schnorr.getPublicKey(privateKey);

      const signature = Schnorr.sign(message, privateKey);

      // Tamper with message
      message[0] = (message[0]! + 1) % 256;

      const valid = Schnorr.verify(signature, message, publicKey);
      expect(valid).toBe(false);
    });

    it('should reject wrong public key', () => {
      const privateKey = new Uint8Array(32).fill(0x01);
      const message = new Uint8Array(32).fill(0x02);

      const signature = Schnorr.sign(message, privateKey);

      // Use different public key
      const wrongPrivateKey = new Uint8Array(32).fill(0x03);
      const wrongPublicKey = Schnorr.getPublicKey(wrongPrivateKey);

      const valid = Schnorr.verify(signature, message, wrongPublicKey);
      expect(valid).toBe(false);
    });

    it('should handle invalid inputs gracefully', () => {
      expect(Schnorr.verify(new Uint8Array(32), new Uint8Array(32), new Uint8Array(32))).toBe(false);
      expect(Schnorr.verify(new Uint8Array(64), new Uint8Array(16), new Uint8Array(32))).toBe(false);
    });
  });

  describe('signHex/verifyHex', () => {
    it('should work with hex strings', () => {
      const privateKeyHex = testVectors[0]!.privateKey;
      const messageHex = testVectors[0]!.message;
      const publicKeyHex = testVectors[0]!.publicKey;

      const message = hexToBytes(messageHex);
      const privateKey = hexToBytes(privateKeyHex);

      const signatureHex = Schnorr.signHex(message, privateKey);
      expect(signatureHex.length).toBe(128); // 64 bytes = 128 hex chars

      const valid = Schnorr.verifyHex(signatureHex, message, publicKeyHex);
      expect(valid).toBe(true);
    });
  });
});
