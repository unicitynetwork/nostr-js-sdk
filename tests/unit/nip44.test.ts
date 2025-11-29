/**
 * Unit tests for NIP-44 encryption (XChaCha20-Poly1305 with HKDF)
 */

import { describe, it, expect } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import * as NIP44 from '../../src/crypto/nip44.js';
import * as Schnorr from '../../src/crypto/schnorr.js';

describe('NIP44 Encryption', () => {
  // Generate test key pairs
  const alicePrivateKey = new Uint8Array(32).fill(0x01);
  const alicePublicKey = Schnorr.getPublicKey(alicePrivateKey);

  const bobPrivateKey = new Uint8Array(32).fill(0x02);
  const bobPublicKey = Schnorr.getPublicKey(bobPrivateKey);

  describe('deriveConversationKey', () => {
    it('should derive the same conversation key from both sides', () => {
      const aliceKey = NIP44.deriveConversationKey(alicePrivateKey, bobPublicKey);
      const bobKey = NIP44.deriveConversationKey(bobPrivateKey, alicePublicKey);

      expect(bytesToHex(aliceKey)).toBe(bytesToHex(bobKey));
    });

    it('should return 32-byte conversation key', () => {
      const key = NIP44.deriveConversationKey(alicePrivateKey, bobPublicKey);
      expect(key.length).toBe(32);
    });

    it('should produce different keys for different key pairs', () => {
      const charliePrivateKey = new Uint8Array(32).fill(0x03);
      const charliePublicKey = Schnorr.getPublicKey(charliePrivateKey);

      const keyAB = NIP44.deriveConversationKey(alicePrivateKey, bobPublicKey);
      const keyAC = NIP44.deriveConversationKey(alicePrivateKey, charliePublicKey);

      expect(bytesToHex(keyAB)).not.toBe(bytesToHex(keyAC));
    });

    it('should reject invalid key lengths', () => {
      expect(() => NIP44.deriveConversationKey(new Uint8Array(16), bobPublicKey))
        .toThrow(/must be 32 bytes/);
      expect(() => NIP44.deriveConversationKey(alicePrivateKey, new Uint8Array(16)))
        .toThrow(/must be 32 bytes/);
    });
  });

  describe('deriveConversationKeyHex', () => {
    it('should work with hex strings', () => {
      const key = NIP44.deriveConversationKeyHex(
        bytesToHex(alicePrivateKey),
        bytesToHex(bobPublicKey)
      );

      const expected = NIP44.deriveConversationKey(alicePrivateKey, bobPublicKey);
      expect(key).toBe(bytesToHex(expected));
    });
  });

  describe('encrypt/decrypt', () => {
    it('should encrypt and decrypt a simple message', () => {
      const message = 'Hello, Bob! This is a secret message.';

      const encrypted = NIP44.encrypt(message, alicePrivateKey, bobPublicKey);
      const decrypted = NIP44.decrypt(encrypted, bobPrivateKey, alicePublicKey);

      expect(decrypted).toBe(message);
    });

    it('should encrypt and decrypt a short message (1 byte)', () => {
      const message = 'a';

      const encrypted = NIP44.encrypt(message, alicePrivateKey, bobPublicKey);
      const decrypted = NIP44.decrypt(encrypted, bobPrivateKey, alicePublicKey);

      expect(decrypted).toBe(message);
    });

    it('should reject empty messages', () => {
      expect(() => NIP44.encrypt('', alicePrivateKey, bobPublicKey))
        .toThrow(/too short/);
    });

    it('should produce different ciphertexts for same message (random nonce)', () => {
      const message = 'Same message';

      const encrypted1 = NIP44.encrypt(message, alicePrivateKey, bobPublicKey);
      const encrypted2 = NIP44.encrypt(message, alicePrivateKey, bobPublicKey);

      expect(encrypted1).not.toBe(encrypted2);

      // But both should decrypt to the same message
      expect(NIP44.decrypt(encrypted1, bobPrivateKey, alicePublicKey)).toBe(message);
      expect(NIP44.decrypt(encrypted2, bobPrivateKey, alicePublicKey)).toBe(message);
    });

    it('should handle unicode characters', () => {
      const message = 'Hello! 中文 Русский 😀🎉';

      const encrypted = NIP44.encrypt(message, alicePrivateKey, bobPublicKey);
      const decrypted = NIP44.decrypt(encrypted, bobPrivateKey, alicePublicKey);

      expect(decrypted).toBe(message);
    });

    it('should handle long messages', () => {
      // Create a message longer than 32 bytes to test padding
      const lines: string[] = [];
      for (let i = 0; i < 100; i++) {
        lines.push(`This is line ${i} of a long message. `);
      }
      const message = lines.join('');

      const encrypted = NIP44.encrypt(message, alicePrivateKey, bobPublicKey);
      const decrypted = NIP44.decrypt(encrypted, bobPrivateKey, alicePublicKey);

      expect(decrypted).toBe(message);
    });

    it('should fail with wrong key', () => {
      const charliePrivateKey = new Uint8Array(32).fill(0x03);
      const message = 'Secret message';

      const encrypted = NIP44.encrypt(message, alicePrivateKey, bobPublicKey);

      // Eve (Charlie) should not be able to decrypt
      expect(() => NIP44.decrypt(encrypted, charliePrivateKey, alicePublicKey))
        .toThrow();
    });

    it('should have version byte 0x02', () => {
      const encrypted = NIP44.encrypt('test', alicePrivateKey, bobPublicKey);

      // Decode base64 and check version byte
      const decoded = Buffer.from(encrypted, 'base64');
      expect(decoded[0]).toBe(0x02);
    });
  });

  describe('encryptHex/decryptHex', () => {
    it('should work with hex-encoded keys', () => {
      const message = 'Test message';

      const encrypted = NIP44.encryptHex(
        message,
        bytesToHex(alicePrivateKey),
        bytesToHex(bobPublicKey)
      );

      const decrypted = NIP44.decryptHex(
        encrypted,
        bytesToHex(bobPrivateKey),
        bytesToHex(alicePublicKey)
      );

      expect(decrypted).toBe(message);
    });
  });

  describe('encryptWithKey/decryptWithKey', () => {
    it('should work with pre-derived conversation key', () => {
      const message = 'Message encrypted with conversation key';
      const conversationKey = NIP44.deriveConversationKey(alicePrivateKey, bobPublicKey);

      const encrypted = NIP44.encryptWithKey(message, conversationKey);
      const decrypted = NIP44.decryptWithKey(encrypted, conversationKey);

      expect(decrypted).toBe(message);
    });
  });

  describe('calcPaddedLen', () => {
    it('should return correct padded lengths per NIP-44 spec', () => {
      // Minimum 1 byte -> 32 bytes
      expect(NIP44.calcPaddedLen(1)).toBe(32);
      expect(NIP44.calcPaddedLen(31)).toBe(32);
      expect(NIP44.calcPaddedLen(32)).toBe(32);

      // 33 bytes -> 64 bytes (next chunk)
      expect(NIP44.calcPaddedLen(33)).toBe(64);
      expect(NIP44.calcPaddedLen(64)).toBe(64);

      // Chunk-based padding, not strict power of 2
      // For 65: nextPow2=128, chunk=max(32,16)=32, result=96
      expect(NIP44.calcPaddedLen(65)).toBe(96);

      // For 200: nextPow2=256, chunk=max(32,32)=32, result=224
      expect(NIP44.calcPaddedLen(200)).toBe(224);
    });

    it('should reject messages that are too short', () => {
      expect(() => NIP44.calcPaddedLen(0)).toThrow(/too short/);
      expect(() => NIP44.calcPaddedLen(-1)).toThrow(/too short/);
    });

    it('should reject messages that are too long', () => {
      expect(() => NIP44.calcPaddedLen(65536)).toThrow(/too long/);
    });
  });

  describe('pad/unpad', () => {
    it('should pad and unpad correctly for various lengths', () => {
      const testLengths = [1, 16, 31, 32, 33, 64, 100, 256, 1000];

      for (const len of testLengths) {
        const message = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          message[i] = i % 256;
        }

        const padded = NIP44.pad(message);
        const unpadded = NIP44.unpad(padded);

        expect(bytesToHex(unpadded)).toBe(bytesToHex(message));

        // Verify padded length is at least 32 and matches expected calculation
        const paddedLen = padded.length - 2; // Subtract 2-byte length prefix
        expect(paddedLen).toBeGreaterThanOrEqual(32);
        expect(paddedLen).toBe(NIP44.calcPaddedLen(len));
      }
    });

    it('should include 2-byte big-endian length prefix', () => {
      const message = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]); // 5 bytes
      const padded = NIP44.pad(message);

      // First 2 bytes should be big-endian length (0x00, 0x05)
      expect(padded[0]).toBe(0x00);
      expect(padded[1]).toBe(0x05);
    });

    it('should reject empty messages for padding', () => {
      expect(() => NIP44.pad(new Uint8Array(0))).toThrow(/too short/);
    });
  });

  describe('format validation', () => {
    it('should reject unsupported version', () => {
      const encrypted = NIP44.encrypt('test', alicePrivateKey, bobPublicKey);

      // Decode, change version, re-encode
      const decoded = Buffer.from(encrypted, 'base64');
      decoded[0] = 0x01; // Change to unsupported version
      const modified = decoded.toString('base64');

      expect(() => NIP44.decrypt(modified, bobPrivateKey, alicePublicKey))
        .toThrow(/Unsupported NIP-44 version/);
    });

    it('should reject payload that is too short', () => {
      const shortPayload = Buffer.from([0x02, 0x00, 0x01]).toString('base64');

      expect(() => NIP44.decrypt(shortPayload, bobPrivateKey, alicePublicKey))
        .toThrow(/too short/);
    });
  });
});
