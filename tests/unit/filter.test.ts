/**
 * Unit tests for Filter class
 */

import { describe, it, expect } from 'vitest';
import { Filter, FilterBuilder } from '../../src/protocol/Filter.js';

describe('Filter', () => {
  describe('constructor', () => {
    it('should create empty filter', () => {
      const filter = new Filter();
      expect(filter.toJSON()).toEqual({});
    });

    it('should create filter from data', () => {
      const filter = new Filter({
        ids: ['id1', 'id2'],
        kinds: [1, 4],
        limit: 10,
      });

      expect(filter.ids).toEqual(['id1', 'id2']);
      expect(filter.kinds).toEqual([1, 4]);
      expect(filter.limit).toBe(10);
    });

    it('should copy arrays to prevent mutation', () => {
      const ids = ['id1', 'id2'];
      const filter = new Filter({ ids });

      ids.push('id3');

      expect(filter.ids).toEqual(['id1', 'id2']);
    });
  });

  describe('builder', () => {
    it('should build filter with ids', () => {
      const filter = Filter.builder()
        .ids('id1', 'id2')
        .build();

      expect(filter.ids).toEqual(['id1', 'id2']);
    });

    it('should build filter with ids array', () => {
      const filter = Filter.builder()
        .ids(['id1', 'id2'])
        .build();

      expect(filter.ids).toEqual(['id1', 'id2']);
    });

    it('should build filter with authors', () => {
      const filter = Filter.builder()
        .authors('author1', 'author2')
        .build();

      expect(filter.authors).toEqual(['author1', 'author2']);
    });

    it('should build filter with kinds', () => {
      const filter = Filter.builder()
        .kinds(1, 4, 7)
        .build();

      expect(filter.kinds).toEqual([1, 4, 7]);
    });

    it('should build filter with tag filters', () => {
      const filter = Filter.builder()
        .eTags('event1', 'event2')
        .pTags('pubkey1')
        .tTags('topic1', 'topic2')
        .dTags('identifier')
        .build();

      expect(filter['#e']).toEqual(['event1', 'event2']);
      expect(filter['#p']).toEqual(['pubkey1']);
      expect(filter['#t']).toEqual(['topic1', 'topic2']);
      expect(filter['#d']).toEqual(['identifier']);
    });

    it('should build filter with time range', () => {
      const filter = Filter.builder()
        .since(1000)
        .until(2000)
        .build();

      expect(filter.since).toBe(1000);
      expect(filter.until).toBe(2000);
    });

    it('should build filter with limit', () => {
      const filter = Filter.builder()
        .limit(100)
        .build();

      expect(filter.limit).toBe(100);
    });

    it('should chain all methods', () => {
      const filter = Filter.builder()
        .ids('id1')
        .authors('author1')
        .kinds(1)
        .eTags('event1')
        .pTags('pubkey1')
        .tTags('topic1')
        .dTags('d1')
        .since(1000)
        .until(2000)
        .limit(50)
        .build();

      expect(filter.ids).toEqual(['id1']);
      expect(filter.authors).toEqual(['author1']);
      expect(filter.kinds).toEqual([1]);
      expect(filter['#e']).toEqual(['event1']);
      expect(filter['#p']).toEqual(['pubkey1']);
      expect(filter['#t']).toEqual(['topic1']);
      expect(filter['#d']).toEqual(['d1']);
      expect(filter.since).toBe(1000);
      expect(filter.until).toBe(2000);
      expect(filter.limit).toBe(50);
    });
  });

  describe('toJSON', () => {
    it('should only include defined properties', () => {
      const filter = Filter.builder()
        .kinds(1)
        .limit(10)
        .build();

      const json = filter.toJSON();

      expect(json).toEqual({
        kinds: [1],
        limit: 10,
      });

      expect('ids' in json).toBe(false);
      expect('authors' in json).toBe(false);
    });

    it('should exclude empty arrays', () => {
      const filter = new Filter({
        ids: [],
        kinds: [1],
      });

      const json = filter.toJSON();

      expect('ids' in json).toBe(false);
      expect(json.kinds).toEqual([1]);
    });
  });

  describe('fromJSON', () => {
    it('should parse JSON object', () => {
      const filter = Filter.fromJSON({
        kinds: [1, 4],
        limit: 10,
      });

      expect(filter.kinds).toEqual([1, 4]);
      expect(filter.limit).toBe(10);
    });

    it('should parse JSON string', () => {
      const jsonString = JSON.stringify({
        authors: ['author1'],
        '#p': ['pubkey1'],
      });

      const filter = Filter.fromJSON(jsonString);

      expect(filter.authors).toEqual(['author1']);
      expect(filter['#p']).toEqual(['pubkey1']);
    });

    it('should handle all tag types', () => {
      const filter = Filter.fromJSON({
        '#e': ['e1'],
        '#p': ['p1'],
        '#t': ['t1'],
        '#d': ['d1'],
      });

      expect(filter['#e']).toEqual(['e1']);
      expect(filter['#p']).toEqual(['p1']);
      expect(filter['#t']).toEqual(['t1']);
      expect(filter['#d']).toEqual(['d1']);
    });
  });

  describe('real-world filters', () => {
    it('should create filter for user notes', () => {
      const filter = Filter.builder()
        .authors('user_pubkey')
        .kinds(1)
        .limit(20)
        .build();

      expect(filter.toJSON()).toEqual({
        authors: ['user_pubkey'],
        kinds: [1],
        limit: 20,
      });
    });

    it('should create filter for direct messages', () => {
      const myPubkey = 'my_pubkey';

      const filter = Filter.builder()
        .kinds(4)
        .pTags(myPubkey)
        .since(Math.floor(Date.now() / 1000) - 86400)
        .build();

      expect(filter.kinds).toEqual([4]);
      expect(filter['#p']).toEqual([myPubkey]);
      expect(filter.since).toBeDefined();
    });

    it('should create filter for nametag lookup', () => {
      const hashedNametag = 'hashed_nametag_value';

      const filter = Filter.builder()
        .kinds(30078)
        .tTags(hashedNametag)
        .build();

      expect(filter.kinds).toEqual([30078]);
      expect(filter['#t']).toEqual([hashedNametag]);
    });
  });
});
