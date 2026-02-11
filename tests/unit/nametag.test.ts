/**
 * Unit tests for Nametag utilities
 */

import { describe, it, expect } from 'vitest';
import * as NametagUtils from '../../src/nametag/NametagUtils.js';
import * as NametagBinding from '../../src/nametag/NametagBinding.js';
import { NostrKeyManager } from '../../src/NostrKeyManager.js';
import * as EventKinds from '../../src/protocol/EventKinds.js';

describe('NametagUtils', () => {
  describe('normalizeNametag', () => {
    it('should lowercase usernames', () => {
      expect(NametagUtils.normalizeNametag('Alice')).toBe('alice');
      expect(NametagUtils.normalizeNametag('BOB')).toBe('bob');
      expect(NametagUtils.normalizeNametag('CamelCase')).toBe('camelcase');
    });

    it('should remove @unicity suffix', () => {
      expect(NametagUtils.normalizeNametag('alice@unicity')).toBe('alice');
      expect(NametagUtils.normalizeNametag('Alice@unicity')).toBe('alice');
    });

    it('should normalize phone numbers to E.164', () => {
      // US numbers
      expect(NametagUtils.normalizeNametag('+14155551234', 'US')).toBe('+14155551234');
      expect(NametagUtils.normalizeNametag('415-555-1234', 'US')).toBe('+14155551234');
      expect(NametagUtils.normalizeNametag('(415) 555-1234', 'US')).toBe('+14155551234');
    });

    it('should handle international phone numbers', () => {
      // UK number
      expect(NametagUtils.normalizeNametag('+442071234567', 'GB')).toBe('+442071234567');
    });

    it('should trim whitespace', () => {
      expect(NametagUtils.normalizeNametag('  alice  ')).toBe('alice');
      expect(NametagUtils.normalizeNametag('\n+14155551234\t', 'US')).toBe('+14155551234');
    });
  });

  describe('hashNametag', () => {
    it('should produce consistent hashes', () => {
      const hash1 = NametagUtils.hashNametag('alice');
      const hash2 = NametagUtils.hashNametag('alice');

      expect(hash1).toBe(hash2);
    });

    it('should produce 64-character hex hash', () => {
      const hash = NametagUtils.hashNametag('test');
      expect(hash.length).toBe(64);
      expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
    });

    it('should normalize before hashing', () => {
      expect(NametagUtils.hashNametag('Alice')).toBe(NametagUtils.hashNametag('alice'));
      expect(NametagUtils.hashNametag('alice@unicity')).toBe(NametagUtils.hashNametag('alice'));
    });

    it('should produce different hashes for different inputs', () => {
      const hash1 = NametagUtils.hashNametag('alice');
      const hash2 = NametagUtils.hashNametag('bob');

      expect(hash1).not.toBe(hash2);
    });

    it('should hash phone numbers consistently', () => {
      const hash1 = NametagUtils.hashNametag('+14155551234', 'US');
      const hash2 = NametagUtils.hashNametag('415-555-1234', 'US');

      expect(hash1).toBe(hash2);
    });
  });

  describe('areSameNametag', () => {
    it('should match same nametags with different cases', () => {
      expect(NametagUtils.areSameNametag('alice', 'Alice')).toBe(true);
      expect(NametagUtils.areSameNametag('BOB', 'bob')).toBe(true);
    });

    it('should match nametags with @unicity suffix', () => {
      expect(NametagUtils.areSameNametag('alice', 'alice@unicity')).toBe(true);
    });

    it('should match same phone numbers in different formats', () => {
      expect(NametagUtils.areSameNametag('+14155551234', '415-555-1234', 'US')).toBe(true);
      expect(NametagUtils.areSameNametag('(415) 555-1234', '4155551234', 'US')).toBe(true);
    });

    it('should not match different nametags', () => {
      expect(NametagUtils.areSameNametag('alice', 'bob')).toBe(false);
      expect(NametagUtils.areSameNametag('+14155551234', '+14155551235', 'US')).toBe(false);
    });
  });

  describe('formatForDisplay', () => {
    it('should hide middle digits of phone numbers', () => {
      const formatted = NametagUtils.formatForDisplay('+14155551234', 'US');
      expect(formatted).toMatch(/\+1415\*+1234/);
    });

    it('should return normalized username for non-phone', () => {
      expect(NametagUtils.formatForDisplay('Alice')).toBe('alice');
      expect(NametagUtils.formatForDisplay('bob@unicity')).toBe('bob');
    });
  });

  describe('isPhoneNumber', () => {
    it('should recognize valid phone numbers', () => {
      expect(NametagUtils.isPhoneNumber('+14155551234', 'US')).toBe(true);
      expect(NametagUtils.isPhoneNumber('415-555-1234', 'US')).toBe(true);
    });

    it('should reject invalid phone numbers', () => {
      expect(NametagUtils.isPhoneNumber('123', 'US')).toBe(false);
      expect(NametagUtils.isPhoneNumber('alice', 'US')).toBe(false);
    });
  });

  describe('isValidNametag', () => {
    it('should accept valid lowercase nametags', () => {
      expect(NametagUtils.isValidNametag('alice')).toBe(true);
      expect(NametagUtils.isValidNametag('bob_42')).toBe(true);
      expect(NametagUtils.isValidNametag('my-wallet')).toBe(true);
    });

    it('should accept uppercase input (normalized to lowercase)', () => {
      expect(NametagUtils.isValidNametag('@Alice')).toBe(true);
      expect(NametagUtils.isValidNametag('BOB')).toBe(true);
    });

    it('should reject too short nametags', () => {
      expect(NametagUtils.isValidNametag('ab')).toBe(false);
      expect(NametagUtils.isValidNametag('a')).toBe(false);
    });

    it('should reject too long nametags', () => {
      expect(NametagUtils.isValidNametag('a'.repeat(21))).toBe(false);
    });

    it('should accept nametags at boundary lengths', () => {
      expect(NametagUtils.isValidNametag('abc')).toBe(true); // min length
      expect(NametagUtils.isValidNametag('a'.repeat(20))).toBe(true); // max length
    });

    it('should reject nametags with invalid characters', () => {
      expect(NametagUtils.isValidNametag('hello world')).toBe(false);
      expect(NametagUtils.isValidNametag('a]b')).toBe(false);
      expect(NametagUtils.isValidNametag('foo.bar')).toBe(false);
    });

    it('should accept valid phone numbers', () => {
      expect(NametagUtils.isValidNametag('+14155552671', 'US')).toBe(true);
      expect(NametagUtils.isValidNametag('415-555-2671', 'US')).toBe(true);
    });

    it('should strip @unicity suffix before validation', () => {
      expect(NametagUtils.isValidNametag('alice@unicity')).toBe(true);
    });
  });

  describe('constants', () => {
    it('should export NAMETAG_MIN_LENGTH', () => {
      expect(NametagUtils.NAMETAG_MIN_LENGTH).toBe(3);
    });

    it('should export NAMETAG_MAX_LENGTH', () => {
      expect(NametagUtils.NAMETAG_MAX_LENGTH).toBe(20);
    });
  });
});

