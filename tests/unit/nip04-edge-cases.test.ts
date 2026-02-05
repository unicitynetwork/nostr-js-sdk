/**
 * Unit tests for NIP-04 corrupted and malformed data handling
 * Feature 13: NIP-04 Corrupted Data
 * Techniques: [EG] Error Guessing
 */

import { describe, it, expect } from 'vitest';
import * as NIP04 from '../../src/crypto/nip04.js';
import * as Schnorr from '../../src/crypto/schnorr.js';

describe('NIP-04 Corrupted Data Handling', () => {
  const alicePrivateKey = new Uint8Array(32).fill(0x01);
  const alicePublicKey = Schnorr.getPublicKey(alicePrivateKey);
  const bobPrivateKey = new Uint8Array(32).fill(0x02);
  const bobPublicKey = Schnorr.getPublicKey(bobPrivateKey);

  // [EG] Corrupted base64 ciphertext
  it('should fail when ciphertext is corrupted', async () => {
    const encrypted = await NIP04.encrypt('test message', alicePrivateKey, bobPublicKey);
    const parts = encrypted.split('?iv=');
    // Corrupt the ciphertext by flipping characters
    const corrupted = parts[0]!.slice(0, -4) + 'XXXX' + '?iv=' + parts[1];

    await expect(
      NIP04.decrypt(corrupted, bobPrivateKey, alicePublicKey)
    ).rejects.toThrow();
  });

  // [EG] Missing IV separator
  it('should reject message without IV separator', async () => {
    await expect(
      NIP04.decrypt('justbase64withoutiv', bobPrivateKey, alicePublicKey)
    ).rejects.toThrow(/Invalid encrypted content format/);
  });

  // [EG] Empty ciphertext with valid IV format
  it('should fail with empty ciphertext portion', async () => {
    // Empty ciphertext but valid IV format
    await expect(
      NIP04.decrypt('?iv=dGVzdGl2MTIzNDU2Nzg=', bobPrivateKey, alicePublicKey)
    ).rejects.toThrow();
  });

  // [EG] Corrupted compressed message
  it('should fail with corrupted GZIP data', async () => {
    // gz: prefix indicates compression but the data is invalid
    await expect(
      NIP04.decrypt('gz:aW52YWxpZGd6aXBkYXRh?iv=dGVzdGl2MTIzNDU2Nzg=', bobPrivateKey, alicePublicKey)
    ).rejects.toThrow();
  });

  // [EG] Truncated ciphertext
  it('should fail with truncated ciphertext', async () => {
    const encrypted = await NIP04.encrypt('Hello World test message', alicePrivateKey, bobPublicKey);
    const parts = encrypted.split('?iv=');
    // Truncate ciphertext to half
    const truncated = parts[0]!.slice(0, Math.floor(parts[0]!.length / 2)) + '?iv=' + parts[1];

    await expect(
      NIP04.decrypt(truncated, bobPrivateKey, alicePublicKey)
    ).rejects.toThrow();
  });

  // [EG] Invalid IV length
  it('should fail with invalid IV length', async () => {
    const encrypted = await NIP04.encrypt('test', alicePrivateKey, bobPublicKey);
    const parts = encrypted.split('?iv=');
    // Replace IV with a short one (not 16 bytes)
    const badIv = Buffer.from('short').toString('base64');
    const modified = parts[0] + '?iv=' + badIv;

    await expect(
      NIP04.decrypt(modified, bobPrivateKey, alicePublicKey)
    ).rejects.toThrow(/Invalid IV length/);
  });

  // [EG] Multiple ?iv= separators
  it('should fail with multiple IV separators', async () => {
    await expect(
      NIP04.decrypt('part1?iv=part2?iv=part3', bobPrivateKey, alicePublicKey)
    ).rejects.toThrow();
  });

  // [EG] Valid format but completely random data
  it('should fail to decrypt random ciphertext', async () => {
    const randomCiphertext = Buffer.from(new Uint8Array(48)).toString('base64');
    const randomIv = Buffer.from(new Uint8Array(16)).toString('base64');

    await expect(
      NIP04.decrypt(`${randomCiphertext}?iv=${randomIv}`, bobPrivateKey, alicePublicKey)
    ).rejects.toThrow();
  });

  // [EG] Very long ciphertext (should not crash)
  it('should handle very long ciphertext gracefully', async () => {
    const longCiphertext = Buffer.from(new Uint8Array(100000)).toString('base64');
    const randomIv = Buffer.from(new Uint8Array(16)).toString('base64');

    await expect(
      NIP04.decrypt(`${longCiphertext}?iv=${randomIv}`, bobPrivateKey, alicePublicKey)
    ).rejects.toThrow();
  });
});
