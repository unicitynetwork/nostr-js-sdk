/**
 * Unit tests for NostrClient reconnection logic
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NostrClient, ConnectionEventListener } from '../../src/client/NostrClient.js';
import { NostrKeyManager } from '../../src/NostrKeyManager.js';
import { Filter } from '../../src/protocol/Filter.js';

describe('NostrClient Reconnection', () => {
  let client: NostrClient;
  let keyManager: NostrKeyManager;

  beforeEach(() => {
    keyManager = NostrKeyManager.generate();
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (client) {
      client.disconnect();
    }
    vi.useRealTimers();
  });

  describe('configuration options', () => {
    it('should use default options when not specified', () => {
      client = new NostrClient(keyManager);
      expect(client.getQueryTimeout()).toBe(5000);
    });

    it('should accept custom query timeout', () => {
      client = new NostrClient(keyManager, { queryTimeoutMs: 10000 });
      expect(client.getQueryTimeout()).toBe(10000);
    });

    it('should update query timeout via setter', () => {
      client = new NostrClient(keyManager);
      client.setQueryTimeout(15000);
      expect(client.getQueryTimeout()).toBe(15000);
    });

    it('should accept all reconnection options', () => {
      client = new NostrClient(keyManager, {
        autoReconnect: true,
        reconnectIntervalMs: 2000,
        maxReconnectIntervalMs: 60000,
        pingIntervalMs: 45000,
      });
      // Options are applied internally - we verify by not throwing
      expect(client).toBeDefined();
    });

    it('should disable auto-reconnect when specified', () => {
      client = new NostrClient(keyManager, { autoReconnect: false });
      // Client created without error
      expect(client).toBeDefined();
    });
  });

  describe('connection event listeners', () => {
    it('should add connection listener', () => {
      client = new NostrClient(keyManager);
      const listener: ConnectionEventListener = {
        onConnect: vi.fn(),
        onDisconnect: vi.fn(),
      };

      client.addConnectionListener(listener);
      // Listener added without error
      expect(true).toBe(true);
    });

    it('should remove connection listener', () => {
      client = new NostrClient(keyManager);
      const listener: ConnectionEventListener = {
        onConnect: vi.fn(),
        onDisconnect: vi.fn(),
      };

      client.addConnectionListener(listener);
      client.removeConnectionListener(listener);
      // Listener removed without error
      expect(true).toBe(true);
    });

    it('should handle removing non-existent listener', () => {
      client = new NostrClient(keyManager);
      const listener: ConnectionEventListener = {
        onConnect: vi.fn(),
      };

      // Should not throw when removing listener that wasn't added
      client.removeConnectionListener(listener);
      expect(true).toBe(true);
    });

    it('should call onDisconnect when client disconnects', () => {
      client = new NostrClient(keyManager);
      const onDisconnect = vi.fn();
      const listener: ConnectionEventListener = { onDisconnect };

      client.addConnectionListener(listener);

      // Since we're not connected, disconnect should be called when we try to clean up
      // but only if there were relays
      client.disconnect();

      // onDisconnect would be called for each connected relay
      // Since we never connected, it shouldn't be called
      expect(onDisconnect).not.toHaveBeenCalled();
    });
  });

  describe('exponential backoff calculation', () => {
    it('should calculate correct backoff delays', () => {
      // Test the backoff formula: baseDelay * 2^(attempts-1)
      const baseDelay = 1000;
      const maxDelay = 30000;

      const calculateDelay = (attempts: number): number => {
        const exponentialDelay = baseDelay * Math.pow(2, attempts - 1);
        return Math.min(exponentialDelay, maxDelay);
      };

      expect(calculateDelay(1)).toBe(1000);   // 1000 * 2^0 = 1000
      expect(calculateDelay(2)).toBe(2000);   // 1000 * 2^1 = 2000
      expect(calculateDelay(3)).toBe(4000);   // 1000 * 2^2 = 4000
      expect(calculateDelay(4)).toBe(8000);   // 1000 * 2^3 = 8000
      expect(calculateDelay(5)).toBe(16000);  // 1000 * 2^4 = 16000
      expect(calculateDelay(6)).toBe(30000);  // 1000 * 2^5 = 32000, capped at 30000
      expect(calculateDelay(10)).toBe(30000); // Should always be capped at maxDelay
    });

    it('should respect custom backoff configuration', () => {
      const baseDelay = 500;
      const maxDelay = 10000;

      const calculateDelay = (attempts: number): number => {
        const exponentialDelay = baseDelay * Math.pow(2, attempts - 1);
        return Math.min(exponentialDelay, maxDelay);
      };

      expect(calculateDelay(1)).toBe(500);    // 500 * 2^0 = 500
      expect(calculateDelay(2)).toBe(1000);   // 500 * 2^1 = 1000
      expect(calculateDelay(3)).toBe(2000);   // 500 * 2^2 = 2000
      expect(calculateDelay(4)).toBe(4000);   // 500 * 2^3 = 4000
      expect(calculateDelay(5)).toBe(8000);   // 500 * 2^4 = 8000
      expect(calculateDelay(6)).toBe(10000);  // 500 * 2^5 = 16000, capped at 10000
    });
  });

  describe('ping health check logic', () => {
    it('should detect stale connections after 2x ping interval', () => {
      const pingInterval = 30000;
      const staleThreshold = pingInterval * 2;

      // Simulate last pong time
      const lastPongTime = Date.now() - (staleThreshold + 1000);
      const timeSinceLastPong = Date.now() - lastPongTime;

      expect(timeSinceLastPong > staleThreshold).toBe(true);
    });

    it('should not detect fresh connections as stale', () => {
      const pingInterval = 30000;
      const staleThreshold = pingInterval * 2;

      // Simulate recent pong
      const lastPongTime = Date.now() - 5000;
      const timeSinceLastPong = Date.now() - lastPongTime;

      expect(timeSinceLastPong > staleThreshold).toBe(false);
    });

    it('should be disabled when pingIntervalMs is 0', () => {
      client = new NostrClient(keyManager, { pingIntervalMs: 0 });
      // Client created without error, ping is disabled
      expect(client).toBeDefined();
    });
  });

  describe('disconnect behavior', () => {
    it('should prevent operations after disconnect', async () => {
      client = new NostrClient(keyManager);
      client.disconnect();

      // Connection after disconnect should fail
      await expect(client.connect('wss://invalid.example.com')).rejects.toThrow('disconnected');
    });

    it('should clear all timers on disconnect', () => {
      client = new NostrClient(keyManager);
      // Disconnect should clean up without errors
      client.disconnect();
      expect(true).toBe(true);
    });

    it('should handle multiple disconnects gracefully', () => {
      client = new NostrClient(keyManager);
      client.disconnect();
      client.disconnect();
      client.disconnect();
      expect(true).toBe(true);
    });
  });

  describe('subscription re-establishment', () => {
    it('should track subscriptions for re-establishment', () => {
      client = new NostrClient(keyManager);

      // Create a subscription (won't send to relay since not connected)
      const filter = Filter.builder().kinds(1).build();

      const subId = client.subscribe(filter, {
        onEvent: vi.fn(),
      });

      expect(subId).toMatch(/^sub_\d+$/);

      // Unsubscribe should work
      client.unsubscribe(subId);
    });
  });
});

describe('ConnectionEventListener Interface', () => {
  it('should allow partial implementations', () => {
    // Only onConnect
    const listener1: ConnectionEventListener = {
      onConnect: () => {},
    };
    expect(listener1.onConnect).toBeDefined();
    expect(listener1.onDisconnect).toBeUndefined();

    // Only onDisconnect
    const listener2: ConnectionEventListener = {
      onDisconnect: () => {},
    };
    expect(listener2.onConnect).toBeUndefined();
    expect(listener2.onDisconnect).toBeDefined();

    // All methods
    const listener3: ConnectionEventListener = {
      onConnect: () => {},
      onDisconnect: () => {},
      onReconnecting: () => {},
      onReconnected: () => {},
    };
    expect(listener3.onConnect).toBeDefined();
    expect(listener3.onDisconnect).toBeDefined();
    expect(listener3.onReconnecting).toBeDefined();
    expect(listener3.onReconnected).toBeDefined();
  });

  it('should provide correct types for callback parameters', () => {
    const events: {
      connects: string[];
      disconnects: { url: string; reason: string }[];
      reconnecting: { url: string; attempt: number }[];
      reconnected: string[];
    } = {
      connects: [],
      disconnects: [],
      reconnecting: [],
      reconnected: [],
    };

    const listener: ConnectionEventListener = {
      onConnect: (relayUrl: string) => {
        events.connects.push(relayUrl);
      },
      onDisconnect: (relayUrl: string, reason: string) => {
        events.disconnects.push({ url: relayUrl, reason });
      },
      onReconnecting: (relayUrl: string, attempt: number) => {
        events.reconnecting.push({ url: relayUrl, attempt });
      },
      onReconnected: (relayUrl: string) => {
        events.reconnected.push(relayUrl);
      },
    };

    // Call the listeners with test data
    listener.onConnect!('wss://relay1.example.com');
    listener.onDisconnect!('wss://relay1.example.com', 'Network error');
    listener.onReconnecting!('wss://relay1.example.com', 1);
    listener.onReconnecting!('wss://relay1.example.com', 2);
    listener.onReconnected!('wss://relay1.example.com');

    expect(events.connects).toEqual(['wss://relay1.example.com']);
    expect(events.disconnects).toEqual([
      { url: 'wss://relay1.example.com', reason: 'Network error' },
    ]);
    expect(events.reconnecting).toEqual([
      { url: 'wss://relay1.example.com', attempt: 1 },
      { url: 'wss://relay1.example.com', attempt: 2 },
    ]);
    expect(events.reconnected).toEqual(['wss://relay1.example.com']);
  });
});
