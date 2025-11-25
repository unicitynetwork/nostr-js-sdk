/**
 * Integration tests for NostrClient
 * These tests require a running Nostr relay (optional, skipped if unavailable)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NostrClient } from '../../src/client/NostrClient.js';
import { NostrKeyManager } from '../../src/NostrKeyManager.js';
import { Event } from '../../src/protocol/Event.js';
import { Filter } from '../../src/protocol/Filter.js';
import * as EventKinds from '../../src/protocol/EventKinds.js';

describe('NostrClient', () => {
  let client: NostrClient;
  let keyManager: NostrKeyManager;

  beforeEach(() => {
    keyManager = NostrKeyManager.generate();
    client = new NostrClient(keyManager);
  });

  afterEach(() => {
    client.disconnect();
  });

  describe('basic functionality', () => {
    it('should create client with key manager', () => {
      expect(client.getKeyManager()).toBe(keyManager);
    });

    it('should report not connected initially', () => {
      expect(client.isConnected()).toBe(false);
      expect(client.getConnectedRelays().size).toBe(0);
    });

    it('should create and publish events', () => {
      const event = Event.create(keyManager, {
        kind: EventKinds.TEXT_NOTE,
        tags: [],
        content: 'Hello, World!',
      });

      expect(event.verify()).toBe(true);
      expect(event.pubkey).toBe(keyManager.getPublicKeyHex());
    });

    it('should subscribe with auto-generated ID', () => {
      const filter = Filter.builder().kinds(1).build();
      const listener = {
        onEvent: vi.fn(),
      };

      const subId = client.subscribe(filter, listener);

      expect(subId).toMatch(/^sub_\d+$/);
    });

    it('should subscribe with custom ID', () => {
      const filter = Filter.builder().kinds(1).build();
      const listener = {
        onEvent: vi.fn(),
      };

      const subId = client.subscribe('my-custom-id', filter, listener);

      expect(subId).toBe('my-custom-id');
    });

    it('should unsubscribe', () => {
      const filter = Filter.builder().kinds(1).build();
      const listener = {
        onEvent: vi.fn(),
      };

      const subId = client.subscribe(filter, listener);
      client.unsubscribe(subId);

      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe('event creation', () => {
    it('should create text note event', async () => {
      const event = Event.create(keyManager, {
        kind: EventKinds.TEXT_NOTE,
        tags: [['t', 'test']],
        content: 'This is a test note',
      });

      expect(event.kind).toBe(1);
      expect(event.content).toBe('This is a test note');
      expect(event.hasTag('t')).toBe(true);
    });

    it('should create encrypted DM event', async () => {
      const recipient = NostrKeyManager.generate();

      const message = 'Secret message';
      const encrypted = await keyManager.encryptHex(message, recipient.getPublicKeyHex());

      const event = Event.create(keyManager, {
        kind: EventKinds.ENCRYPTED_DM,
        tags: [['p', recipient.getPublicKeyHex()]],
        content: encrypted,
      });

      expect(event.kind).toBe(4);
      expect(event.hasTag('p')).toBe(true);

      // Decrypt and verify
      const decrypted = await recipient.decryptHex(event.content, keyManager.getPublicKeyHex());
      expect(decrypted).toBe(message);
    });
  });

  describe('offline functionality', () => {
    it('should queue events when not connected', async () => {
      const event = Event.create(keyManager, {
        kind: EventKinds.TEXT_NOTE,
        tags: [],
        content: 'test',
      });

      // This should queue the event
      const publishPromise = client.publishEvent(event);

      // Should not throw immediately
      expect(publishPromise).toBeInstanceOf(Promise);

      // Clean up: the queued promise will be rejected when we disconnect
      // Catch it to prevent unhandled rejection
      publishPromise.catch(() => {
        // Expected rejection when disconnect is called
      });
    });
  });

  describe('disconnect', () => {
    it('should reject operations after disconnect', async () => {
      client.disconnect();

      await expect(
        client.publishEvent(Event.create(keyManager, {
          kind: 1,
          tags: [],
          content: 'test',
        }))
      ).rejects.toThrow(/disconnected/);
    });

    it('should handle multiple disconnect calls', () => {
      client.disconnect();
      client.disconnect();

      // Should not throw
      expect(true).toBe(true);
    });
  });
});

describe('NostrClient with real relay', () => {
  // These tests are skipped by default since they require a running relay
  // To run these tests, set NOSTR_TEST_RELAY environment variable
  const testRelay = process.env.NOSTR_TEST_RELAY;

  const describeWithRelay = testRelay ? describe : describe.skip;

  describeWithRelay('relay connection', () => {
    let client: NostrClient;
    let keyManager: NostrKeyManager;

    beforeEach(() => {
      keyManager = NostrKeyManager.generate();
      client = new NostrClient(keyManager);
    });

    afterEach(() => {
      client.disconnect();
    });

    it('should connect to relay', async () => {
      await client.connect(testRelay!);

      expect(client.isConnected()).toBe(true);
      expect(client.getConnectedRelays().has(testRelay!)).toBe(true);
    }, 30000);

    it('should publish and receive events', async () => {
      await client.connect(testRelay!);

      const receivedEvents: Event[] = [];
      const uniqueContent = `test-${Date.now()}-${Math.random()}`;

      // Subscribe first
      const filter = Filter.builder()
        .authors(keyManager.getPublicKeyHex())
        .kinds(EventKinds.TEXT_NOTE)
        .build();

      client.subscribe(filter, {
        onEvent: (event) => {
          receivedEvents.push(event);
        },
      });

      // Wait a bit for subscription to be established
      await new Promise(resolve => setTimeout(resolve, 500));

      // Publish event
      const event = Event.create(keyManager, {
        kind: EventKinds.TEXT_NOTE,
        tags: [],
        content: uniqueContent,
      });

      await client.publishEvent(event);

      // Wait for event to be received
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Check if we received our event
      const found = receivedEvents.find(e => e.content === uniqueContent);
      expect(found).toBeDefined();
    }, 30000);
  });
});
