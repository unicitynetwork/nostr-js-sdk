/**
 * Unit tests for NIP-44 corrupted data and padding edge cases
 * Features 14 & 15: NIP-44 Corrupted Data + Padding Edge Cases
 * Techniques: [EG] Error Guessing, [BVA] Boundary Value Analysis, [EP] Equivalence Partitioning
 */

import { describe, it, expect } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';
import * as NIP44 from '../../src/crypto/nip44.js';
import * as Schnorr from '../../src/crypto/schnorr.js';

describe('NIP-44 Corrupted Data Handling', () => {
  const alicePrivateKey = new Uint8Array(32).fill(0x01);
  const alicePublicKey = Schnorr.getPublicKey(alicePrivateKey);
  const bobPrivateKey = new Uint8Array(32).fill(0x02);
  const bobPublicKey = Schnorr.getPublicKey(bobPrivateKey);

  // [EG] Corrupted ciphertext byte
  it('should fail to decrypt when ciphertext is corrupted (MAC mismatch)', () => {
    const encrypted = NIP44.encrypt('test message', alicePrivateKey, bobPublicKey);
    const decoded = Buffer.from(encrypted, 'base64');

    // Corrupt a byte in the ciphertext area (after version + nonce = 25 bytes)
    if (decoded.length > 30) {
      decoded[30] = (decoded[30]! + 1) % 256;
    }
    const corrupted = decoded.toString('base64');

    expect(() => NIP44.decrypt(corrupted, bobPrivateKey, alicePublicKey)).toThrow();
  });

  // [EG] Wrong version byte 0x01
  it('should reject version byte 0x01', () => {
    const encrypted = NIP44.encrypt('test', alicePrivateKey, bobPublicKey);
    const decoded = Buffer.from(encrypted, 'base64');
    decoded[0] = 0x01;
    const modified = decoded.toString('base64');

    expect(() => NIP44.decrypt(modified, bobPrivateKey, alicePublicKey))
      .toThrow(/Unsupported NIP-44 version: 1/);
  });

  // [EG] Wrong version byte 0x00
  it('should reject version byte 0x00', () => {
    const encrypted = NIP44.encrypt('test', alicePrivateKey, bobPublicKey);
    const decoded = Buffer.from(encrypted, 'base64');
    decoded[0] = 0x00;
    const modified = decoded.toString('base64');

    expect(() => NIP44.decrypt(modified, bobPrivateKey, alicePublicKey))
      .toThrow(/Unsupported NIP-44 version: 0/);
  });

  // [EG] Wrong version byte 0xFF
  it('should reject version byte 0xFF', () => {
    const encrypted = NIP44.encrypt('test', alicePrivateKey, bobPublicKey);
    const decoded = Buffer.from(encrypted, 'base64');
    decoded[0] = 0xFF;
    const modified = decoded.toString('base64');

    expect(() => NIP44.decrypt(modified, bobPrivateKey, alicePublicKey))
      .toThrow(/Unsupported NIP-44 version/);
  });

  // [BVA] Payload too short — 10 bytes
  it('should reject payload of only 10 bytes', () => {
    const shortPayload = Buffer.from(new Uint8Array(10)).toString('base64');
    // Set version byte
    const buf = Buffer.from(shortPayload, 'base64');
    buf[0] = 0x02;
    const encoded = buf.toString('base64');

    expect(() => NIP44.decrypt(encoded, bobPrivateKey, alicePublicKey))
      .toThrow(/too short/);
  });

  // [BVA] Payload at minimum valid length (1 + 24 + 32 + 16 = 73 bytes) but invalid crypto
  it('should reject minimum-length payload with invalid crypto data', () => {
    const payload = new Uint8Array(73);
    payload[0] = 0x02; // correct version
    // rest is zeros — will fail on crypto, not on "too short"
    const encoded = Buffer.from(payload).toString('base64');

    expect(() => NIP44.decrypt(encoded, bobPrivateKey, alicePublicKey)).toThrow();
    // Should NOT throw "too short" — it's the right length, just bad crypto
    try {
      NIP44.decrypt(encoded, bobPrivateKey, alicePublicKey);
    } catch (e: unknown) {
      expect((e as Error).message).not.toMatch(/too short/);
    }
  });

  // [BVA] Payload of 72 bytes (1 under minimum)
  it('should reject payload of 72 bytes as too short', () => {
    const payload = new Uint8Array(72);
    payload[0] = 0x02;
    const encoded = Buffer.from(payload).toString('base64');

    expect(() => NIP44.decrypt(encoded, bobPrivateKey, alicePublicKey))
      .toThrow(/too short/);
  });

  // [EG] Truncated nonce
  it('should reject payload with truncated nonce', () => {
    // 1 (version) + 10 (partial nonce) = 11 bytes total
    const payload = new Uint8Array(11);
    payload[0] = 0x02;
    const encoded = Buffer.from(payload).toString('base64');

    expect(() => NIP44.decrypt(encoded, bobPrivateKey, alicePublicKey))
      .toThrow(/too short/);
  });

  // [EG] Corrupted nonce but correct length
  it('should fail when nonce is corrupted', () => {
    const encrypted = NIP44.encrypt('test data', alicePrivateKey, bobPublicKey);
    const decoded = Buffer.from(encrypted, 'base64');

    // Corrupt nonce area (bytes 1-24)
    for (let i = 1; i <= 24 && i < decoded.length; i++) {
      decoded[i] = (decoded[i]! + 1) % 256;
    }
    const corrupted = decoded.toString('base64');

    expect(() => NIP44.decrypt(corrupted, bobPrivateKey, alicePublicKey)).toThrow();
  });

  // [EG] Empty base64 string
  it('should reject empty base64 string', () => {
    expect(() => NIP44.decrypt('', bobPrivateKey, alicePublicKey)).toThrow();
  });
});

