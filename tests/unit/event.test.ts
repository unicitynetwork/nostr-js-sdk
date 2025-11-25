/**
 * Unit tests for Event class
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Event } from '../../src/protocol/Event.js';
import { NostrKeyManager } from '../../src/NostrKeyManager.js';
import * as EventKinds from '../../src/protocol/EventKinds.js';

describe('Event', () => {
  let keyManager: NostrKeyManager;

  beforeEach(() => {
    keyManager = NostrKeyManager.generate();
  });

  describe('create', () => {
    it('should create a valid event', () => {
      const event = Event.create(keyManager, {
        kind: EventKinds.TEXT_NOTE,
        tags: [],
        content: 'Hello, Nostr!',
      });

      expect(event.id).toBeDefined();
      expect(event.id.length).toBe(64);
      expect(event.pubkey).toBe(keyManager.getPublicKeyHex());
      expect(event.kind).toBe(EventKinds.TEXT_NOTE);
      expect(event.content).toBe('Hello, Nostr!');
      expect(event.sig.length).toBe(128);
    });

    it('should create event with tags', () => {
      const event = Event.create(keyManager, {
        kind: EventKinds.ENCRYPTED_DM,
        tags: [
          ['p', 'recipient_pubkey_hex'],
          ['e', 'referenced_event_id'],
        ],
        content: 'encrypted content',
      });

      expect(event.tags).toHaveLength(2);
      expect(event.tags[0]).toEqual(['p', 'recipient_pubkey_hex']);
      expect(event.tags[1]).toEqual(['e', 'referenced_event_id']);
    });

    it('should use provided created_at', () => {
      const customTimestamp = 1700000000;

      const event = Event.create(keyManager, {
        kind: EventKinds.TEXT_NOTE,
        tags: [],
        content: 'test',
        created_at: customTimestamp,
      });

      expect(event.created_at).toBe(customTimestamp);
    });

    it('should use current time if created_at not provided', () => {
      const before = Math.floor(Date.now() / 1000);

      const event = Event.create(keyManager, {
        kind: EventKinds.TEXT_NOTE,
        tags: [],
        content: 'test',
      });

      const after = Math.floor(Date.now() / 1000);

      expect(event.created_at).toBeGreaterThanOrEqual(before);
      expect(event.created_at).toBeLessThanOrEqual(after);
    });
  });

  describe('calculateId', () => {
    it('should calculate deterministic ID', () => {
      const id1 = Event.calculateId('pubkey', 1234567890, 1, [], 'content');
      const id2 = Event.calculateId('pubkey', 1234567890, 1, [], 'content');

      expect(id1).toBe(id2);
    });

    it('should produce different IDs for different inputs', () => {
      const id1 = Event.calculateId('pubkey1', 1234567890, 1, [], 'content');
      const id2 = Event.calculateId('pubkey2', 1234567890, 1, [], 'content');

      expect(id1).not.toBe(id2);
    });
  });

  describe('verify', () => {
    it('should verify valid event', () => {
      const event = Event.create(keyManager, {
        kind: EventKinds.TEXT_NOTE,
        tags: [],
        content: 'test',
      });

      expect(event.verify()).toBe(true);
    });

    it('should reject event with tampered content', () => {
      const event = Event.create(keyManager, {
        kind: EventKinds.TEXT_NOTE,
        tags: [],
        content: 'original',
      });

      event.content = 'tampered';

      expect(event.verify()).toBe(false);
    });

    it('should reject event with tampered id', () => {
      const event = Event.create(keyManager, {
        kind: EventKinds.TEXT_NOTE,
        tags: [],
        content: 'test',
      });

      event.id = '00'.repeat(32);

      expect(event.verify()).toBe(false);
    });

    it('should reject event with tampered signature', () => {
      const event = Event.create(keyManager, {
        kind: EventKinds.TEXT_NOTE,
        tags: [],
        content: 'test',
      });

      // Change first byte of signature
      const sigBytes = event.sig.match(/.{2}/g)!;
      sigBytes[0] = ((parseInt(sigBytes[0]!, 16) + 1) % 256).toString(16).padStart(2, '0');
      event.sig = sigBytes.join('');

      expect(event.verify()).toBe(false);
    });
  });

  describe('fromJSON', () => {
    it('should parse JSON object', () => {
      const original = Event.create(keyManager, {
        kind: EventKinds.TEXT_NOTE,
        tags: [['t', 'test']],
        content: 'hello',
      });

      const json = original.toJSON();
      const parsed = Event.fromJSON(json);

      expect(parsed.id).toBe(original.id);
      expect(parsed.pubkey).toBe(original.pubkey);
      expect(parsed.kind).toBe(original.kind);
      expect(parsed.content).toBe(original.content);
      expect(parsed.tags).toEqual(original.tags);
    });

    it('should parse JSON string', () => {
      const original = Event.create(keyManager, {
        kind: EventKinds.TEXT_NOTE,
        tags: [],
        content: 'test',
      });

      const jsonString = JSON.stringify(original.toJSON());
      const parsed = Event.fromJSON(jsonString);

      expect(parsed.id).toBe(original.id);
    });

    it('should reject invalid data', () => {
      expect(() => Event.fromJSON({})).toThrow(/Invalid event data/);
      expect(() => Event.fromJSON({ id: 'test' })).toThrow(/Invalid event data/);
      expect(() => Event.fromJSON(null)).toThrow(/Invalid event data/);
    });
  });

  describe('tag helpers', () => {
    let event: Event;

    beforeEach(() => {
      event = Event.create(keyManager, {
        kind: EventKinds.TEXT_NOTE,
        tags: [
          ['p', 'pubkey1', 'relay1'],
          ['p', 'pubkey2'],
          ['e', 'event1'],
          ['t', 'test'],
        ],
        content: 'test',
      });
    });

    it('getTagValue should return first tag value', () => {
      expect(event.getTagValue('p')).toBe('pubkey1');
      expect(event.getTagValue('e')).toBe('event1');
      expect(event.getTagValue('nonexistent')).toBeUndefined();
    });

    it('getTagValues should return all tag values', () => {
      const pValues = event.getTagValues('p');
      expect(pValues).toEqual(['pubkey1', 'pubkey2']);

      const tValues = event.getTagValues('t');
      expect(tValues).toEqual(['test']);

      const missing = event.getTagValues('missing');
      expect(missing).toEqual([]);
    });

    it('hasTag should check tag existence', () => {
      expect(event.hasTag('p')).toBe(true);
      expect(event.hasTag('e')).toBe(true);
      expect(event.hasTag('t')).toBe(true);
      expect(event.hasTag('missing')).toBe(false);
    });

    it('getTagEntryValues should return all values from first matching tag', () => {
      const values = event.getTagEntryValues('p');
      expect(values).toEqual(['pubkey1', 'relay1']);

      const missing = event.getTagEntryValues('missing');
      expect(missing).toEqual([]);
    });
  });

  describe('isValidEventData', () => {
    it('should validate complete event data', () => {
      const valid = {
        id: 'a'.repeat(64),
        pubkey: 'b'.repeat(64),
        created_at: 1234567890,
        kind: 1,
        tags: [],
        content: 'test',
        sig: 'c'.repeat(128),
      };

      expect(Event.isValidEventData(valid)).toBe(true);
    });

    it('should reject incomplete data', () => {
      expect(Event.isValidEventData({})).toBe(false);
      expect(Event.isValidEventData({ id: 'test' })).toBe(false);
      expect(Event.isValidEventData(null)).toBe(false);
      expect(Event.isValidEventData(undefined)).toBe(false);
      expect(Event.isValidEventData('string')).toBe(false);
    });
  });
});
