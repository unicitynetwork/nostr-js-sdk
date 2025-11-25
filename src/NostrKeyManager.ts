/**
 * NostrKeyManager - High-level cryptographic operations manager for Nostr.
 * Manages key pairs, signing, and NIP-04 encryption/decryption.
 */

import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import * as Bech32 from './crypto/bech32.js';
import * as Schnorr from './crypto/schnorr.js';
import * as NIP04 from './crypto/nip04.js';

/**
 * NostrKeyManager provides a high-level interface for cryptographic operations.
 * It manages a Nostr key pair and provides methods for signing, verification,
 * and NIP-04 encryption/decryption.
 */
export class NostrKeyManager {
  private privateKey: Uint8Array;
  private publicKey: Uint8Array;
  private cleared: boolean = false;

  /**
   * Private constructor - use static factory methods instead.
   */
  private constructor(privateKey: Uint8Array) {
    if (privateKey.length !== 32) {
      throw new Error('Private key must be 32 bytes');
    }
    // Make a copy to prevent external modification
    this.privateKey = new Uint8Array(privateKey);
    this.publicKey = Schnorr.getPublicKey(this.privateKey);
  }

  /**
   * Create a NostrKeyManager from a 32-byte private key.
   * @param privateKey 32-byte private key
   * @returns NostrKeyManager instance
   */
  static fromPrivateKey(privateKey: Uint8Array): NostrKeyManager {
    return new NostrKeyManager(privateKey);
  }

  /**
   * Create a NostrKeyManager from a hex-encoded private key.
   * @param privateKeyHex Hex-encoded private key (64 characters)
   * @returns NostrKeyManager instance
   */
  static fromPrivateKeyHex(privateKeyHex: string): NostrKeyManager {
    const privateKey = hexToBytes(privateKeyHex);
    return new NostrKeyManager(privateKey);
  }

  /**
   * Create a NostrKeyManager from a Bech32-encoded nsec string.
   * @param nsec nsec-encoded private key
   * @returns NostrKeyManager instance
   */
  static fromNsec(nsec: string): NostrKeyManager {
    const privateKey = Bech32.decodeNsec(nsec);
    return new NostrKeyManager(privateKey);
  }

  /**
   * Generate a new random key pair.
   * @returns NostrKeyManager instance with a new random key pair
   */
  static generate(): NostrKeyManager {
    const privateKey = randomBytes(32);
    return new NostrKeyManager(privateKey);
  }

  /**
   * Check if the key manager has been cleared.
   * @throws Error if the key manager has been cleared
   */
  private ensureNotCleared(): void {
    if (this.cleared) {
      throw new Error('KeyManager has been cleared');
    }
  }

  /**
   * Get a copy of the private key bytes.
   * @returns 32-byte private key (copy)
   */
  getPrivateKey(): Uint8Array {
    this.ensureNotCleared();
    return new Uint8Array(this.privateKey);
  }

  /**
   * Get the hex-encoded private key.
   * @returns Hex-encoded private key (64 characters)
   */
  getPrivateKeyHex(): string {
    this.ensureNotCleared();
    return bytesToHex(this.privateKey);
  }

  /**
   * Get the Bech32-encoded nsec private key.
   * @returns nsec-encoded private key
   */
  getNsec(): string {
    this.ensureNotCleared();
    return Bech32.encodeNsec(this.privateKey);
  }

  /**
   * Get a copy of the x-only public key bytes.
   * @returns 32-byte x-only public key (copy)
   */
  getPublicKey(): Uint8Array {
    this.ensureNotCleared();
    return new Uint8Array(this.publicKey);
  }

  /**
   * Get the hex-encoded public key.
   * @returns Hex-encoded public key (64 characters)
   */
  getPublicKeyHex(): string {
    this.ensureNotCleared();
    return bytesToHex(this.publicKey);
  }

  /**
   * Get the Bech32-encoded npub public key.
   * @returns npub-encoded public key
   */
  getNpub(): string {
    this.ensureNotCleared();
    return Bech32.encodeNpub(this.publicKey);
  }

  /**
   * Sign a 32-byte message hash using BIP-340 Schnorr signature.
   * @param messageHash 32-byte message hash
   * @returns 64-byte Schnorr signature
   */
  sign(messageHash: Uint8Array): Uint8Array {
    this.ensureNotCleared();
    return Schnorr.sign(messageHash, this.privateKey);
  }

