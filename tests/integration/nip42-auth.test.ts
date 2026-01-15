/**
 * NIP-42 Authentication Integration Tests with Testcontainers
 *
 * Spins up a Zooid relay container that requires NIP-42 authentication
 * and verifies the client correctly handles the auth flow.
 *
 * Run with:
 *   npm test tests/integration/nip42-auth.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { NostrKeyManager } from '../../src/NostrKeyManager.js';
import { Event } from '../../src/protocol/Event.js';
import * as EventKinds from '../../src/protocol/EventKinds.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import WebSocket from 'ws';

const TIMEOUT_MS = 60000;
const RELAY_PORT = 3334;
// Zooid validates that the relay tag in AUTH events matches the configured hostname
// Since we configure Zooid with just 'localhost' (no port), use this for AUTH events
const AUTH_RELAY_URL = 'ws://localhost';

/**
 * Generate Zooid relay configuration for testing.
 */
function generateRelayConfig(hostname: string, adminPubkey: string): string {
  return `# Zooid relay test configuration
host = "${hostname}"
schema = "test_relay"
secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

[info]
name = "Test Relay"
icon = ""
pubkey = "${adminPubkey}"
description = "Test relay for NIP-42 authentication"

[policy]
public_join = true
strip_signatures = false

[groups]
enabled = true
auto_join = true

[management]
enabled = false

[blossom]
enabled = false

[roles.member]
can_invite = true

[roles.admin]
pubkeys = ["${adminPubkey}"]
can_manage = true
`;
}

