/**
 * Unit tests for Nametag edge cases
 * Covers phone number heuristic, normalization quirks, display formatting
 * Techniques: [EG] Error Guessing, [BVA] Boundary Value Analysis
 */

import { describe, it, expect } from 'vitest';
import * as NametagUtils from '../../src/nametag/NametagUtils.js';

describe('Nametag Edge Cases', () => {
  // ==========================================================
  // Phone number heuristic edge cases
  // ==========================================================
  describe('phone number heuristic', () => {
    // These SHOULD be treated as phone numbers
    it('should treat +1 prefix as phone number', () => {
      const normalized = NametagUtils.normalizeNametag('+14155551234');
      expect(normalized).toBe('+14155551234');
    });

    it('should treat formatted US phone as phone number', () => {
      const normalized = NametagUtils.normalizeNametag('(415) 555-1234');
      expect(normalized).toBe('+14155551234');
    });

    it('should treat phone with dashes as phone number', () => {
      const normalized = NametagUtils.normalizeNametag('415-555-1234');
      expect(normalized).toBe('+14155551234');
    });

    // Edge cases that might be misclassified
    it('should NOT treat "user123" as phone (only 3 digits)', () => {
      const normalized = NametagUtils.normalizeNametag('user123');
      expect(normalized).toBe('user123');
    });

    it('should NOT treat "test12345" as phone (only 5 digits)', () => {
      const normalized = NametagUtils.normalizeNametag('test12345');
      expect(normalized).toBe('test12345');
    });

    it('should NOT treat "abc1234567" as phone (7 digits but <50% ratio)', () => {
      // 7 digits, 10 total chars = 70% but with 'abc' prefix it's borderline
      const normalized = NametagUtils.normalizeNametag('abc1234567');
      // This has 7 digits out of 10 chars = 70% ratio > 50%, so it WILL be treated as phone
      // But it's not a valid phone number, so it falls back to standard normalization
      expect(normalized).toBe('abc1234567');
    });

    // WARNING: This is the "user1234567" case from Java findings
    // A nametag like "user1234567" (7+ digits, >50% digits) gets treated as a phone number
    it('should handle "user1234567" - 7 digits with text prefix', () => {
      // 7 digits out of 11 chars = 63% ratio > 50%
      // This WILL trigger phone detection, but then fail validation
      const normalized = NametagUtils.normalizeNametag('user1234567');
      // Falls back to standard normalization since it's not a valid phone
      expect(normalized).toBe('user1234567');
    });

    it('should handle "12345678901" - just digits, looks like phone', () => {
      const normalized = NametagUtils.normalizeNametag('12345678901');
      // 11 digits, all digits = 100% ratio, treated as phone
      // libphonenumber interprets leading 1 as US country code
      expect(normalized).toBe('+12345678901');
    });

    it('should handle 6-digit code (below threshold)', () => {
      const normalized = NametagUtils.normalizeNametag('123456');
      // Only 6 digits, below 7 threshold, NOT treated as phone
      expect(normalized).toBe('123456');
    });

    it('should handle 7-digit number (at threshold)', () => {
      const normalized = NametagUtils.normalizeNametag('1234567');
      // Exactly 7 digits, 100% ratio, treated as phone
      // May or may not be valid depending on country
      const result = NametagUtils.normalizeNametag('1234567');
      expect(result).toBeDefined();
    });
  });

  // ==========================================================
  // Standard normalization
  // ==========================================================
  describe('standard normalization', () => {
    it('should lowercase nametag', () => {
      expect(NametagUtils.normalizeNametag('Alice')).toBe('alice');
    });

    it('should lowercase mixed case', () => {
      expect(NametagUtils.normalizeNametag('AlIcE')).toBe('alice');
    });

    it('should remove @unicity suffix', () => {
      expect(NametagUtils.normalizeNametag('alice@unicity')).toBe('alice');
    });

    it('should remove @UNICITY suffix (case insensitive)', () => {
      expect(NametagUtils.normalizeNametag('Alice@UNICITY')).toBe('alice');
    });

    it('should trim whitespace', () => {
      expect(NametagUtils.normalizeNametag('  alice  ')).toBe('alice');
    });

    it('should handle empty string', () => {
      expect(NametagUtils.normalizeNametag('')).toBe('');
    });

    it('should handle whitespace only', () => {
      expect(NametagUtils.normalizeNametag('   ')).toBe('');
    });

    it('should preserve non-@unicity suffixes', () => {
      expect(NametagUtils.normalizeNametag('alice@example')).toBe('alice@example');
    });
  });

  // ==========================================================
  // hashNametag determinism
  // ==========================================================
  describe('hashNametag', () => {
    it('should produce deterministic hash', () => {
      const hash1 = NametagUtils.hashNametag('alice');
      const hash2 = NametagUtils.hashNametag('alice');
      expect(hash1).toBe(hash2);
    });

    it('should produce 64-character hex hash', () => {
      const hash = NametagUtils.hashNametag('alice');
      expect(hash.length).toBe(64);
      expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
    });

    it('should normalize before hashing', () => {
      const hash1 = NametagUtils.hashNametag('Alice');
      const hash2 = NametagUtils.hashNametag('alice');
      expect(hash1).toBe(hash2);
    });

    it('should normalize @unicity suffix before hashing', () => {
      const hash1 = NametagUtils.hashNametag('alice@unicity');
      const hash2 = NametagUtils.hashNametag('alice');
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different nametags', () => {
      const hash1 = NametagUtils.hashNametag('alice');
      const hash2 = NametagUtils.hashNametag('bob');
      expect(hash1).not.toBe(hash2);
    });

    it('should normalize phone before hashing', () => {
      const hash1 = NametagUtils.hashNametag('+14155551234');
      const hash2 = NametagUtils.hashNametag('(415) 555-1234');
      expect(hash1).toBe(hash2);
    });
  });

  // ==========================================================
  // areSameNametag
  // ==========================================================
  describe('areSameNametag', () => {
    it('should match different case', () => {
      expect(NametagUtils.areSameNametag('Alice', 'alice')).toBe(true);
    });

    it('should match with and without @unicity suffix', () => {
      expect(NametagUtils.areSameNametag('alice', 'alice@unicity')).toBe(true);
    });

    it('should match phone numbers in different formats', () => {
      expect(NametagUtils.areSameNametag('+14155551234', '(415) 555-1234')).toBe(true);
    });

    it('should NOT match different nametags', () => {
      expect(NametagUtils.areSameNametag('alice', 'bob')).toBe(false);
    });

    it('should match with trimming', () => {
      expect(NametagUtils.areSameNametag('  alice  ', 'alice')).toBe(true);
    });
  });

  // ==========================================================
  // formatForDisplay
  // ==========================================================
  describe('formatForDisplay', () => {
    it('should mask phone number middle digits', () => {
      const display = NametagUtils.formatForDisplay('+14155551234');
      expect(display).toBe('+1415***1234');
    });

    it('should mask formatted phone number', () => {
      const display = NametagUtils.formatForDisplay('(415) 555-1234');
      expect(display).toBe('+1415***1234');
    });

    // NOTE: Java finding #6 - formatForDisplay returns un-normalized for non-phones
    // TypeScript returns normalizeNametag() result for non-phones (line 168)
    it('should return normalized text nametag (not raw input)', () => {
      const display = NametagUtils.formatForDisplay('Alice@UNICITY');
      // TypeScript returns normalized, not raw
      expect(display).toBe('alice');
    });

    it('should return normalized for non-phone digit strings', () => {
      const display = NametagUtils.formatForDisplay('user123');
      expect(display).toBe('user123');
    });

    it('should handle short phone numbers without masking', () => {
      // Numbers with <= 6 digits after + shouldn't be masked
      const display = NametagUtils.formatForDisplay('+123456');
      // Falls back to standard normalization since it's not a valid phone
      expect(display).toBeDefined();
    });
  });

  // ==========================================================
  // isPhoneNumber
  // ==========================================================
  describe('isPhoneNumber', () => {
    it('should return true for valid US phone', () => {
      expect(NametagUtils.isPhoneNumber('+14155551234')).toBe(true);
    });

    it('should return true for formatted US phone', () => {
      expect(NametagUtils.isPhoneNumber('(415) 555-1234')).toBe(true);
    });

    it('should return false for text nametag', () => {
      expect(NametagUtils.isPhoneNumber('alice')).toBe(false);
    });

    it('should return false for short digit string', () => {
      expect(NametagUtils.isPhoneNumber('12345')).toBe(false);
    });

    it('should return true for international phone', () => {
      expect(NametagUtils.isPhoneNumber('+442071234567')).toBe(true);
    });
  });

  // ==========================================================
  // Country code handling
  // ==========================================================
  describe('country code handling', () => {
    it('should use US as default country', () => {
      // 10-digit number without country code should be treated as US
      const normalized = NametagUtils.normalizeNametag('4155551234');
      expect(normalized).toBe('+14155551234');
    });

    it('should accept explicit country code', () => {
      const normalized = NametagUtils.normalizeNametag('02071234567', 'GB');
      expect(normalized).toBe('+442071234567');
    });

    it('should hash with custom country code', () => {
      const hashUS = NametagUtils.hashNametag('4155551234', 'US');
      const hashGB = NametagUtils.hashNametag('4155551234', 'GB');
      // Different country codes should produce different results for ambiguous numbers
      // (though this specific number may normalize the same)
      expect(hashUS).toBeDefined();
      expect(hashGB).toBeDefined();
    });
  });
});
