/**
 * Unit tests for NIP-42 Client Authentication
 */

import { describe, it, expect } from 'vitest';
import { NostrKeyManager } from '../../src/NostrKeyManager.js';
import { Event } from '../../src/protocol/Event.js';
import * as EventKinds from '../../src/protocol/EventKinds.js';

describe('NIP-42 Authentication', () => {
  describe('AUTH event kind', () => {
    it('should have correct AUTH kind value (22242)', () => {
      expect(EventKinds.AUTH).toBe(22242);
    });

    it('should be in ephemeral range (20000-29999)', () => {
      expect(EventKinds.isEphemeral(EventKinds.AUTH)).toBe(true);
    });
  });

  describe('AUTH event creation', () => {
    it('should create valid AUTH event with relay and challenge tags', () => {
      const keyManager = NostrKeyManager.generate();
      const relayUrl = 'wss://relay.example.com';
      const challenge = 'test-challenge-12345';

      const authEvent = Event.create(keyManager, {
        kind: EventKinds.AUTH,
        tags: [
          ['relay', relayUrl],
          ['challenge', challenge],
        ],
        content: '',
      });

      expect(authEvent.kind).toBe(22242);
      expect(authEvent.content).toBe('');
      expect(authEvent.hasTag('relay')).toBe(true);
      expect(authEvent.hasTag('challenge')).toBe(true);
      expect(authEvent.getTagValue('relay')).toBe(relayUrl);
      expect(authEvent.getTagValue('challenge')).toBe(challenge);
    });

    it('should have valid signature', () => {
      const keyManager = NostrKeyManager.generate();

      const authEvent = Event.create(keyManager, {
        kind: EventKinds.AUTH,
        tags: [
          ['relay', 'wss://test.relay'],
          ['challenge', 'abc123'],
        ],
        content: '',
      });

      expect(authEvent.verify()).toBe(true);
    });

    it('should use correct pubkey from key manager', () => {
      const keyManager = NostrKeyManager.generate();

      const authEvent = Event.create(keyManager, {
        kind: EventKinds.AUTH,
        tags: [
          ['relay', 'wss://test.relay'],
          ['challenge', 'abc123'],
        ],
        content: '',
      });

      expect(authEvent.pubkey).toBe(keyManager.getPublicKeyHex());
    });
  });

  describe('AUTH event serialization', () => {
    it('should serialize to JSON correctly', () => {
      const keyManager = NostrKeyManager.generate();
      const relayUrl = 'wss://relay.example.com';
      const challenge = 'challenge123';

      const authEvent = Event.create(keyManager, {
        kind: EventKinds.AUTH,
        tags: [
          ['relay', relayUrl],
          ['challenge', challenge],
        ],
        content: '',
      });

      const json = authEvent.toJSON();

      expect(json.kind).toBe(22242);
      expect(json.content).toBe('');
      expect(json.tags).toContainEqual(['relay', relayUrl]);
      expect(json.tags).toContainEqual(['challenge', challenge]);
      expect(json.pubkey).toBe(keyManager.getPublicKeyHex());
      expect(json.id).toBeDefined();
      expect(json.sig).toBeDefined();
    });

    it('should produce AUTH message array for relay', () => {
      const keyManager = NostrKeyManager.generate();

      const authEvent = Event.create(keyManager, {
        kind: EventKinds.AUTH,
        tags: [
          ['relay', 'wss://test.relay'],
          ['challenge', 'abc'],
        ],
        content: '',
      });

      // AUTH message format: ["AUTH", <signed event>]
      const authMessage = ['AUTH', authEvent.toJSON()];

      expect(authMessage[0]).toBe('AUTH');
      expect(authMessage[1]).toMatchObject({
        kind: 22242,
        content: '',
      });
    });
  });
});
