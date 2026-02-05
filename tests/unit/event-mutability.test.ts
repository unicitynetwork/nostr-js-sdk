/**
 * Unit tests for Event mutability and equality edge cases
 * Covers tags mutability issue found in Java SDK
 * Techniques: [EG] Error Guessing, [RB] Risk-Based Testing
 */

import { describe, it, expect } from 'vitest';
import { Event } from '../../src/protocol/Event.js';
import { NostrKeyManager } from '../../src/NostrKeyManager.js';
import * as EventKinds from '../../src/protocol/EventKinds.js';

describe('Event Mutability Edge Cases', () => {
  let keyManager: NostrKeyManager;

  beforeEach(() => {
    keyManager = NostrKeyManager.generate();
  });

  // ==========================================================
  // Tags mutability (Java finding #8)
  // ==========================================================
  describe('tags mutability', () => {
    it('tags array is directly exposed (known issue)', () => {
      const event = Event.create(keyManager, {
        kind: EventKinds.TEXT_NOTE,
        tags: [['p', 'pubkey1']],
        content: 'test',
      });

      // WARNING: This is a known issue - tags is mutable
      // Callers CAN modify internal state
      const originalTagCount = event.tags.length;
      event.tags.push(['e', 'eventid']);

      // Tags array is mutated
      expect(event.tags.length).toBe(originalTagCount + 1);

      // This breaks the event integrity - signature no longer matches
      expect(event.verify()).toBe(false);
    });

    it('modifying tags after creation invalidates signature', () => {
      const event = Event.create(keyManager, {
        kind: EventKinds.TEXT_NOTE,
        tags: [['t', 'topic']],
        content: 'test',
      });

      expect(event.verify()).toBe(true);

      // Mutate tags
      event.tags[0]![1] = 'modified';

      // Signature is now invalid
      expect(event.verify()).toBe(false);
    });

    it('clearing tags array invalidates signature', () => {
      const event = Event.create(keyManager, {
        kind: EventKinds.TEXT_NOTE,
        tags: [['p', 'pk1'], ['e', 'e1']],
        content: 'test',
      });

      expect(event.verify()).toBe(true);

      // Clear tags
      event.tags.length = 0;

      expect(event.verify()).toBe(false);
    });
  });

  // ==========================================================
  // Content mutability
  // ==========================================================
  describe('content mutability', () => {
    it('modifying content invalidates signature', () => {
      const event = Event.create(keyManager, {
        kind: EventKinds.TEXT_NOTE,
        tags: [],
        content: 'original',
      });

      expect(event.verify()).toBe(true);

      // Mutate content
      event.content = 'modified';

      expect(event.verify()).toBe(false);
    });
  });

  // ==========================================================
  // Event equality (Java finding #4 about null IDs)
  // ==========================================================
  describe('event comparison', () => {
    it('events with same ID are logically equal', () => {
      const event1 = Event.create(keyManager, {
        kind: EventKinds.TEXT_NOTE,
        tags: [],
        content: 'test',
        created_at: 1000,
      });

      // Parse same event from JSON
      const event2 = Event.fromJSON(event1.toJSON());

      expect(event1.id).toBe(event2.id);
    });

    it('events with different IDs are different', () => {
      const event1 = Event.create(keyManager, {
        kind: EventKinds.TEXT_NOTE,
        tags: [],
        content: 'test1',
      });

      const event2 = Event.create(keyManager, {
        kind: EventKinds.TEXT_NOTE,
        tags: [],
        content: 'test2',
      });

      expect(event1.id).not.toBe(event2.id);
    });

    // TypeScript doesn't have the Java null-ID equality issue
    // because Event constructor requires all fields including id
    it('Event.fromJSON requires id field', () => {
      expect(() => Event.fromJSON({
        pubkey: 'abc',
        created_at: 1000,
        kind: 1,
        tags: [],
        content: '',
        sig: 'abc',
        // id is missing
      })).toThrow('Invalid event data');
    });
  });

  // ==========================================================
  // JSON serialization consistency
  // ==========================================================
  describe('JSON serialization', () => {
    it('toJSON creates a new object (not a reference)', () => {
      const event = Event.create(keyManager, {
        kind: EventKinds.TEXT_NOTE,
        tags: [['p', 'pk1']],
        content: 'test',
      });

      const json1 = event.toJSON();
      const json2 = event.toJSON();

      // Different object references
      expect(json1).not.toBe(json2);

      // But equal values
      expect(json1).toEqual(json2);
    });

    it('toJSON tags IS the same reference as event.tags (known issue)', () => {
      const event = Event.create(keyManager, {
        kind: EventKinds.TEXT_NOTE,
        tags: [['p', 'pk1']],
        content: 'test',
      });

      const json = event.toJSON();

      // WARNING: This is a known issue - toJSON returns same reference
      // Modifying json.tags DOES affect event.tags
      json.tags.push(['e', 'eid']);

      // Both are affected because they're the same array
      expect(event.tags.length).toBe(2);
      expect(json.tags.length).toBe(2);

      // This breaks event integrity
      expect(event.verify()).toBe(false);
    });
  });

  // ==========================================================
  // Event ID calculation consistency
  // ==========================================================
  describe('Event ID calculation', () => {
    it('calculateId is deterministic', () => {
      const id1 = Event.calculateId('pubkey', 1000, 1, [['p', 'pk']], 'content');
      const id2 = Event.calculateId('pubkey', 1000, 1, [['p', 'pk']], 'content');
      expect(id1).toBe(id2);
    });

    it('calculateId produces 64-character hex string', () => {
      const id = Event.calculateId('pubkey', 1000, 1, [], 'content');
      expect(id.length).toBe(64);
      expect(/^[0-9a-f]+$/.test(id)).toBe(true);
    });

    it('different content produces different ID', () => {
      const id1 = Event.calculateId('pubkey', 1000, 1, [], 'content1');
      const id2 = Event.calculateId('pubkey', 1000, 1, [], 'content2');
      expect(id1).not.toBe(id2);
    });

    it('different kind produces different ID', () => {
      const id1 = Event.calculateId('pubkey', 1000, 1, [], 'content');
      const id2 = Event.calculateId('pubkey', 1000, 4, [], 'content');
      expect(id1).not.toBe(id2);
    });

    it('different tags produce different ID', () => {
      const id1 = Event.calculateId('pubkey', 1000, 1, [], 'content');
      const id2 = Event.calculateId('pubkey', 1000, 1, [['p', 'pk']], 'content');
      expect(id1).not.toBe(id2);
    });

    it('different pubkey produces different ID', () => {
      const id1 = Event.calculateId('pubkey1', 1000, 1, [], 'content');
      const id2 = Event.calculateId('pubkey2', 1000, 1, [], 'content');
      expect(id1).not.toBe(id2);
    });

    it('different timestamp produces different ID', () => {
      const id1 = Event.calculateId('pubkey', 1000, 1, [], 'content');
      const id2 = Event.calculateId('pubkey', 2000, 1, [], 'content');
      expect(id1).not.toBe(id2);
    });
  });

  // ==========================================================
  // isValidEventData
  // ==========================================================
  describe('isValidEventData', () => {
    it('should reject null', () => {
      expect(Event.isValidEventData(null)).toBe(false);
    });

    it('should reject undefined', () => {
      expect(Event.isValidEventData(undefined)).toBe(false);
    });

    it('should reject string', () => {
      expect(Event.isValidEventData('not an event')).toBe(false);
    });

    it('should reject number', () => {
      expect(Event.isValidEventData(123)).toBe(false);
    });

    it('should reject empty object', () => {
      expect(Event.isValidEventData({})).toBe(false);
    });

    it('should reject object missing id', () => {
      expect(Event.isValidEventData({
        pubkey: 'pk',
        created_at: 1000,
        kind: 1,
        tags: [],
        content: '',
        sig: 'sig',
      })).toBe(false);
    });

    it('should reject object with wrong id type', () => {
      expect(Event.isValidEventData({
        id: 123,
        pubkey: 'pk',
        created_at: 1000,
        kind: 1,
        tags: [],
        content: '',
        sig: 'sig',
      })).toBe(false);
    });

    it('should reject object with wrong tags type', () => {
      expect(Event.isValidEventData({
        id: 'id',
        pubkey: 'pk',
        created_at: 1000,
        kind: 1,
        tags: 'not an array',
        content: '',
        sig: 'sig',
      })).toBe(false);
    });

    it('should accept valid event data', () => {
      expect(Event.isValidEventData({
        id: 'id',
        pubkey: 'pk',
        created_at: 1000,
        kind: 1,
        tags: [],
        content: '',
        sig: 'sig',
      })).toBe(true);
    });
  });
});
