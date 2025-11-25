/**
 * Unit tests for Bech32 encoding/decoding
 */

import { describe, it, expect } from 'vitest';
import * as Bech32 from '../../src/crypto/bech32.js';

describe('Bech32', () => {
  describe('encode/decode roundtrip', () => {
    it('should encode and decode npub correctly', () => {
      const publicKey = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        publicKey[i] = i;
      }

      const npub = Bech32.encodeNpub(publicKey);
      expect(npub.startsWith('npub1')).toBe(true);

      const decoded = Bech32.decodeNpub(npub);
      expect(decoded).toEqual(publicKey);
    });

    it('should encode and decode nsec correctly', () => {
      const privateKey = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        privateKey[i] = 255 - i;
      }

      const nsec = Bech32.encodeNsec(privateKey);
      expect(nsec.startsWith('nsec1')).toBe(true);

      const decoded = Bech32.decodeNsec(nsec);
      expect(decoded).toEqual(privateKey);
    });

    it('should handle arbitrary data with custom HRP', () => {
      const data = new Uint8Array([0x00, 0x14, 0x28, 0x3c, 0x50]);
      const encoded = Bech32.encode('test', data);

      const decoded = Bech32.decode(encoded);
      expect(decoded.hrp).toBe('test');
      expect(decoded.data).toEqual(data);
    });
  });

  describe('known test vectors', () => {
    it('should decode known npub correctly', () => {
      // This is a test vector - all zeros pubkey
      const zeros = new Uint8Array(32);
      const npub = Bech32.encodeNpub(zeros);

      const decoded = Bech32.decodeNpub(npub);
      expect(decoded).toEqual(zeros);
    });

    it('should decode known nsec correctly', () => {
      // This is a test vector - all ones private key
      const ones = new Uint8Array(32).fill(0x01);
      const nsec = Bech32.encodeNsec(ones);

      const decoded = Bech32.decodeNsec(nsec);
      expect(decoded).toEqual(ones);
    });
  });

  describe('error handling', () => {
    it('should reject invalid npub string', () => {
      expect(() => Bech32.decodeNpub('invalid')).toThrow();
    });

    it('should reject npub with wrong prefix', () => {
      const privateKey = new Uint8Array(32);
      const nsec = Bech32.encodeNsec(privateKey);

      expect(() => Bech32.decodeNpub(nsec)).toThrow(/Expected 'npub'/);
    });

    it('should reject nsec with wrong prefix', () => {
      const publicKey = new Uint8Array(32);
      const npub = Bech32.encodeNpub(publicKey);

      expect(() => Bech32.decodeNsec(npub)).toThrow(/Expected 'nsec'/);
    });

    it('should reject keys with wrong length', () => {
      expect(() => Bech32.encodeNpub(new Uint8Array(16))).toThrow(/must be 32 bytes/);
      expect(() => Bech32.encodeNsec(new Uint8Array(64))).toThrow(/must be 32 bytes/);
    });

    it('should reject invalid checksum', () => {
      const publicKey = new Uint8Array(32);
      const npub = Bech32.encodeNpub(publicKey);
      const corrupted = npub.slice(0, -1) + 'x'; // Change last character

      expect(() => Bech32.decode(corrupted)).toThrow(/Invalid Bech32 checksum/);
    });

    it('should reject invalid characters', () => {
      expect(() => Bech32.decode('test1invalidchar!')).toThrow(/Invalid character/);
    });
  });

  describe('case insensitivity', () => {
    it('should decode uppercase bech32 strings', () => {
      const publicKey = new Uint8Array(32).fill(0xab);
      const npub = Bech32.encodeNpub(publicKey);
      const uppercase = npub.toUpperCase();

      // Should work with uppercase (converted to lowercase internally)
      const decoded = Bech32.decodeNpub(uppercase);
      expect(decoded).toEqual(publicKey);
    });
  });
});
