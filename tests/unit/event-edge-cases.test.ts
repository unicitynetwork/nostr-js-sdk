/**
 * Unit tests for Event edge cases
 * Feature 16: Event Edge Cases
 * Techniques: [EG] Error Guessing, [BVA] Boundary Value Analysis
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Event } from '../../src/protocol/Event.js';
import { NostrKeyManager } from '../../src/NostrKeyManager.js';
import * as EventKinds from '../../src/protocol/EventKinds.js';

describe('Event Edge Cases', () => {
  let keyManager: NostrKeyManager;

  beforeEach(() => {
    keyManager = NostrKeyManager.generate();
  });

  // [EG] Empty tags array
  it('should create event with empty tags array', () => {
    const event = Event.create(keyManager, {
      kind: EventKinds.TEXT_NOTE,
      tags: [],
      content: 'test',
    });

    expect(event.tags).toEqual([]);
    expect(event.getTagValue('p')).toBeUndefined();
    expect(event.getTagValue('e')).toBeUndefined();
    expect(event.getTagValues('p')).toEqual([]);
    expect(event.hasTag('p')).toBe(false);
    expect(event.verify()).toBe(true);
  });

  // [EG] Event with many tags (1000+)
  it('should create and sign event with 1000 tags', () => {
    const tags: [string, string][] = [];
    for (let i = 0; i < 1000; i++) {
      tags.push(['p', `pubkey_${i.toString().padStart(4, '0')}`]);
    }

    const event = Event.create(keyManager, {
      kind: EventKinds.TEXT_NOTE,
      tags,
      content: 'event with many tags',
    });

    expect(event.tags).toHaveLength(1000);
    expect(event.id).toHaveLength(64);
    expect(event.verify()).toBe(true);
  });

  // [EG] Empty content string
  it('should create event with empty content', () => {
    const event = Event.create(keyManager, {
      kind: EventKinds.TEXT_NOTE,
      tags: [],
      content: '',
    });

    expect(event.content).toBe('');
    expect(event.verify()).toBe(true);
  });

  // [EG] Very long content
  it('should create event with very long content', () => {
    const content = 'A'.repeat(100000);
    const event = Event.create(keyManager, {
      kind: EventKinds.TEXT_NOTE,
      tags: [],
      content,
    });

    expect(event.content).toBe(content);
    expect(event.verify()).toBe(true);
  });

  // [EG] Unicode content
  it('should handle unicode content correctly', () => {
    const content = '\ud83d\ude00\ud83c\udf89 \u0425\u0435\u043b\u043b\u043e \u4e16\u754c \u0645\u0631\u062d\u0628\u0627';
    const event = Event.create(keyManager, {
      kind: EventKinds.TEXT_NOTE,
      tags: [],
      content,
    });

    expect(event.content).toBe(content);
    expect(event.verify()).toBe(true);
  });

  // [BVA] getTagEntryValues returns all entries for a tag name
  it('getTagEntryValues should return all entries for tag name', () => {
    const event = Event.create(keyManager, {
      kind: EventKinds.TEXT_NOTE,
      tags: [
        ['p', 'pk1', 'relay1'],
        ['p', 'pk2', 'relay2'],
        ['p', 'pk3'],
        ['e', 'evt1'],
      ],
      content: 'test',
    });

    // getTagEntryValues returns values from first matching tag (beyond tag name)
    const pValues = event.getTagEntryValues('p');
    expect(pValues).toEqual(['pk1', 'relay1']);
  });

  // [BVA] getTagValues returns all first-values for a tag name
  it('getTagValues should return values at index 1 for all matching tags', () => {
    const event = Event.create(keyManager, {
      kind: EventKinds.TEXT_NOTE,
      tags: [
        ['p', 'pk1', 'relay1'],
        ['p', 'pk2', 'relay2'],
        ['e', 'evt1'],
      ],
      content: 'test',
    });

    expect(event.getTagValues('p')).toEqual(['pk1', 'pk2']);
    expect(event.getTagValues('e')).toEqual(['evt1']);
  });

  // [BVA] hasTag returns false for non-existent tag
  it('hasTag should return false for non-existent tag', () => {
    const event = Event.create(keyManager, {
      kind: EventKinds.TEXT_NOTE,
      tags: [['p', 'pk1']],
      content: 'test',
    });

    expect(event.hasTag('p')).toBe(true);
    expect(event.hasTag('e')).toBe(false);
    expect(event.hasTag('t')).toBe(false);
    expect(event.hasTag('')).toBe(false);
  });

  // [EG] Tags with empty values
  it('should handle tags with empty string values', () => {
    const event = Event.create(keyManager, {
      kind: EventKinds.TEXT_NOTE,
      tags: [['d', '']],
      content: 'test',
    });

    expect(event.getTagValue('d')).toBe('');
    expect(event.hasTag('d')).toBe(true);
    expect(event.verify()).toBe(true);
  });

  // [EG] Deterministic ID calculation
  it('should produce same ID for same inputs', () => {
    const id1 = Event.calculateId('abc', 1000, 1, [['p', 'pk1']], 'content');
    const id2 = Event.calculateId('abc', 1000, 1, [['p', 'pk1']], 'content');
    expect(id1).toBe(id2);
  });

  // [EG] Different content produces different ID
  it('should produce different IDs for different content', () => {
    const id1 = Event.calculateId('abc', 1000, 1, [], 'content1');
    const id2 = Event.calculateId('abc', 1000, 1, [], 'content2');
    expect(id1).not.toBe(id2);
  });

  // [EG] Different kind produces different ID
  it('should produce different IDs for different kinds', () => {
    const id1 = Event.calculateId('abc', 1000, 1, [], 'content');
    const id2 = Event.calculateId('abc', 1000, 4, [], 'content');
    expect(id1).not.toBe(id2);
  });

  // [BVA] Event with kind 0 (metadata)
  it('should create event with kind 0', () => {
    const event = Event.create(keyManager, {
      kind: 0,
      tags: [],
      content: '{"name":"test"}',
    });

    expect(event.kind).toBe(0);
    expect(event.verify()).toBe(true);
  });

  // [EG] JSON roundtrip preserves all fields
  it('should preserve all fields through JSON roundtrip', () => {
    const original = Event.create(keyManager, {
      kind: EventKinds.TEXT_NOTE,
      tags: [['p', 'pk1', 'extra'], ['e', 'eid']],
      content: 'hello world',
      created_at: 1700000000,
    });

    const json = original.toJSON();
    const parsed = Event.fromJSON(json);

    expect(parsed.id).toBe(original.id);
    expect(parsed.pubkey).toBe(original.pubkey);
    expect(parsed.created_at).toBe(original.created_at);
    expect(parsed.kind).toBe(original.kind);
    expect(parsed.tags).toEqual(original.tags);
    expect(parsed.content).toBe(original.content);
    expect(parsed.sig).toBe(original.sig);
  });

  // [EG] JSON string parsing
  it('should parse from JSON string', () => {
    const original = Event.create(keyManager, {
      kind: 1,
      tags: [],
      content: 'test',
    });

    const jsonString = JSON.stringify(original.toJSON());
    const parsed = Event.fromJSON(jsonString);

    expect(parsed.id).toBe(original.id);
    expect(parsed.verify()).toBe(true);
  });
});
