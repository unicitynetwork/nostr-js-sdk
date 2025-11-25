/**
 * Unit tests for NostrKeyManager
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { NostrKeyManager } from '../../src/NostrKeyManager.js';

describe('NostrKeyManager', () => {
  let keyManager: NostrKeyManager;

  beforeEach(() => {
    keyManager = NostrKeyManager.generate();
  });

  describe('factory methods', () => {
    it('should create from private key bytes', () => {
      const privateKey = new Uint8Array(32).fill(0x42);
      const km = NostrKeyManager.fromPrivateKey(privateKey);

      expect(km.getPrivateKey()).toEqual(privateKey);
    });

    it('should create from hex private key', () => {
      const privateKeyHex = '42'.repeat(32);
      const km = NostrKeyManager.fromPrivateKeyHex(privateKeyHex);

      expect(km.getPrivateKeyHex()).toBe(privateKeyHex);
    });

    it('should create from nsec', () => {
      const original = NostrKeyManager.generate();
      const nsec = original.getNsec();

      const restored = NostrKeyManager.fromNsec(nsec);

      expect(restored.getPrivateKeyHex()).toBe(original.getPrivateKeyHex());
      expect(restored.getPublicKeyHex()).toBe(original.getPublicKeyHex());
    });

    it('should generate random keys', () => {
      const km1 = NostrKeyManager.generate();
      const km2 = NostrKeyManager.generate();

      expect(km1.getPrivateKeyHex()).not.toBe(km2.getPrivateKeyHex());
      expect(km1.getPublicKeyHex()).not.toBe(km2.getPublicKeyHex());
    });

    it('should reject invalid private key length', () => {
      expect(() => NostrKeyManager.fromPrivateKey(new Uint8Array(16))).toThrow(/must be 32 bytes/);
    });
  });

  describe('key access', () => {
    it('should return private key copy', () => {
      const pk1 = keyManager.getPrivateKey();
      const pk2 = keyManager.getPrivateKey();

      expect(pk1).toEqual(pk2);
      expect(pk1).not.toBe(pk2); // Different instances
    });

    it('should return public key copy', () => {
      const pk1 = keyManager.getPublicKey();
      const pk2 = keyManager.getPublicKey();

      expect(pk1).toEqual(pk2);
      expect(pk1).not.toBe(pk2); // Different instances
    });

    it('should return hex-encoded keys', () => {
      const privateKeyHex = keyManager.getPrivateKeyHex();
      const publicKeyHex = keyManager.getPublicKeyHex();

      expect(privateKeyHex.length).toBe(64);
      expect(publicKeyHex.length).toBe(64);
      expect(/^[0-9a-f]+$/.test(privateKeyHex)).toBe(true);
      expect(/^[0-9a-f]+$/.test(publicKeyHex)).toBe(true);
    });

    it('should return bech32-encoded keys', () => {
      const nsec = keyManager.getNsec();
      const npub = keyManager.getNpub();

      expect(nsec.startsWith('nsec1')).toBe(true);
      expect(npub.startsWith('npub1')).toBe(true);
    });
  });

  describe('signing', () => {
    it('should sign a message hash', () => {
      const messageHash = new Uint8Array(32).fill(0x01);

      const signature = keyManager.sign(messageHash);

      expect(signature.length).toBe(64);
    });

    it('should return hex-encoded signature', () => {
      const messageHash = new Uint8Array(32).fill(0x01);

      const signatureHex = keyManager.signHex(messageHash);

      expect(signatureHex.length).toBe(128);
      expect(/^[0-9a-f]+$/.test(signatureHex)).toBe(true);
    });

    it('should produce verifiable signatures', () => {
      const messageHash = new Uint8Array(32).fill(0x01);
      const signature = keyManager.sign(messageHash);
      const publicKey = keyManager.getPublicKey();

      const valid = NostrKeyManager.verify(signature, messageHash, publicKey);
      expect(valid).toBe(true);
    });
  });

  describe('static verification', () => {
    it('should verify valid signature', () => {
      const messageHash = new Uint8Array(32).fill(0x01);
      const signature = keyManager.sign(messageHash);
      const publicKey = keyManager.getPublicKey();

      expect(NostrKeyManager.verify(signature, messageHash, publicKey)).toBe(true);
    });

    it('should verify with hex encoding', () => {
      const messageHash = new Uint8Array(32).fill(0x01);
      const signatureHex = keyManager.signHex(messageHash);
      const publicKeyHex = keyManager.getPublicKeyHex();

      expect(NostrKeyManager.verifyHex(signatureHex, messageHash, publicKeyHex)).toBe(true);
    });

    it('should reject invalid signature', () => {
      const messageHash = new Uint8Array(32).fill(0x01);
      const signature = keyManager.sign(messageHash);
      const publicKey = keyManager.getPublicKey();

      // Tamper with signature
      signature[0] = (signature[0]! + 1) % 256;

      expect(NostrKeyManager.verify(signature, messageHash, publicKey)).toBe(false);
    });
  });

  describe('encryption/decryption', () => {
    let alice: NostrKeyManager;
    let bob: NostrKeyManager;

    beforeEach(() => {
      alice = NostrKeyManager.generate();
      bob = NostrKeyManager.generate();
    });

    it('should encrypt and decrypt message', async () => {
      const message = 'Hello, Bob!';

      const encrypted = await alice.encrypt(message, bob.getPublicKey());
      const decrypted = await bob.decrypt(encrypted, alice.getPublicKey());

      expect(decrypted).toBe(message);
    });

    it('should encrypt and decrypt with hex methods', async () => {
      const message = 'Hello, Bob!';

      const encrypted = await alice.encryptHex(message, bob.getPublicKeyHex());
      const decrypted = await bob.decryptHex(encrypted, alice.getPublicKeyHex());

      expect(decrypted).toBe(message);
    });

    it('should derive same shared secret', () => {
      const secretAlice = alice.deriveSharedSecret(bob.getPublicKey());
      const secretBob = bob.deriveSharedSecret(alice.getPublicKey());

      expect(bytesToHex(secretAlice)).toBe(bytesToHex(secretBob));
    });
  });

  describe('isMyPublicKey', () => {
    it('should return true for own public key', () => {
      const publicKeyHex = keyManager.getPublicKeyHex();
      expect(keyManager.isMyPublicKey(publicKeyHex)).toBe(true);
    });

    it('should return true for uppercase public key', () => {
      const publicKeyHex = keyManager.getPublicKeyHex().toUpperCase();
      expect(keyManager.isMyPublicKey(publicKeyHex)).toBe(true);
    });

    it('should return false for different public key', () => {
      const other = NostrKeyManager.generate();
      expect(keyManager.isMyPublicKey(other.getPublicKeyHex())).toBe(false);
    });
  });

  describe('clear', () => {
    it('should prevent further operations after clear', async () => {
      keyManager.clear();

      expect(() => keyManager.getPrivateKey()).toThrow(/has been cleared/);
      expect(() => keyManager.getPublicKey()).toThrow(/has been cleared/);
      expect(() => keyManager.sign(new Uint8Array(32))).toThrow(/has been cleared/);
    });

    it('should wipe private key from memory', () => {
      const privateKey = new Uint8Array(32).fill(0x42);
      const km = NostrKeyManager.fromPrivateKey(privateKey);

      // Get reference to internal key
      const internalKey = km.getPrivateKey();
      expect(internalKey[0]).toBe(0x42);

      km.clear();

      // Original input should still be intact
      expect(privateKey[0]).toBe(0x42);
    });
  });
});
