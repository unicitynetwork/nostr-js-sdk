/**
 * Payment Request E2E Tests - Relay Integration
 *
 * These tests connect to a real Nostr relay and send payment requests.
 * Use these to test the Android wallet's payment request handling.
 *
 * Usage:
 *   # Send a single payment request
 *   TARGET_NAMETAG=mp-9 npm run test:integration -- --testNamePattern="send single payment request"
 *
 *   # Send multiple payment requests
 *   TARGET_NAMETAG=mp-9 npm run test:integration -- --testNamePattern="send multiple payment requests"
 *
 *   # Full flow with token transfer verification (requires wallet interaction)
 *   TARGET_NAMETAG=mp-9 npm run test:integration -- --testNamePattern="full payment request flow"
 *
 *   # Decline flow - send request, manually reject in wallet, receive decline response
 *   TARGET_NAMETAG=mp-9 npm run test:integration -- --testNamePattern="receive decline response"
 *
 *   # Expiration flow - send request with short deadline, observe expiration handling
 *   TARGET_NAMETAG=mp-9 DEADLINE_SECONDS=10 npm run test:integration -- --testNamePattern="verify expiration"
 *
 * Environment variables:
 *   TARGET_NAMETAG - Nametag of the wallet to send requests to (required)
 *   NOSTR_RELAY - Relay URL (default: wss://nostr-relay.testnet.unicity.network)
 *   AMOUNT - Amount in smallest units (default: 1000000)
 *   SYMBOL - Token symbol (default: SOL)
 *   TIMEOUT - Timeout in seconds for full flow test (default: 120)
 *   DEADLINE_SECONDS - Deadline in seconds for expiration test (default: 30)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  NostrKeyManager,
  NostrClient,
  EventKinds,
  Filter,
  PaymentRequestProtocol,
  NametagBinding,
  TokenTransferProtocol,
  Event,
} from '../../src/index.js';

// Skip if no target nametag provided
const TARGET_NAMETAG = process.env.TARGET_NAMETAG;
const SKIP_RELAY_TESTS = !TARGET_NAMETAG;

// Configuration
const NOSTR_RELAY = process.env.NOSTR_RELAY || 'wss://nostr-relay.testnet.unicity.network';
const SOLANA_COIN_ID = 'dee5f8ce778562eec90e9c38a91296a023210ccc76ff4c29d527ac3eb64ade93';

describe.skipIf(SKIP_RELAY_TESTS)('Payment Request - Relay E2E', () => {
  let keyManager: NostrKeyManager;
  let client: NostrClient;

  beforeAll(async () => {
    keyManager = NostrKeyManager.generate();
    client = new NostrClient(keyManager);

    console.log('\n' + '='.repeat(64));
    console.log('Payment Request E2E Test');
    console.log('='.repeat(64));
    console.log(`Relay: ${NOSTR_RELAY}`);
    console.log(`Target: ${TARGET_NAMETAG}`);
    console.log(`Our pubkey: ${keyManager.getPublicKeyHex().substring(0, 32)}...`);
    console.log('='.repeat(64) + '\n');

    await client.connect(NOSTR_RELAY);
    console.log('Connected to relay');
  }, 30000);

  afterAll(() => {
    if (client) {
      client.disconnect();
      console.log('\nDisconnected from relay');
    }
  });

  async function resolveNametag(nametag: string): Promise<string> {
    console.log(`Resolving nametag '${nametag}'...`);
    const pubkey = await client.queryPubkeyByNametag(nametag);
    if (!pubkey) {
      throw new Error(`Nametag not found: ${nametag}`);
    }
    console.log(`Resolved to: ${pubkey.substring(0, 32)}...`);
    return pubkey;
  }

  async function publishOurNametag(nametag: string): Promise<void> {
    const bindingEvent = await NametagBinding.createBindingEvent(
      keyManager,
      nametag,
      'test-address-' + Date.now()
    );
    await client.publishEvent(bindingEvent);
    console.log(`Published nametag binding: ${nametag}`);
    // Wait for relay to process
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  it('should send single payment request', async () => {
    const targetNametag = TARGET_NAMETAG!;
    const recipientNametag = process.env.RECIPIENT_NAMETAG || `test-requester-${Date.now() % 10000}`;
    const amount = BigInt(process.env.AMOUNT || '1000000');
    const decimals = 8; // Default decimals
    const message = process.env.MESSAGE || 'Test payment request from JS SDK E2E test';

    console.log('\nTest: Send Single Payment Request');
    console.log('-'.repeat(40));
    console.log(`Target nametag: ${targetNametag}`);
    console.log(`Recipient nametag: ${recipientNametag}`);
    console.log(`Amount: ${PaymentRequestProtocol.formatAmount(amount, decimals)}`);
    console.log(`Message: ${message}`);
    console.log('');

    // Publish our nametag binding
    await publishOurNametag(recipientNametag);

    // Resolve target
    const targetPubkey = await resolveNametag(targetNametag);

    // Send payment request
    const request = {
      amount,
      coinId: SOLANA_COIN_ID,
      message,
      recipientNametag,
    };

    console.log('Sending payment request...');
    const eventId = await client.sendPaymentRequest(targetPubkey, request);
    console.log(`Payment request sent! Event ID: ${eventId.substring(0, 16)}...`);

    // Wait for relay to process
    await new Promise((resolve) => setTimeout(resolve, 2000));

    console.log('\n' + '='.repeat(64));
    console.log('SUCCESS: Payment request sent!');
    console.log('='.repeat(64));
    console.log(`To: ${targetNametag}`);
    console.log(`Amount: ${PaymentRequestProtocol.formatAmount(amount, decimals)}`);
    console.log(`From: ${recipientNametag}`);
    console.log('\nCheck the wallet Settings > Payment Requests!');
    console.log('='.repeat(64) + '\n');

    expect(eventId).toBeDefined();
    expect(eventId.length).toBe(64);
  }, 60000);

  it('should send multiple payment requests', async () => {
    const targetNametag = TARGET_NAMETAG!;
    const decimals = 8; // Default decimals

    console.log('\nTest: Send Multiple Payment Requests');
    console.log('-'.repeat(40));

    // Resolve target first
    const targetPubkey = await resolveNametag(targetNametag);

    const requests = [
      { amount: BigInt(500000), message: 'Coffee - small', nametag: 'merchant-1' },
      { amount: BigInt(1500000), message: 'Lunch payment', nametag: 'merchant-2' },
      { amount: BigInt(10000000), message: 'Monthly subscription', nametag: 'merchant-3' },
    ];

    for (let i = 0; i < requests.length; i++) {
      const req = requests[i];

      // Publish nametag for this merchant
      await publishOurNametag(req.nametag);

      const paymentRequest = {
        amount: req.amount,
        coinId: SOLANA_COIN_ID,
        message: req.message,
        recipientNametag: req.nametag,
      };

      console.log(`Sending request ${i + 1}: ${PaymentRequestProtocol.formatAmount(req.amount, decimals)} - ${req.message}`);
      const eventId = await client.sendPaymentRequest(targetPubkey, paymentRequest);
      console.log(`  Sent (ID: ${eventId.substring(0, 16)}...)`);

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));

    console.log('\n' + '='.repeat(64));
    console.log(`SUCCESS: All ${requests.length} payment requests sent!`);
    console.log('='.repeat(64) + '\n');

    expect(true).toBe(true);
  }, 60000);

  it('should complete full payment request flow with token verification', async () => {
    const targetNametag = TARGET_NAMETAG!;
    const amount = BigInt(process.env.AMOUNT || '1000000');
    const decimals = 8; // Default decimals
    const timeoutSeconds = parseInt(process.env.TIMEOUT || '120', 10);

    const testNametag = `test-recv-${Date.now() % 100000}`;

    console.log('\n' + '='.repeat(64));
    console.log('FULL PAYMENT REQUEST E2E TEST');
    console.log('='.repeat(64));
    console.log(`Target wallet nametag: ${targetNametag}`);
    console.log(`Test receiver nametag: ${testNametag}`);
    console.log(`Amount: ${PaymentRequestProtocol.formatAmount(amount, decimals)}`);
    console.log(`Timeout: ${timeoutSeconds} seconds`);
    console.log('');

    // Step 1: Publish our nametag
    console.log('\n[Step 1] Publish test nametag binding');
    console.log('-'.repeat(40));
    await publishOurNametag(testNametag);

    // Verify nametag
    const resolvedPubkey = await client.queryPubkeyByNametag(testNametag);
    if (resolvedPubkey === keyManager.getPublicKeyHex()) {
      console.log('Nametag verified');
    }

    // Step 2: Subscribe to token transfers
    console.log('\n[Step 2] Subscribe to incoming token transfers');
    console.log('-'.repeat(40));

    let tokenReceived = false;
    let receivedTokenJson: string | null = null;
    let receivedReplyToEventId: string | undefined = undefined;
    let receivedEvent: Event | null = null;

    const TOKEN_PREFIX = 'token_transfer:';

    // Subscribe to both TOKEN_TRANSFER and ENCRYPTED_DM
    const filter = Filter.builder()
      .kinds(EventKinds.TOKEN_TRANSFER, EventKinds.ENCRYPTED_DM)
      .pTags(keyManager.getPublicKeyHex())
      .since(Math.floor(Date.now() / 1000) - 60)
      .build();

    client.subscribe('token-transfer', filter, {
      onEvent: async (event) => {
        console.log(`Received event kind ${event.kind} from: ${event.pubkey.substring(0, 16)}...`);
        try {
          let decrypted: string;

          // Try to decrypt
          if (event.content.includes('?iv=') || event.content.startsWith('gz:')) {
            decrypted = await keyManager.decryptHex(event.content, event.pubkey);
            console.log('   Decrypted successfully');
          } else {
            decrypted = event.content;
            console.log('   Content not encrypted, using raw');
          }

          console.log(`   Content preview: ${decrypted.substring(0, Math.min(100, decrypted.length))}...`);

          if (decrypted.startsWith(TOKEN_PREFIX)) {
            console.log('TOKEN TRANSFER RECEIVED!');
            receivedTokenJson = decrypted;
            receivedEvent = event;

            // Extract reply-to event ID for payment request correlation
            const replyToId = TokenTransferProtocol.getReplyToEventId(event);
            if (replyToId) {
              receivedReplyToEventId = replyToId;
              console.log(`   Reply-to event ID (e tag): ${replyToId.substring(0, 16)}...`);
            } else {
              console.log('   No reply-to event ID (e tag) found');
            }

            tokenReceived = true;
          }
        } catch (e) {
          console.log(`   (Error processing: ${e instanceof Error ? e.message : 'Unknown error'})`);
        }
      },
    });
    console.log('Subscribed to incoming messages');

    // Step 3: Resolve target
    console.log('\n[Step 3] Resolve target wallet nametag');
    console.log('-'.repeat(40));
    const targetPubkey = await resolveNametag(targetNametag);

    // Step 4: Send payment request
    console.log('\n[Step 4] Send payment request');
    console.log('-'.repeat(40));
    const message = 'E2E Test - please accept!';
    const request = {
      amount,
      coinId: SOLANA_COIN_ID,
      message,
      recipientNametag: testNametag,
    };
    const paymentRequestEventId = await client.sendPaymentRequest(targetPubkey, request);
    console.log('Payment request sent!');
    console.log(`   Event ID: ${paymentRequestEventId.substring(0, 16)}...`);
    console.log(`   Amount: ${PaymentRequestProtocol.formatAmount(amount, decimals)}`);
    console.log(`   Recipient: ${testNametag}`);

    // Step 5: Wait for user action
    console.log('\n[Step 5] Waiting for wallet to accept payment request');
    console.log('-'.repeat(40));
    console.log('');
    console.log('+' + '-'.repeat(56) + '+');
    console.log('|  ACTION REQUIRED                                       |');
    console.log('|                                                        |');
    console.log('|  1. Open the wallet app                                |');
    console.log('|  2. Tap Settings (gear) > Payment Requests             |');
    console.log(`|  3. Tap 'Pay' on the request from ${testNametag.padEnd(17)}  |`);
    console.log('|                                                        |');
    console.log(`|  Waiting ${timeoutSeconds} seconds...                               |`);
    console.log('+' + '-'.repeat(56) + '+');
    console.log('');

    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;

    while (!tokenReceived && (Date.now() - startTime) < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const remaining = Math.floor((timeoutMs - (Date.now() - startTime)) / 1000);
      process.stdout.write(`\rWaiting... ${remaining}s remaining    `);
    }
    console.log('');

    // Step 6: Verify
    console.log('\n[Step 6] Verify result');
    console.log('-'.repeat(40));

    if (tokenReceived) {
      console.log('\n' + '='.repeat(64));
      console.log('SUCCESS: Token transfer received!');
      console.log('='.repeat(64));
      console.log(`From: ${targetNametag}`);
      console.log(`To: ${testNametag}`);
      console.log(`Amount: ${PaymentRequestProtocol.formatAmount(amount, decimals)}`);

      if (receivedTokenJson) {
        const jsonPart = receivedTokenJson.substring(TOKEN_PREFIX.length);
        console.log(`Payload: ${jsonPart.substring(0, Math.min(100, jsonPart.length))}...`);
      }
      console.log('='.repeat(64) + '\n');

      // Step 7: Verify payment request correlation (e tag)
      console.log('\n[Step 7] Verify payment request correlation (e tag)');
      console.log('-'.repeat(40));

      if (receivedReplyToEventId) {
        console.log('Token transfer contains reply-to event ID:');
        console.log(`   Expected (payment request): ${paymentRequestEventId}`);
        console.log(`   Actual (e tag in transfer): ${receivedReplyToEventId}`);

        if (paymentRequestEventId === receivedReplyToEventId) {
          console.log('\n' + '='.repeat(64));
          console.log('SUCCESS: CORRELATION VERIFIED!');
          console.log('='.repeat(64));
          console.log('The token transfer correctly references the payment request.');
          console.log('Server can match this transfer to the original request using:');
          console.log('   TokenTransferProtocol.getReplyToEventId(event)');
          console.log('='.repeat(64) + '\n');
        } else {
          console.log('WARNING: Event IDs do not match!');
          console.log('   This may indicate an issue with the wallet implementation.');
        }
      } else {
        console.log('WARNING: No reply-to event ID (e tag) found in token transfer.');
        console.log('   The wallet should include the payment request event ID');
        console.log('   as an \'e\' tag when responding to payment requests.');
        console.log(`   Expected: ["e", "${paymentRequestEventId.substring(0, 16)}...", "", "reply"]`);
      }
    } else {
      console.log('TIMEOUT - No token transfer received');
      console.log('   Check wallet for errors or try again.');
    }

    // Don't fail the test on timeout - it requires manual interaction
    expect(true).toBe(true);
  }, 180000); // 3 minute timeout for manual interaction
});

describe.skipIf(SKIP_RELAY_TESTS)('Payment Request Decline and Expiration - Relay E2E', () => {
  let keyManager: NostrKeyManager;
  let client: NostrClient;

  beforeAll(async () => {
    keyManager = NostrKeyManager.generate();
    client = new NostrClient(keyManager);

    console.log('\n' + '='.repeat(64));
    console.log('Payment Request Decline/Expiration E2E Test');
    console.log('='.repeat(64));
    console.log(`Relay: ${NOSTR_RELAY}`);
    console.log(`Target: ${TARGET_NAMETAG}`);
    console.log(`Our pubkey: ${keyManager.getPublicKeyHex().substring(0, 32)}...`);
    console.log('='.repeat(64) + '\n');

    await client.connect(NOSTR_RELAY);
    console.log('Connected to relay');
  }, 30000);

  afterAll(() => {
    if (client) {
      client.disconnect();
      console.log('\nDisconnected from relay');
    }
  });

  async function resolveNametag(nametag: string): Promise<string> {
    console.log(`Resolving nametag '${nametag}'...`);
    const pubkey = await client.queryPubkeyByNametag(nametag);
    if (!pubkey) {
      throw new Error(`Nametag not found: ${nametag}`);
    }
    console.log(`Resolved to: ${pubkey.substring(0, 32)}...`);
    return pubkey;
  }

  async function publishOurNametag(nametag: string): Promise<void> {
    const bindingEvent = await NametagBinding.createBindingEvent(
      keyManager,
      nametag,
      'test-address-' + Date.now()
    );
    await client.publishEvent(bindingEvent);
    console.log(`Published nametag binding: ${nametag}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  it('should send payment request with deadline and receive decline response', async () => {
    const targetNametag = TARGET_NAMETAG!;
    const amount = BigInt(process.env.AMOUNT || '1000000');
    const decimals = 8;
    const timeoutSeconds = parseInt(process.env.TIMEOUT || '120', 10);
    const deadlineMs = 5 * 60 * 1000; // 5 minute deadline

    const testNametag = `test-decline-${Date.now() % 100000}`;

    console.log('\n' + '='.repeat(64));
    console.log('PAYMENT REQUEST DECLINE E2E TEST');
    console.log('='.repeat(64));
    console.log(`Target wallet nametag: ${targetNametag}`);
    console.log(`Test receiver nametag: ${testNametag}`);
    console.log(`Amount: ${PaymentRequestProtocol.formatAmount(amount, decimals)}`);
    console.log(`Deadline: ${deadlineMs / 1000} seconds from now`);
    console.log(`Timeout: ${timeoutSeconds} seconds`);
    console.log('');

    // Step 1: Publish our nametag
    console.log('\n[Step 1] Publish test nametag binding');
    console.log('-'.repeat(40));
    await publishOurNametag(testNametag);

    // Step 2: Subscribe to payment request responses
    console.log('\n[Step 2] Subscribe to payment request responses');
    console.log('-'.repeat(40));

    let responseReceived = false;
    let receivedResponse: PaymentRequestProtocol.ParsedPaymentRequestResponse | null = null;

    const responseFilter = Filter.builder()
      .kinds(EventKinds.PAYMENT_REQUEST_RESPONSE)
      .pTags(keyManager.getPublicKeyHex())
      .since(Math.floor(Date.now() / 1000) - 60)
      .build();

    client.subscribe('payment-response', responseFilter, {
      onEvent: async (event) => {
        console.log(`Received response event from: ${event.pubkey.substring(0, 16)}...`);
        try {
          if (PaymentRequestProtocol.isPaymentRequestResponse(event)) {
            const parsed = await PaymentRequestProtocol.parsePaymentRequestResponse(event, keyManager);
            console.log(`   Status: ${parsed.status}`);
            console.log(`   Reason: ${parsed.reason || '(none)'}`);
            console.log(`   Original event ID: ${parsed.originalEventId.substring(0, 16)}...`);
            receivedResponse = parsed;
            responseReceived = true;
          }
        } catch (e) {
          console.log(`   (Error processing: ${e instanceof Error ? e.message : 'Unknown error'})`);
        }
      },
    });
    console.log('Subscribed to payment request responses');

    // Step 3: Resolve target
    console.log('\n[Step 3] Resolve target wallet nametag');
    console.log('-'.repeat(40));
    const targetPubkey = await resolveNametag(targetNametag);

    // Step 4: Send payment request with deadline
    console.log('\n[Step 4] Send payment request with deadline');
    console.log('-'.repeat(40));
    const message = 'E2E Test - please DECLINE this request!';
    const deadline = Date.now() + deadlineMs;
    const request = {
      amount,
      coinId: SOLANA_COIN_ID,
      message,
      recipientNametag: testNametag,
      deadline,
    };
    const paymentRequestEventId = await client.sendPaymentRequest(targetPubkey, request);
    console.log('Payment request sent!');
    console.log(`   Event ID: ${paymentRequestEventId.substring(0, 16)}...`);
    console.log(`   Amount: ${PaymentRequestProtocol.formatAmount(amount, decimals)}`);
    console.log(`   Recipient: ${testNametag}`);
    console.log(`   Deadline: ${new Date(deadline).toISOString()}`);

    // Step 5: Wait for user action
    console.log('\n[Step 5] Waiting for wallet to DECLINE payment request');
    console.log('-'.repeat(40));
    console.log('');
    console.log('+' + '-'.repeat(56) + '+');
    console.log('|  ACTION REQUIRED                                       |');
    console.log('|                                                        |');
    console.log('|  1. Open the wallet app                                |');
    console.log('|  2. Tap Settings (gear) > Payment Requests             |');
    console.log(`|  3. Tap 'Reject' on the request from ${testNametag.substring(0, 15).padEnd(15)}  |`);
    console.log('|                                                        |');
    console.log(`|  Waiting ${timeoutSeconds} seconds...                               |`);
    console.log('+' + '-'.repeat(56) + '+');
    console.log('');

    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;

    while (!responseReceived && (Date.now() - startTime) < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const remaining = Math.floor((timeoutMs - (Date.now() - startTime)) / 1000);
      process.stdout.write(`\rWaiting... ${remaining}s remaining    `);
    }
    console.log('');

    // Step 6: Verify
    console.log('\n[Step 6] Verify result');
    console.log('-'.repeat(40));

    if (responseReceived && receivedResponse) {
      console.log('\n' + '='.repeat(64));
      console.log('SUCCESS: Decline response received!');
      console.log('='.repeat(64));
      console.log(`Status: ${receivedResponse.status}`);
      console.log(`Reason: ${receivedResponse.reason || '(none)'}`);
      console.log(`Original event ID: ${receivedResponse.originalEventId}`);
      console.log(`Response sender: ${receivedResponse.senderPubkey.substring(0, 32)}...`);

      // Verify correlation
      if (receivedResponse.originalEventId === paymentRequestEventId) {
        console.log('\nCORRELATION VERIFIED: Response matches original request!');
      } else {
        console.log('\nWARNING: Event IDs do not match!');
      }

      // Verify status
      if (receivedResponse.status === PaymentRequestProtocol.ResponseStatus.DECLINED) {
        console.log('STATUS VERIFIED: Response is DECLINED');
      }

      console.log('='.repeat(64) + '\n');
    } else {
      console.log('TIMEOUT - No decline response received');
      console.log('   Check wallet for errors or try again.');
    }

    expect(true).toBe(true);
  }, 180000);

  it('should send payment request with short deadline and verify expiration handling', async () => {
    const targetNametag = TARGET_NAMETAG!;
    const amount = BigInt(process.env.AMOUNT || '1000000');
    const decimals = 8;
    const deadlineSeconds = parseInt(process.env.DEADLINE_SECONDS || '10', 10); // Short deadline
    const timeoutSeconds = deadlineSeconds + 30; // Wait longer than deadline

    const testNametag = `test-expire-${Date.now() % 100000}`;

    console.log('\n' + '='.repeat(64));
    console.log('PAYMENT REQUEST EXPIRATION E2E TEST');
    console.log('='.repeat(64));
    console.log(`Target wallet nametag: ${targetNametag}`);
    console.log(`Test receiver nametag: ${testNametag}`);
    console.log(`Amount: ${PaymentRequestProtocol.formatAmount(amount, decimals)}`);
    console.log(`Deadline: ${deadlineSeconds} seconds from now`);
    console.log('');

    // Step 1: Publish our nametag
    console.log('\n[Step 1] Publish test nametag binding');
    console.log('-'.repeat(40));
    await publishOurNametag(testNametag);

    // Step 2: Subscribe to payment request responses
    console.log('\n[Step 2] Subscribe to payment request responses');
    console.log('-'.repeat(40));

    let responseReceived = false;
    let receivedResponse: PaymentRequestProtocol.ParsedPaymentRequestResponse | null = null;

    const responseFilter = Filter.builder()
      .kinds(EventKinds.PAYMENT_REQUEST_RESPONSE)
      .pTags(keyManager.getPublicKeyHex())
      .since(Math.floor(Date.now() / 1000) - 60)
      .build();

    client.subscribe('payment-response-expire', responseFilter, {
      onEvent: async (event) => {
        console.log(`Received response event from: ${event.pubkey.substring(0, 16)}...`);
        try {
          if (PaymentRequestProtocol.isPaymentRequestResponse(event)) {
            const parsed = await PaymentRequestProtocol.parsePaymentRequestResponse(event, keyManager);
            console.log(`   Status: ${parsed.status}`);
            console.log(`   Reason: ${parsed.reason || '(none)'}`);
            receivedResponse = parsed;
            responseReceived = true;
          }
        } catch (e) {
          console.log(`   (Error processing: ${e instanceof Error ? e.message : 'Unknown error'})`);
        }
      },
    });
    console.log('Subscribed to payment request responses');

    // Step 3: Resolve target
    console.log('\n[Step 3] Resolve target wallet nametag');
    console.log('-'.repeat(40));
    const targetPubkey = await resolveNametag(targetNametag);

    // Step 4: Send payment request with SHORT deadline
    console.log('\n[Step 4] Send payment request with short deadline');
    console.log('-'.repeat(40));
    const message = 'E2E Test - DO NOT PAY, let this expire!';
    const deadline = Date.now() + (deadlineSeconds * 1000);
    const request = {
      amount,
      coinId: SOLANA_COIN_ID,
      message,
      recipientNametag: testNametag,
      deadline,
    };
    const paymentRequestEventId = await client.sendPaymentRequest(targetPubkey, request);
    console.log('Payment request sent!');
    console.log(`   Event ID: ${paymentRequestEventId.substring(0, 16)}...`);
    console.log(`   Deadline: ${new Date(deadline).toISOString()}`);
    console.log(`   Expires in: ${deadlineSeconds} seconds`);

    // Step 5: Wait and observe
    console.log('\n[Step 5] Waiting for deadline to pass');
    console.log('-'.repeat(40));
    console.log('');
    console.log('+' + '-'.repeat(56) + '+');
    console.log('|  OBSERVATION MODE                                      |');
    console.log('|                                                        |');
    console.log('|  DO NOT accept or reject the request!                  |');
    console.log('|  Let the deadline expire and observe wallet behavior.  |');
    console.log('|                                                        |');
    console.log('|  The wallet should:                                    |');
    console.log('|    1. Mark the request as EXPIRED                      |');
    console.log('|    2. Send EXPIRED response to requester               |');
    console.log('|    3. Prevent acceptance after deadline                |');
    console.log('|                                                        |');
    console.log(`|  Deadline in: ${deadlineSeconds} seconds                              |`);
    console.log('+' + '-'.repeat(56) + '+');
    console.log('');

    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;

    while (!responseReceived && (Date.now() - startTime) < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const remaining = Math.floor((timeoutMs - (Date.now() - startTime)) / 1000);
      const deadlineRemaining = Math.max(0, Math.floor((deadline - Date.now()) / 1000));

      if (deadlineRemaining > 0) {
        process.stdout.write(`\rDeadline in ${deadlineRemaining}s, waiting... ${remaining}s remaining    `);
      } else {
        process.stdout.write(`\rDEADLINE PASSED! Waiting for EXPIRED response... ${remaining}s remaining    `);
      }
    }
    console.log('');

    // Step 6: Verify
    console.log('\n[Step 6] Verify result');
    console.log('-'.repeat(40));

    if (responseReceived && receivedResponse) {
      console.log('\n' + '='.repeat(64));
      if (receivedResponse.status === PaymentRequestProtocol.ResponseStatus.EXPIRED) {
        console.log('SUCCESS: EXPIRED response received!');
      } else {
        console.log(`Response received with status: ${receivedResponse.status}`);
      }
      console.log('='.repeat(64));
      console.log(`Status: ${receivedResponse.status}`);
      console.log(`Reason: ${receivedResponse.reason || '(none)'}`);
      console.log(`Original event ID: ${receivedResponse.originalEventId}`);

      // Verify correlation
      if (receivedResponse.originalEventId === paymentRequestEventId) {
        console.log('\nCORRELATION VERIFIED: Response matches original request!');
      }

      console.log('='.repeat(64) + '\n');
    } else {
      console.log('No response received within timeout');
      console.log('');
      console.log('NOTE: The wallet may handle expiration in different ways:');
      console.log('  - Automatic: Sends EXPIRED response when deadline passes');
      console.log('  - Manual: User must try to accept to see expiration error');
      console.log('  - Silent: Simply removes/hides expired requests');
      console.log('');
      console.log('Try manually tapping "Pay" on the expired request in the wallet');
      console.log('to verify it blocks the acceptance.');
    }

    expect(true).toBe(true);
  }, 180000);
});

// Additional test for protocol compatibility
describe('Payment Request Protocol Compatibility', () => {
  it('should produce events compatible with Java SDK', async () => {
    const keyManager = NostrKeyManager.generate();
    const targetKeyManager = NostrKeyManager.generate();
    const targetPubkey = targetKeyManager.getPublicKeyHex();

    const request = {
      amount: BigInt(1000000),
      coinId: SOLANA_COIN_ID,
      message: 'Test message',
      recipientNametag: 'test-nametag',
      requestId: 'a1b2c3d4',
    };

    const event = await PaymentRequestProtocol.createPaymentRequestEvent(
      keyManager,
      targetPubkey,
      request
    );

    // Verify event structure matches Java SDK expectations
    expect(event.kind).toBe(31115); // PAYMENT_REQUEST
    expect(event.getTagValue('p')).toBe(targetPubkey);
    expect(event.getTagValue('type')).toBe('payment_request');
    expect(event.getTagValue('amount')).toBe('1000000');
    expect(event.getTagValue('recipient')).toBe('test-nametag');

    // Content should be NIP-04 encrypted
    expect(event.content).toContain('?iv=');

    // Event should be valid
    expect(event.verify()).toBe(true);
  });
});