describe('NametagBinding', () => {
  let keyManager: NostrKeyManager;

  beforeEach(() => {
    keyManager = NostrKeyManager.generate();
  });

  describe('createBindingEvent', () => {
    it('should create a valid binding event', async () => {
      const event = await NametagBinding.createBindingEvent(
        keyManager,
        'alice',
        'unicity_address_123'
      );

      expect(event.kind).toBe(EventKinds.APP_DATA);
      expect(event.pubkey).toBe(keyManager.getPublicKeyHex());
      expect(event.verify()).toBe(true);
    });

    it('should include required tags', async () => {
      const event = await NametagBinding.createBindingEvent(
        keyManager,
        'alice',
        'unicity_address_123'
      );

      expect(event.hasTag('d')).toBe(true);
      expect(event.hasTag('nametag')).toBe(true);
      expect(event.hasTag('t')).toBe(true);
      expect(event.hasTag('address')).toBe(true);

      expect(event.getTagValue('address')).toBe('unicity_address_123');
    });

    it('should hash nametag in tags', async () => {
      const event = await NametagBinding.createBindingEvent(
        keyManager,
        'alice',
        'unicity_address_123'
      );

      const expectedHash = NametagUtils.hashNametag('alice');
      expect(event.getTagValue('d')).toBe(expectedHash);
      expect(event.getTagValue('nametag')).toBe(expectedHash);
      expect(event.getTagValue('t')).toBe(expectedHash);
    });

    it('should include structured content', async () => {
      const event = await NametagBinding.createBindingEvent(
        keyManager,
        'alice',
        'unicity_address_123'
      );

      const content = JSON.parse(event.content);
      expect(content.nametag_hash).toBe(NametagUtils.hashNametag('alice'));
      expect(content.address).toBe('unicity_address_123');
      expect(content.verified).toBeDefined();
    });
  });

  describe('createNametagToPubkeyFilter', () => {
    it('should create filter for nametag lookup', () => {
      const filter = NametagBinding.createNametagToPubkeyFilter('alice');

      expect(filter.kinds).toContain(EventKinds.APP_DATA);
      expect(filter['#t']).toContain(NametagUtils.hashNametag('alice'));
    });
  });

  describe('createPubkeyToNametagFilter', () => {
    it('should create filter for pubkey lookup', () => {
      const pubkey = 'a'.repeat(64);
      const filter = NametagBinding.createPubkeyToNametagFilter(pubkey);

      expect(filter.kinds).toContain(EventKinds.APP_DATA);
      expect(filter.authors).toContain(pubkey);
      expect(filter.limit).toBe(10);
    });
  });

  describe('parseNametagHashFromEvent', () => {
    it('should parse nametag hash from tags', async () => {
      const event = await NametagBinding.createBindingEvent(
        keyManager,
        'alice',
        'address'
      );

      const hash = NametagBinding.parseNametagHashFromEvent(event);
      expect(hash).toBe(NametagUtils.hashNametag('alice'));
    });
  });

  describe('parseAddressFromEvent', () => {
    it('should parse address from tags', async () => {
      const event = await NametagBinding.createBindingEvent(
        keyManager,
        'alice',
        'unicity_address_123'
      );

      const address = NametagBinding.parseAddressFromEvent(event);
      expect(address).toBe('unicity_address_123');
    });
  });

  describe('isValidBindingEvent', () => {
    it('should validate correct binding event', async () => {
      const event = await NametagBinding.createBindingEvent(
        keyManager,
        'alice',
        'address'
      );

      expect(NametagBinding.isValidBindingEvent(event)).toBe(true);
    });

    it('should reject event with wrong kind', async () => {
      const { Event } = await import('../../src/protocol/Event.js');
      const event = Event.create(keyManager, {
        kind: 1, // Wrong kind
        tags: [['d', 'test']],
        content: JSON.stringify({ nametag_hash: 'hash', address: 'addr' }),
      });

      expect(NametagBinding.isValidBindingEvent(event)).toBe(false);
    });
  });
});