describe('NIP-44 Padding Edge Cases', () => {
  // [BVA] calcPaddedLen boundary values
  describe('calcPaddedLen boundaries', () => {
    it('should return 32 for lengths 1 through 32', () => {
      expect(NIP44.calcPaddedLen(1)).toBe(32);
      expect(NIP44.calcPaddedLen(16)).toBe(32);
      expect(NIP44.calcPaddedLen(31)).toBe(32);
      expect(NIP44.calcPaddedLen(32)).toBe(32);
    });

    it('should return 64 for length 33', () => {
      expect(NIP44.calcPaddedLen(33)).toBe(64);
    });

    it('should return 64 for length 64', () => {
      expect(NIP44.calcPaddedLen(64)).toBe(64);
    });

    it('should handle mid-range values', () => {
      // For 65: nextPow2=128, chunk=max(32,16)=32 -> ceil(65/32)*32 = 96
      expect(NIP44.calcPaddedLen(65)).toBe(96);
      // For 100: nextPow2=128, chunk=max(32,16)=32 -> ceil(100/32)*32 = 128
      expect(NIP44.calcPaddedLen(100)).toBe(128);
    });

    it('should handle values near 256', () => {
      expect(NIP44.calcPaddedLen(255)).toBe(256);
      expect(NIP44.calcPaddedLen(256)).toBe(256);
      expect(NIP44.calcPaddedLen(257)).toBe(320);
    });

    it('should handle large values', () => {
      expect(NIP44.calcPaddedLen(1000)).toBe(1024);
      expect(NIP44.calcPaddedLen(65535)).toBe(65536);
    });

    // [BVA] Invalid: zero length
    it('should reject zero length', () => {
      expect(() => NIP44.calcPaddedLen(0)).toThrow(/too short/);
    });

    // [BVA] Invalid: negative length
    it('should reject negative length', () => {
      expect(() => NIP44.calcPaddedLen(-1)).toThrow(/too short/);
    });

    // [BVA] Invalid: exceeds maximum
    it('should reject length 65536', () => {
      expect(() => NIP44.calcPaddedLen(65536)).toThrow(/too long/);
    });

    // [BVA] Maximum valid length
    it('should accept length 65535', () => {
      expect(NIP44.calcPaddedLen(65535)).toBeGreaterThanOrEqual(65535);
    });
  });

  // [EP] Pad/Unpad roundtrip
  describe('pad/unpad roundtrip', () => {
    it('should preserve message for various lengths', () => {
      const testLengths = [1, 5, 16, 31, 32, 33, 50, 64, 65, 100, 256, 500, 1000];

      for (const len of testLengths) {
        const message = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          message[i] = i % 256;
        }

        const padded = NIP44.pad(message);
        const unpadded = NIP44.unpad(padded);

        expect(bytesToHex(unpadded)).toBe(bytesToHex(message));
      }
    });

    it('should include 2-byte big-endian length prefix', () => {
      const message = new Uint8Array(300); // 0x012C
      const padded = NIP44.pad(message);

      expect(padded[0]).toBe(0x01); // high byte
      expect(padded[1]).toBe(0x2C); // low byte (300 & 0xFF = 44 = 0x2C)
    });

    it('should include correct length prefix for small message', () => {
      const message = new Uint8Array(5);
      const padded = NIP44.pad(message);

      expect(padded[0]).toBe(0x00); // high byte
      expect(padded[1]).toBe(0x05); // low byte
    });
  });

  // Unpad error conditions
  describe('unpad error handling', () => {
    it('should reject padded data that is too short', () => {
      // Less than 2 + 32 = 34 bytes
      const shortPadded = new Uint8Array(10);
      expect(() => NIP44.unpad(shortPadded)).toThrow(/too short/);
    });

    it('should reject padded data with zero length prefix', () => {
      // Create a padded buffer with length prefix = 0
      const padded = new Uint8Array(2 + 32); // 34 bytes
      padded[0] = 0x00;
      padded[1] = 0x00; // length = 0

      expect(() => NIP44.unpad(padded)).toThrow(/Invalid message length/);
    });

    it('should reject padded data with wrong padding size', () => {
      // Create a valid-looking padded buffer but with mismatched padding
      const padded = new Uint8Array(2 + 64); // 66 bytes total
      padded[0] = 0x00;
      padded[1] = 0x05; // claims 5 bytes, but calcPaddedLen(5) = 32, not 64

      expect(() => NIP44.unpad(padded)).toThrow(/Invalid padding/);
    });
  });

  // Pad error conditions
  describe('pad error handling', () => {
    it('should reject empty message', () => {
      expect(() => NIP44.pad(new Uint8Array(0))).toThrow(/too short/);
    });

    it('should reject message exceeding max length', () => {
      expect(() => NIP44.pad(new Uint8Array(65536))).toThrow(/too long/);
    });

    it('should accept maximum-length message', () => {
      const padded = NIP44.pad(new Uint8Array(65535));
      expect(padded.length).toBeGreaterThanOrEqual(2 + 65535);
    });
  });
});