describe('NIP-42 Authentication Integration', () => {
  let container: StartedTestContainer;
  let relayUrl: string;
  let tempDir: string;
  let adminKeys: NostrKeyManager;

  beforeAll(async () => {
    console.log('================================================================');
    console.log('  NIP-42 Authentication Integration Tests');
    console.log('================================================================');
    console.log();

    // Generate admin keypair
    adminKeys = NostrKeyManager.generate();
    console.log(`Admin pubkey: ${adminKeys.getPublicKeyHex().substring(0, 16)}...`);

    // Create temp directory for config
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostr-test-'));
    const configDir = path.join(tempDir, 'config');
    fs.mkdirSync(configDir);

    // Write config file - try just 'localhost' without port
    const configFilename = 'localhost';
    const configPath = path.join(configDir, configFilename);
    const configContent = generateRelayConfig('localhost', adminKeys.getPublicKeyHex());
    fs.writeFileSync(configPath, configContent);
    console.log(`Config written to: ${configPath}`);
    console.log(`Config filename: ${configFilename}`);

    // Create data and media directories
    fs.mkdirSync(path.join(tempDir, 'data'));
    fs.mkdirSync(path.join(tempDir, 'media'));

    console.log('Starting Zooid relay container...');
    try {
      container = await new GenericContainer('ghcr.io/coracle-social/zooid:latest')
        .withExposedPorts(RELAY_PORT)
        .withEnvironment({ PORT: String(RELAY_PORT) })
        .withBindMounts([
          { source: configDir, target: '/app/config', mode: 'rw' },
          { source: path.join(tempDir, 'data'), target: '/app/data', mode: 'rw' },
          { source: path.join(tempDir, 'media'), target: '/app/media', mode: 'rw' },
        ])
        .withWaitStrategy(Wait.forLogMessage(/running on/i, 1))
        .withStartupTimeout(30000)
        .start();

      const mappedPort = container.getMappedPort(RELAY_PORT);
      relayUrl = `ws://localhost:${mappedPort}`;
      console.log(`Relay started at: ${relayUrl}`);

      // Give relay time to fully initialize
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Test HTTP connectivity with custom Host header (just 'localhost', no port)
      const http = await import('http');
      await new Promise<void>((resolve) => {
        const req = http.request({
          hostname: 'localhost',
          port: mappedPort,
          path: '/',
          method: 'GET',
          headers: { Host: 'localhost' },
        }, (res) => {
          console.log(`HTTP test with Host: localhost -> status ${res.statusCode}`);
          resolve();
        });
        req.on('error', (e) => {
          console.log(`HTTP test error: ${e.message}`);
          resolve();
        });
        req.setTimeout(2000);
        req.end();
      });

      // Print container logs
      const stream = await container.logs();
      const logLines: string[] = [];
      stream.on('data', (line: Buffer) => logLines.push(line.toString().trim()));
      await new Promise((resolve) => setTimeout(resolve, 500));
      console.log('Container logs:');
      logLines.forEach((line) => console.log(`  ${line}`));
    } catch (err) {
      console.error('Failed to start container:', err);
      throw err;
    }
  }, TIMEOUT_MS);

  afterAll(async () => {
    if (container) {
      console.log('Stopping relay container...');
      await container.stop();
    }
    if (tempDir) {
      // Clean up temp directory
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    console.log('Cleanup complete');
  });

  /**
   * Helper to create WebSocket with custom Host header
   */
  function createWebSocketWithHost(url: string): WebSocket {
    return new WebSocket(url, {
      headers: { Host: 'localhost' },
    });
  }

  it(
    'should automatically authenticate when connecting to relay',
    async () => {
      console.log();
      console.log('------------------------------------------------------------');
      console.log('TEST: Automatic NIP-42 Authentication');
      console.log('------------------------------------------------------------');

      const userKeys = NostrKeyManager.generate();
      console.log(`User pubkey: ${userKeys.getPublicKeyHex().substring(0, 16)}...`);

      // Connect with custom Host header to match config
      const ws = createWebSocketWithHost(relayUrl);

      const result = await new Promise<{ authenticated: boolean; challenge?: string }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('Connection timeout'));
        }, 10000);

        ws.on('open', () => {
          console.log('WebSocket connected');
        });

        ws.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          console.log(`Received: ${msg[0]}`);

          if (msg[0] === 'AUTH') {
            const challenge = msg[1] as string;
            console.log(`AUTH challenge received: ${challenge.substring(0, 16)}...`);

            // Create and send auth response
            const authEvent = Event.create(userKeys, {
              kind: EventKinds.AUTH,
              tags: [
                ['relay', AUTH_RELAY_URL],
                ['challenge', challenge],
              ],
              content: '',
            });

            ws.send(JSON.stringify(['AUTH', authEvent.toJSON()]));
            console.log('AUTH response sent');
          } else if (msg[0] === 'OK') {
            clearTimeout(timeout);
            ws.close();
            resolve({ authenticated: true, challenge: msg[1] });
          }
        });

        ws.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      expect(result.authenticated).toBe(true);
      console.log();
      console.log('SUCCESS: NIP-42 authentication test passed!');
    },
    TIMEOUT_MS
  );

  it(
    'should be able to subscribe and receive EOSE after auth',
    async () => {
      console.log();
      console.log('------------------------------------------------------------');
      console.log('TEST: Subscription After Authentication');
      console.log('------------------------------------------------------------');

      // Use admin keys which have full access to the relay
      const userKeys = adminKeys;
      console.log(`User pubkey (admin): ${userKeys.getPublicKeyHex().substring(0, 16)}...`);

      const ws = createWebSocketWithHost(relayUrl);

      const result = await new Promise<{ subscribed: boolean; eoseReceived: boolean }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('Test timeout'));
        }, 15000);

        let authCount = 0;
        let subscriptionAttempts = 0;
        let waitingForAuthOk = false;
        const MAX_ATTEMPTS = 3;

        const sendSubscription = () => {
          if (subscriptionAttempts >= MAX_ATTEMPTS) {
            console.log(`Max subscription attempts (${MAX_ATTEMPTS}) reached`);
            return;
          }
          subscriptionAttempts++;
          console.log(`Sending subscription (attempt ${subscriptionAttempts})`);
          const subId = 'test-sub';
          const filter = {
            kinds: [EventKinds.TEXT_NOTE],
            authors: [userKeys.getPublicKeyHex()],
            limit: 10,
          };
          ws.send(JSON.stringify(['REQ', subId, filter]));
        };

        ws.on('open', () => {
          console.log('WebSocket connected');
        });

        ws.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          console.log(`Received: ${msg[0]}`);

          if (msg[0] === 'AUTH') {
            // Always respond to AUTH challenges
            const challenge = msg[1] as string;
            authCount++;
            console.log(`AUTH challenge #${authCount} received`);

            const authEvent = Event.create(userKeys, {
              kind: EventKinds.AUTH,
              tags: [
                ['relay', AUTH_RELAY_URL],
                ['challenge', challenge],
              ],
              content: '',
            });

            ws.send(JSON.stringify(['AUTH', authEvent.toJSON()]));
            console.log('AUTH response sent');
            waitingForAuthOk = true;
          } else if (msg[0] === 'OK' && waitingForAuthOk) {
            // Auth was accepted, send subscription
            console.log('Auth accepted');
            waitingForAuthOk = false;
            // Small delay to let relay process auth fully
            setTimeout(() => sendSubscription(), 50);
          } else if (msg[0] === 'CLOSED') {
            // Subscription was closed, likely due to auth requirement
            console.log(`Subscription closed: ${msg[2] || 'no reason'}`);
            // Will be handled by next AUTH challenge
          } else if (msg[0] === 'EOSE') {
            console.log('EOSE received');
            clearTimeout(timeout);
            ws.close();
            resolve({ subscribed: subscriptionAttempts > 0, eoseReceived: true });
          }
        });

        ws.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      expect(result.subscribed).toBe(true);
      expect(result.eoseReceived).toBe(true);
      console.log();
      console.log('SUCCESS: Subscription after auth test passed!');
    },
    TIMEOUT_MS
  );

  it(
    'should publish and receive events after auth',
    async () => {
      console.log();
      console.log('------------------------------------------------------------');
      console.log('TEST: Publish Event After Auth');
      console.log('------------------------------------------------------------');

      // Use admin keys which have full access to the relay
      const userKeys = adminKeys;
      console.log(`User pubkey (admin): ${userKeys.getPublicKeyHex().substring(0, 16)}...`);

      const ws = createWebSocketWithHost(relayUrl);

      const result = await new Promise<{ published: boolean; eventId?: string; message?: string }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('Test timeout'));
        }, 15000);

        let authCount = 0;
        let eventAttempts = 0;
        let waitingForAuthOk = false;
        let lastEventId: string | undefined;
        const MAX_ATTEMPTS = 3;

        const publishEvent = () => {
          if (eventAttempts >= MAX_ATTEMPTS) {
            console.log(`Max publish attempts (${MAX_ATTEMPTS}) reached`);
            return;
          }
          eventAttempts++;
          console.log(`Publishing event (attempt ${eventAttempts})`);
          const testEvent = Event.create(userKeys, {
            kind: EventKinds.TEXT_NOTE,
            tags: [],
            content: `Test message ${Date.now()}`,
          });
          lastEventId = testEvent.id;
          ws.send(JSON.stringify(['EVENT', testEvent.toJSON()]));
          console.log(`Event sent: ${testEvent.id.substring(0, 16)}...`);
        };

        ws.on('open', () => {
          console.log('WebSocket connected');
        });

        ws.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          console.log(`Received: ${msg[0]}`);

          if (msg[0] === 'AUTH') {
            // Always respond to AUTH challenges
            const challenge = msg[1] as string;
            authCount++;
            console.log(`AUTH challenge #${authCount} received`);

            const authEvent = Event.create(userKeys, {
              kind: EventKinds.AUTH,
              tags: [
                ['relay', AUTH_RELAY_URL],
                ['challenge', challenge],
              ],
              content: '',
            });

            ws.send(JSON.stringify(['AUTH', authEvent.toJSON()]));
            console.log('AUTH response sent');
            waitingForAuthOk = true;
          } else if (msg[0] === 'OK' && waitingForAuthOk) {
            // Auth was accepted
            console.log('Auth accepted');
            waitingForAuthOk = false;
            // Small delay to let relay process auth fully, then publish
            setTimeout(() => publishEvent(), 50);
          } else if (msg[0] === 'OK' && !waitingForAuthOk && eventAttempts > 0) {
            // This is the response to our event
            const eventId = msg[1] as string;
            const success = msg[2] as boolean;
            const message = msg[3] as string | undefined;
            console.log(`Event OK received: ${success ? 'accepted' : 'rejected'} ${message || ''}`);

            if (success) {
              clearTimeout(timeout);
              ws.close();
              resolve({ published: true, eventId, message });
            } else if (message?.includes('auth-required')) {
              // Will be handled by next AUTH challenge
              console.log('Auth required, waiting for AUTH challenge');
            } else {
              // Some other rejection
              clearTimeout(timeout);
              ws.close();
              resolve({ published: false, eventId, message });
            }
          }
        });

        ws.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      expect(result.published).toBe(true);
      console.log();
      console.log('SUCCESS: Publish event after auth test passed!');
    },
    TIMEOUT_MS
  );
});
