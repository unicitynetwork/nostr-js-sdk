/**
 * NIP-17 E2E tests with real Nostr relay.
 *
 * Uses polling approach since some relays don't route live events between connections.
 *
 * Run with:
 *   npm test tests/integration/nip17-relay.test.ts
 *
 * Or with custom relay:
 *   NOSTR_TEST_RELAY=wss://your-relay.com npm test tests/integration/nip17-relay.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NostrClient } from '../../src/client/NostrClient.js';
import { NostrKeyManager } from '../../src/NostrKeyManager.js';
import { Filter } from '../../src/protocol/Filter.js';
import { Event } from '../../src/protocol/Event.js';
import type { PrivateMessage } from '../../src/messaging/types.js';

const NOSTR_RELAY = process.env.NOSTR_TEST_RELAY || 'wss://nostr-relay.testnet.unicity.network';
const TIMEOUT_MS = 60000;
const POLL_INTERVAL_MS = 500;
const MAX_POLL_ATTEMPTS = 20;

describe('NIP-17 E2E with Relay', () => {
  let aliceClient: NostrClient;
  let bobClient: NostrClient;
  let aliceKeys: NostrKeyManager;
  let bobKeys: NostrKeyManager;

  beforeAll(async () => {
    console.log('================================================================');
    console.log('  NIP-17 Private Message E2E Tests');
    console.log('================================================================');
    console.log();
    console.log(`Relay: ${NOSTR_RELAY}`);
    console.log();

    // Generate key pairs
    aliceKeys = NostrKeyManager.generate();
    bobKeys = NostrKeyManager.generate();

    console.log(`Alice pubkey: ${aliceKeys.getPublicKeyHex().substring(0, 16)}...`);
    console.log(`Bob pubkey:   ${bobKeys.getPublicKeyHex().substring(0, 16)}...`);

    // Create clients
    aliceClient = new NostrClient(aliceKeys);
    bobClient = new NostrClient(bobKeys);

    // Connect both
    console.log();
    console.log('Connecting clients to relay...');
    await Promise.all([
      aliceClient.connect(NOSTR_RELAY),
      bobClient.connect(NOSTR_RELAY),
    ]);
    console.log('Both clients connected');
  }, TIMEOUT_MS);

  afterAll(() => {
    aliceClient?.disconnect();
    bobClient?.disconnect();
    console.log('Clients disconnected');
  });

  /**
   * Poll for a gift-wrapped event by ID and unwrap it.
   */
  async function pollForGiftWrap(
    client: NostrClient,
    eventId: string
  ): Promise<PrivateMessage | null> {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await sleep(POLL_INTERVAL_MS);
      }

      const result = await new Promise<PrivateMessage | null>((resolve) => {
        let found = false;
        const subId = `poll-${attempt}`;
        const filter = Filter.builder().ids(eventId).build();

        const timeout = setTimeout(() => {
          client.unsubscribe(subId);
          resolve(null);
        }, 2000);

        client.subscribe(subId, filter, {
          onEvent: (event: Event) => {
            if (event.id === eventId && !found) {
              found = true;
              clearTimeout(timeout);
              try {
                const msg = client.unwrapPrivateMessage(event);
                client.unsubscribe(subId);
                resolve(msg);
              } catch (e) {
                console.log(`  Failed to unwrap: ${e}`);
                client.unsubscribe(subId);
                resolve(null);
              }
            }
          },
          onEndOfStoredEvents: () => {
            if (!found) {
              clearTimeout(timeout);
              client.unsubscribe(subId);
              resolve(null);
            }
          },
        });
      });

      if (result) {
        console.log(`  Found event: ${eventId.substring(0, 16)}...`);
        return result;
      }
      console.log(`  Attempt ${attempt + 1}: event not found yet...`);
    }

    return null;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it(
    'should complete private message round trip',
    async () => {
      console.log();
      console.log('------------------------------------------------------------');
      console.log('TEST: Private Message Round Trip');
      console.log('------------------------------------------------------------');

      // Step 1: Alice sends private message to Bob
      console.log();
      console.log('STEP 1: Alice sends private message to Bob');
      const testMessage = `Hello Bob! This is a secret NIP-17 message. ${Date.now()}`;
      const messageEventId = await aliceClient.sendPrivateMessage(
        bobKeys.getPublicKeyHex(),
        testMessage
      );
      console.log(`Message sent with gift wrap ID: ${messageEventId.substring(0, 16)}...`);

      // Step 2: Bob polls for the message
      console.log();
      console.log('STEP 2: Bob polls for the message');
      const bobsMessage = await pollForGiftWrap(bobClient, messageEventId);

      expect(bobsMessage).not.toBeNull();
      expect(bobsMessage!.content).toBe(testMessage);
      expect(bobsMessage!.senderPubkey).toBe(aliceKeys.getPublicKeyHex());
      console.log('Bob received and verified the message!');
      console.log(`  Content: "${bobsMessage!.content}"`);

      // Step 3: Bob sends read receipt
      console.log();
      console.log('STEP 3: Bob sends read receipt to Alice');
      const receiptEventId = await bobClient.sendReadReceipt(
        aliceKeys.getPublicKeyHex(),
        bobsMessage!.eventId
      );
      console.log(`Read receipt sent with gift wrap ID: ${receiptEventId.substring(0, 16)}...`);

      // Step 4: Alice polls for the read receipt
      console.log();
      console.log('STEP 4: Alice polls for read receipt');
      const alicesReceipt = await pollForGiftWrap(aliceClient, receiptEventId);

      expect(alicesReceipt).not.toBeNull();
      expect(alicesReceipt!.kind).toBe(15); // READ_RECEIPT
      expect(alicesReceipt!.senderPubkey).toBe(bobKeys.getPublicKeyHex());
      expect(alicesReceipt!.replyToEventId).toBe(bobsMessage!.eventId);
      console.log('Alice received and verified the read receipt!');

      console.log();
      console.log('================================================================');
      console.log('  SUCCESS: NIP-17 round trip test passed!');
      console.log('================================================================');
    },
    TIMEOUT_MS
  );

  it(
    'should use ephemeral keys for gift wrap',
    async () => {
      console.log();
      console.log('------------------------------------------------------------');
      console.log('TEST: Ephemeral Keys for Gift Wrap');
      console.log('------------------------------------------------------------');

      // Create two gift wraps and verify they use different ephemeral keys
      console.log();
      console.log('Creating two gift-wrapped messages...');

      // We need to access the raw events to check pubkey
      // Import NIP17 directly for this test
      const NIP17 = await import('../../src/messaging/nip17.js');

      const giftWrap1 = NIP17.createGiftWrap(aliceKeys, bobKeys.getPublicKeyHex(), 'Message 1');
      const giftWrap2 = NIP17.createGiftWrap(aliceKeys, bobKeys.getPublicKeyHex(), 'Message 2');

      // Gift wraps should have different pubkeys (ephemeral)
      expect(giftWrap1.pubkey).not.toBe(giftWrap2.pubkey);
      console.log(`Gift wrap 1 pubkey: ${giftWrap1.pubkey.substring(0, 16)}...`);
      console.log(`Gift wrap 2 pubkey: ${giftWrap2.pubkey.substring(0, 16)}...`);

      // Neither should be Alice's pubkey
      expect(giftWrap1.pubkey).not.toBe(aliceKeys.getPublicKeyHex());
      expect(giftWrap2.pubkey).not.toBe(aliceKeys.getPublicKeyHex());
      console.log(`Alice's pubkey:     ${aliceKeys.getPublicKeyHex().substring(0, 16)}...`);
      console.log('Sender identity is hidden (ephemeral keys used)');

      // Both should unwrap correctly and identify Alice as sender
      const msg1 = NIP17.unwrap(giftWrap1, bobKeys);
      const msg2 = NIP17.unwrap(giftWrap2, bobKeys);

      expect(msg1.content).toBe('Message 1');
      expect(msg2.content).toBe('Message 2');
      expect(msg1.senderPubkey).toBe(aliceKeys.getPublicKeyHex());
      expect(msg2.senderPubkey).toBe(aliceKeys.getPublicKeyHex());
      console.log('Both messages correctly identify Alice as sender after unwrapping');

      console.log();
      console.log('================================================================');
      console.log('  SUCCESS: Ephemeral key test passed!');
      console.log('================================================================');
    },
    TIMEOUT_MS
  );

  it(
    'should fail to decrypt with wrong recipient',
    async () => {
      console.log();
      console.log('------------------------------------------------------------');
      console.log('TEST: Message Privacy (Wrong Recipient)');
      console.log('------------------------------------------------------------');

      const eveKeys = NostrKeyManager.generate();
      console.log(`Eve pubkey:   ${eveKeys.getPublicKeyHex().substring(0, 16)}...`);

      // Create a gift wrap for Bob
      const NIP17 = await import('../../src/messaging/nip17.js');
      const giftWrap = NIP17.createGiftWrap(
        aliceKeys,
        bobKeys.getPublicKeyHex(),
        'Secret message for Bob only'
      );

      // Eve should not be able to unwrap
      console.log('Eve attempts to unwrap message meant for Bob...');
      expect(() => NIP17.unwrap(giftWrap, eveKeys)).toThrow();
      console.log('Eve failed to decrypt (as expected)');

      // Bob should be able to unwrap
      console.log('Bob unwraps the message...');
      const bobMsg = NIP17.unwrap(giftWrap, bobKeys);
      expect(bobMsg.content).toBe('Secret message for Bob only');
      console.log('Bob successfully decrypted the message');

      console.log();
      console.log('================================================================');
      console.log('  SUCCESS: Privacy test passed!');
      console.log('================================================================');
    },
    TIMEOUT_MS
  );
});