  /**
   * Sign a message hash and return hex-encoded signature.
   * @param messageHash 32-byte message hash
   * @returns Hex-encoded 64-byte Schnorr signature
   */
  signHex(messageHash: Uint8Array): string {
    this.ensureNotCleared();
    return Schnorr.signHex(messageHash, this.privateKey);
  }

  /**
   * Verify a Schnorr signature (static method).
   * @param signature 64-byte Schnorr signature
   * @param messageHash 32-byte message hash
   * @param publicKey 32-byte x-only public key
   * @returns true if the signature is valid
   */
  static verify(
    signature: Uint8Array,
    messageHash: Uint8Array,
    publicKey: Uint8Array
  ): boolean {
    return Schnorr.verify(signature, messageHash, publicKey);
  }

  /**
   * Verify a hex-encoded Schnorr signature (static method).
   * @param signatureHex Hex-encoded 64-byte signature
   * @param messageHash 32-byte message hash
   * @param publicKeyHex Hex-encoded 32-byte public key
   * @returns true if the signature is valid
   */
  static verifyHex(
    signatureHex: string,
    messageHash: Uint8Array,
    publicKeyHex: string
  ): boolean {
    return Schnorr.verifyHex(signatureHex, messageHash, publicKeyHex);
  }

  /**
   * Encrypt a message using NIP-04 encryption.
   * @param message Message to encrypt
   * @param recipientPublicKey 32-byte x-only public key of recipient
   * @returns Encrypted content string
   */
  async encrypt(
    message: string,
    recipientPublicKey: Uint8Array
  ): Promise<string> {
    this.ensureNotCleared();
    return NIP04.encrypt(message, this.privateKey, recipientPublicKey);
  }

  /**
   * Encrypt a message using hex-encoded recipient public key.
   * @param message Message to encrypt
   * @param recipientPublicKeyHex Hex-encoded recipient public key
   * @returns Encrypted content string
   */
  async encryptHex(
    message: string,
    recipientPublicKeyHex: string
  ): Promise<string> {
    this.ensureNotCleared();
    const recipientPublicKey = hexToBytes(recipientPublicKeyHex);
    return NIP04.encrypt(message, this.privateKey, recipientPublicKey);
  }

  /**
   * Decrypt a NIP-04 encrypted message.
   * @param encryptedContent Encrypted content string
   * @param senderPublicKey 32-byte x-only public key of sender
   * @returns Decrypted message
   */
  async decrypt(
    encryptedContent: string,
    senderPublicKey: Uint8Array
  ): Promise<string> {
    this.ensureNotCleared();
    return NIP04.decrypt(encryptedContent, this.privateKey, senderPublicKey);
  }

  /**
   * Decrypt a message using hex-encoded sender public key.
   * @param encryptedContent Encrypted content string
   * @param senderPublicKeyHex Hex-encoded sender public key
   * @returns Decrypted message
   */
  async decryptHex(
    encryptedContent: string,
    senderPublicKeyHex: string
  ): Promise<string> {
    this.ensureNotCleared();
    const senderPublicKey = hexToBytes(senderPublicKeyHex);
    return NIP04.decrypt(encryptedContent, this.privateKey, senderPublicKey);
  }

  /**
   * Derive a shared secret using ECDH.
   * @param theirPublicKey 32-byte x-only public key
   * @returns 32-byte shared secret
   */
  deriveSharedSecret(theirPublicKey: Uint8Array): Uint8Array {
    this.ensureNotCleared();
    return NIP04.deriveSharedSecret(this.privateKey, theirPublicKey);
  }

  /**
   * Check if a public key matches this key manager's public key.
   * @param publicKeyHex Hex-encoded public key to check
   * @returns true if the public key matches
   */
  isMyPublicKey(publicKeyHex: string): boolean {
    this.ensureNotCleared();
    return this.getPublicKeyHex() === publicKeyHex.toLowerCase();
  }

  /**
   * Clear the private key from memory.
   * After calling this method, the key manager cannot be used for signing or decryption.
   */
  clear(): void {
    // Overwrite private key with zeros
    this.privateKey.fill(0);
    this.cleared = true;
  }
}
