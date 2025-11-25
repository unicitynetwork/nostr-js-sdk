/**
 * Unit tests for NIP-04 encryption
 */

import { describe, it, expect } from 'vitest';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import * as NIP04 from '../../src/crypto/nip04.js';
import * as Schnorr from '../../src/crypto/schnorr.js';

describe('NIP04 Encryption', () => {
  // Generate test key pairs
  const alicePrivateKey = new Uint8Array(32).fill(0x01);
  const alicePublicKey = Schnorr.getPublicKey(alicePrivateKey);

  const bobPrivateKey = new Uint8Array(32).fill(0x02);
  const bobPublicKey = Schnorr.getPublicKey(bobPrivateKey);

  describe('deriveSharedSecret', () => {
    it('should derive the same shared secret from both sides', () => {
      const secretAlice = NIP04.deriveSharedSecret(alicePrivateKey, bobPublicKey);
      const secretBob = NIP04.deriveSharedSecret(bobPrivateKey, alicePublicKey);

      expect(bytesToHex(secretAlice)).toBe(bytesToHex(secretBob));
    });

    it('should return 32-byte shared secret', () => {
      const secret = NIP04.deriveSharedSecret(alicePrivateKey, bobPublicKey);
      expect(secret.length).toBe(32);
    });

    it('should produce different secrets with different keys', () => {
      const charliePrivateKey = new Uint8Array(32).fill(0x03);
      const charliePublicKey = Schnorr.getPublicKey(charliePrivateKey);

      const secretAB = NIP04.deriveSharedSecret(alicePrivateKey, bobPublicKey);
      const secretAC = NIP04.deriveSharedSecret(alicePrivateKey, charliePublicKey);

      expect(bytesToHex(secretAB)).not.toBe(bytesToHex(secretAC));
    });

    it('should reject invalid key lengths', () => {
      expect(() => NIP04.deriveSharedSecret(new Uint8Array(16), bobPublicKey))
        .toThrow(/must be 32 bytes/);
      expect(() => NIP04.deriveSharedSecret(alicePrivateKey, new Uint8Array(16)))
        .toThrow(/must be 32 bytes/);
    });
  });

  describe('deriveSharedSecretHex', () => {
    it('should work with hex strings', () => {
      const secret = NIP04.deriveSharedSecretHex(
        bytesToHex(alicePrivateKey),
        bytesToHex(bobPublicKey)
      );

      const expected = NIP04.deriveSharedSecret(alicePrivateKey, bobPublicKey);
      expect(secret).toBe(bytesToHex(expected));
    });
  });

  describe('encrypt/decrypt', () => {
    it('should encrypt and decrypt a simple message', async () => {
      const message = 'Hello, World!';

      const encrypted = await NIP04.encrypt(message, alicePrivateKey, bobPublicKey);
      expect(encrypted).toContain('?iv=');

      const decrypted = await NIP04.decrypt(encrypted, bobPrivateKey, alicePublicKey);
      expect(decrypted).toBe(message);
    });

    it('should produce different ciphertexts for same message (random IV)', async () => {
      const message = 'Same message';

      const encrypted1 = await NIP04.encrypt(message, alicePrivateKey, bobPublicKey);
      const encrypted2 = await NIP04.encrypt(message, alicePrivateKey, bobPublicKey);

      expect(encrypted1).not.toBe(encrypted2);

      // But both should decrypt to same message
      const decrypted1 = await NIP04.decrypt(encrypted1, bobPrivateKey, alicePublicKey);
      const decrypted2 = await NIP04.decrypt(encrypted2, bobPrivateKey, alicePublicKey);

      expect(decrypted1).toBe(message);
      expect(decrypted2).toBe(message);
    });

    it('should handle unicode characters', async () => {
      const message = '🎉 Hello 世界! Привет мир! 🚀';

      const encrypted = await NIP04.encrypt(message, alicePrivateKey, bobPublicKey);
      const decrypted = await NIP04.decrypt(encrypted, bobPrivateKey, alicePublicKey);

      expect(decrypted).toBe(message);
    });

    it('should handle empty string', async () => {
      const message = '';

      const encrypted = await NIP04.encrypt(message, alicePrivateKey, bobPublicKey);
      const decrypted = await NIP04.decrypt(encrypted, bobPrivateKey, alicePublicKey);

      expect(decrypted).toBe(message);
    });

    it('should compress large messages', async () => {
      // Create a large repetitive message (>1KB)
      const message = 'A'.repeat(2000);

      const encrypted = await NIP04.encrypt(message, alicePrivateKey, bobPublicKey);

      // Check for compression prefix
      expect(encrypted.startsWith('gz:')).toBe(true);

      // Should still decrypt correctly
      const decrypted = await NIP04.decrypt(encrypted, bobPrivateKey, alicePublicKey);
      expect(decrypted).toBe(message);
    });

    it('should handle messages just under compression threshold', async () => {
      // Message just under 1KB
      const message = 'X'.repeat(1000);

      const encrypted = await NIP04.encrypt(message, alicePrivateKey, bobPublicKey);

      // Should not be compressed
      expect(encrypted.startsWith('gz:')).toBe(false);

      const decrypted = await NIP04.decrypt(encrypted, bobPrivateKey, alicePublicKey);
      expect(decrypted).toBe(message);
    });

    it('should fail with wrong key', async () => {
      const message = 'Secret message';
      const charliePrivateKey = new Uint8Array(32).fill(0x03);

      const encrypted = await NIP04.encrypt(message, alicePrivateKey, bobPublicKey);

      // Try to decrypt with wrong key
      await expect(
        NIP04.decrypt(encrypted, charliePrivateKey, alicePublicKey)
      ).rejects.toThrow();
    });
  });

  describe('encryptHex/decryptHex', () => {
    it('should work with hex-encoded keys', async () => {
      const message = 'Test message';

      const encrypted = await NIP04.encryptHex(
        message,
        bytesToHex(alicePrivateKey),
        bytesToHex(bobPublicKey)
      );

      const decrypted = await NIP04.decryptHex(
        encrypted,
        bytesToHex(bobPrivateKey),
        bytesToHex(alicePublicKey)
      );

      expect(decrypted).toBe(message);
    });
  });

  describe('format validation', () => {
    it('should reject invalid format without IV', async () => {
      const invalidContent = 'base64contentwithoutiv';

      await expect(
        NIP04.decrypt(invalidContent, bobPrivateKey, alicePublicKey)
      ).rejects.toThrow(/Invalid encrypted content format/);
    });
  });
});
