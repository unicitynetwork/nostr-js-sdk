/**
 * NostrClient - Main entry point for Nostr protocol operations.
 * Handles relay connections, event publishing, and subscriptions.
 */

import { NostrKeyManager } from '../NostrKeyManager.js';
import { Event, UnsignedEventData } from '../protocol/Event.js';
import { Filter } from '../protocol/Filter.js';
import * as EventKinds from '../protocol/EventKinds.js';
import { NostrEventListener } from './NostrEventListener.js';
import {
  createWebSocket,
  extractMessageData,
  IWebSocket,
  OPEN,
  CLOSED,
} from './WebSocketAdapter.js';
import * as NIP17 from '../messaging/nip17.js';
import type { PrivateMessage, PrivateMessageOptions } from '../messaging/types.js';

/** Connection timeout in milliseconds */
const CONNECTION_TIMEOUT_MS = 30000;

/** Reconnection delay in milliseconds */
const RECONNECT_DELAY_MS = 5000;

/** Default query timeout in milliseconds */
const DEFAULT_QUERY_TIMEOUT_MS = 5000;

/**
 * Options for configuring NostrClient behavior.
 */
export interface NostrClientOptions {
  /** Query timeout in milliseconds (default: 5000) */
  queryTimeoutMs?: number;
}

/**
 * Subscription information structure
 */
interface SubscriptionInfo {
  filter: Filter;
  listener: NostrEventListener;
}

/**
 * Queued event for offline handling
 */
interface QueuedEvent {
  event: Event;
  timestamp: number;
  resolve: (eventId: string) => void;
  reject: (error: Error) => void;
}

/**
 * Relay connection state
 */
interface RelayConnection {
  url: string;
  socket: IWebSocket | null;
  connected: boolean;
  reconnecting: boolean;
}

/**
 * Pending OK acknowledgment
 */
interface PendingOk {
  resolve: (eventId: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * NostrClient provides the main interface for Nostr protocol operations.
 */
export class NostrClient {
  private keyManager: NostrKeyManager;
  private relays: Map<string, RelayConnection> = new Map();
  private subscriptions: Map<string, SubscriptionInfo> = new Map();
  private eventQueue: QueuedEvent[] = [];
  private pendingOks: Map<string, PendingOk> = new Map();
  private subscriptionCounter = 0;
  private closed = false;
  private queryTimeoutMs: number;

  /**
   * Create a NostrClient instance.
   * @param keyManager Key manager with signing keys
   * @param options Optional configuration options
   */
  constructor(keyManager: NostrKeyManager, options?: NostrClientOptions) {
    this.keyManager = keyManager;
    this.queryTimeoutMs = options?.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  }

  /**
   * Get the key manager.
   * @returns The key manager instance
   */
  getKeyManager(): NostrKeyManager {
    return this.keyManager;
  }

  /**
   * Get the current query timeout in milliseconds.
   * @returns Query timeout in milliseconds
   */
  getQueryTimeout(): number {
    return this.queryTimeoutMs;
  }

  /**
   * Set the query timeout for nametag lookups and other queries.
   * @param timeoutMs Timeout in milliseconds
   */
  setQueryTimeout(timeoutMs: number): void {
    this.queryTimeoutMs = timeoutMs;
  }

  /**
   * Connect to one or more relay WebSocket URLs.
   * @param relayUrls Relay URLs to connect to
   * @returns Promise that resolves when all connections are established
   */
  async connect(...relayUrls: string[]): Promise<void> {
    if (this.closed) {
      throw new Error('Client has been disconnected');
    }

    const connectionPromises = relayUrls.map((url) => this.connectToRelay(url));
    await Promise.all(connectionPromises);
  }

  /**
   * Connect to a single relay.
   */
  private async connectToRelay(url: string): Promise<void> {
    if (this.relays.has(url)) {
      const relay = this.relays.get(url)!;
      if (relay.connected) {
        return;
      }
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Connection to ${url} timed out`));
      }, CONNECTION_TIMEOUT_MS);

      createWebSocket(url)
        .then((socket) => {
          const relay: RelayConnection = {
            url,
            socket,
            connected: false,
            reconnecting: false,
          };

          socket.onopen = () => {
            clearTimeout(timeoutId);
            relay.connected = true;
            this.relays.set(url, relay);

            // Re-establish subscriptions
            this.resubscribeAll(url);

            // Flush queued events
            this.flushEventQueue();

            resolve();
          };

          socket.onmessage = (event) => {
            try {
              const data = extractMessageData(event);
              this.handleRelayMessage(url, data);
            } catch (error) {
              console.error(`Error handling message from ${url}:`, error);
            }
          };

          socket.onclose = () => {
            relay.connected = false;
            if (!this.closed && !relay.reconnecting) {
              this.scheduleReconnect(url);
            }
          };

          socket.onerror = (error) => {
            if (!relay.connected) {
              clearTimeout(timeoutId);
              reject(new Error(`Failed to connect to ${url}: ${error.message || 'Unknown error'}`));
            }
          };

          this.relays.set(url, relay);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  /**
   * Schedule a reconnection attempt for a relay.
   */
  private scheduleReconnect(url: string): void {
    const relay = this.relays.get(url);
    if (!relay || this.closed) return;

    relay.reconnecting = true;

    setTimeout(async () => {
      if (this.closed) return;

      try {
        relay.reconnecting = false;
        await this.connectToRelay(url);
      } catch {
        // Will trigger another reconnect via onclose
      }
    }, RECONNECT_DELAY_MS);
  }

  /**
   * Re-establish all subscriptions for a relay.
   */
  private resubscribeAll(url: string): void {
    const relay = this.relays.get(url);
    if (!relay?.socket || !relay.connected) return;

    for (const [subId, info] of this.subscriptions) {
      const message = JSON.stringify(['REQ', subId, info.filter.toJSON()]);
      relay.socket.send(message);
    }
  }

  /**
   * Flush queued events to connected relays.
   */
  private flushEventQueue(): void {
    const queue = [...this.eventQueue];
    this.eventQueue = [];

    for (const item of queue) {
      this.broadcastEvent(item.event)
        .then(() => item.resolve(item.event.id))
        .catch(item.reject);
    }
  }

  /**
   * Handle a message from a relay.
   */
  private handleRelayMessage(_url: string, message: string): void {
    try {
      const json = JSON.parse(message) as unknown[];
      if (!Array.isArray(json) || json.length < 2) return;

      const messageType = json[0];

      switch (messageType) {
        case 'EVENT':
          this.handleEventMessage(json);
          break;
        case 'OK':
          this.handleOkMessage(json);
          break;
        case 'EOSE':
          this.handleEOSEMessage(json);
          break;
        case 'NOTICE':
          this.handleNoticeMessage(json);
          break;
        case 'CLOSED':
          this.handleClosedMessage(json);
          break;
      }
    } catch {
      // Ignore malformed messages
    }
  }

  /**
   * Handle EVENT message from relay.
   */
  private handleEventMessage(json: unknown[]): void {
    if (json.length < 3) return;

    const subscriptionId = json[1] as string;
    const eventData = json[2];

    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return;

    try {
      const event = Event.fromJSON(eventData);
      subscription.listener.onEvent(event);
    } catch {
      // Ignore invalid events
    }
  }

  /**
   * Handle OK message from relay.
   */
  private handleOkMessage(json: unknown[]): void {
    if (json.length < 4) return;

    const eventId = json[1] as string;
    const accepted = json[2] as boolean;
    const message = json[3] as string;

    const pending = this.pendingOks.get(eventId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingOks.delete(eventId);

    if (accepted) {
      pending.resolve(eventId);
    } else {
      pending.reject(new Error(`Event rejected: ${message}`));
    }
  }

  /**
   * Handle EOSE (End of Stored Events) message from relay.
   */
  private handleEOSEMessage(json: unknown[]): void {
    if (json.length < 2) return;

    const subscriptionId = json[1] as string;
    const subscription = this.subscriptions.get(subscriptionId);

    if (subscription?.listener.onEndOfStoredEvents) {
      subscription.listener.onEndOfStoredEvents(subscriptionId);
    }
  }

  /**
   * Handle NOTICE message from relay.
   */
  private handleNoticeMessage(json: unknown[]): void {
    if (json.length < 2) return;
    const message = json[1] as string;
    console.warn('Relay notice:', message);
  }

  /**
   * Handle CLOSED message from relay (subscription closed by relay).
   */
  private handleClosedMessage(json: unknown[]): void {
    if (json.length < 3) return;

    const subscriptionId = json[1] as string;
    const message = json[2] as string;

    const subscription = this.subscriptions.get(subscriptionId);
    if (subscription?.listener.onError) {
      subscription.listener.onError(subscriptionId, `Subscription closed: ${message}`);
    }
  }

  /**
   * Disconnect from all relays.
   */
  disconnect(): void {
    this.closed = true;

    // Clear pending OKs
    for (const [, pending] of this.pendingOks) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Client disconnected'));
    }
    this.pendingOks.clear();

    // Clear queued events
    for (const item of this.eventQueue) {
      item.reject(new Error('Client disconnected'));
    }
    this.eventQueue = [];

    // Close all relay connections
    for (const [, relay] of this.relays) {
      if (relay.socket && relay.socket.readyState !== CLOSED) {
        relay.socket.close(1000, 'Client disconnected');
      }
    }
    this.relays.clear();
    this.subscriptions.clear();
  }

  /**
   * Check if connected to at least one relay.
   * @returns true if connected to at least one relay
   */
  isConnected(): boolean {
    for (const [, relay] of this.relays) {
      if (relay.connected) return true;
    }
    return false;
  }

  /**
   * Get the set of connected relay URLs.
   * @returns Set of connected relay URLs
   */
  getConnectedRelays(): Set<string> {
    const connected = new Set<string>();
    for (const [url, relay] of this.relays) {
      if (relay.connected) {
        connected.add(url);
      }
    }
    return connected;
  }

  /**
   * Publish an event to all connected relays.
   * @param event Event to publish
   * @returns Promise that resolves with the event ID
   */
  async publishEvent(event: Event): Promise<string> {
    if (this.closed) {
      throw new Error('Client has been disconnected');
    }

    if (!this.isConnected()) {
      // Queue the event for later
      return new Promise((resolve, reject) => {
        this.eventQueue.push({
          event,
          timestamp: Date.now(),
          resolve,
          reject,
        });
      });
    }

    return this.broadcastEvent(event);
  }

  /**
   * Broadcast an event to all connected relays.
   */
  private async broadcastEvent(event: Event): Promise<string> {
    const message = JSON.stringify(['EVENT', event.toJSON()]);
    let sent = false;

    for (const [, relay] of this.relays) {
      if (relay.connected && relay.socket?.readyState === OPEN) {
        relay.socket.send(message);
        sent = true;
      }
    }

    if (!sent) {
      throw new Error('No connected relays');
    }

    // Wait for at least one OK response
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOks.delete(event.id);
        // Consider it successful if we sent it (some relays don't send OK)
        resolve(event.id);
      }, 5000);

      this.pendingOks.set(event.id, { resolve, reject, timer });
    });
  }

  /**
   * Publish an encrypted direct message (NIP-04).
   * @param recipientPubkeyHex Recipient's public key (hex)
   * @param message Message to send
   * @returns Promise that resolves with the event ID
   */
  async publishEncryptedMessage(
    recipientPubkeyHex: string,
    message: string
  ): Promise<string> {
    const encryptedContent = await this.keyManager.encryptHex(
      message,
      recipientPubkeyHex
    );

    const event = Event.create(this.keyManager, {
      kind: EventKinds.ENCRYPTED_DM,
      tags: [['p', recipientPubkeyHex]],
      content: encryptedContent,
    });

    return this.publishEvent(event);
  }

  /**
   * Send a token transfer (encrypted).
   * @param recipientPubkeyHex Recipient's public key (hex)
   * @param tokenJson Token JSON string
   * @param options Optional parameters (amount, symbol, replyToEventId)
   * @returns Promise that resolves with the event ID
   */
  async sendTokenTransfer(
    recipientPubkeyHex: string,
    tokenJson: string,
    options?: {
      amount?: number | bigint;
      symbol?: string;
      replyToEventId?: string;
    }
  ): Promise<string> {
    const TokenTransferProtocol = await import('../token/TokenTransferProtocol.js');
    const event = await TokenTransferProtocol.createTokenTransferEvent(
      this.keyManager,
      recipientPubkeyHex,
      tokenJson,
      options
    );
    return this.publishEvent(event);
  }

  /**
   * Send a payment request to a target (encrypted).
   * @param targetPubkeyHex Target's public key (who should pay)
   * @param request Payment request details
   * @returns Promise that resolves with the event ID
   */
  async sendPaymentRequest(
    targetPubkeyHex: string,
    request: {
      amount: bigint | number;
      coinId: string;
      message?: string;
      recipientNametag: string;
      requestId?: string;
    }
  ): Promise<string> {
    const PaymentRequestProtocol = await import('../payment/PaymentRequestProtocol.js');
    const event = await PaymentRequestProtocol.createPaymentRequestEvent(
      this.keyManager,
      targetPubkeyHex,
      request
    );
    return this.publishEvent(event);
  }

  /**
   * Publish a nametag binding.
   * @param nametagId Nametag identifier
   * @param unicityAddress Unicity address
   * @returns Promise that resolves with success status
   */
  async publishNametagBinding(
    nametagId: string,
    unicityAddress: string
  ): Promise<boolean> {
    const NametagBinding = await import('../nametag/NametagBinding.js');
    const event = await NametagBinding.createBindingEvent(
      this.keyManager,
      nametagId,
      unicityAddress
    );

    try {
      await this.publishEvent(event);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Subscribe to events matching a filter.
   * @param filter Filter for matching events
   * @param listener Listener for received events
   * @returns Subscription ID
   */
  subscribe(filter: Filter, listener: NostrEventListener): string;
  /**
   * Subscribe with a specific subscription ID.
   * @param subscriptionId Custom subscription ID
   * @param filter Filter for matching events
   * @param listener Listener for received events
   * @returns Subscription ID
   */
  subscribe(
    subscriptionId: string,
    filter: Filter,
    listener: NostrEventListener
  ): string;
  subscribe(
    filterOrSubId: Filter | string,
    listenerOrFilter: NostrEventListener | Filter,
    maybeListener?: NostrEventListener
  ): string {
    let subscriptionId: string;
    let filter: Filter;
    let listener: NostrEventListener;

    if (typeof filterOrSubId === 'string') {
      subscriptionId = filterOrSubId;
      filter = listenerOrFilter as Filter;
      listener = maybeListener!;
    } else {
      subscriptionId = `sub_${++this.subscriptionCounter}`;
      filter = filterOrSubId;
      listener = listenerOrFilter as NostrEventListener;
    }

    this.subscriptions.set(subscriptionId, { filter, listener });

    // Send subscription request to all connected relays
    const message = JSON.stringify(['REQ', subscriptionId, filter.toJSON()]);
    for (const [, relay] of this.relays) {
      if (relay.connected && relay.socket?.readyState === OPEN) {
        relay.socket.send(message);
      }
    }

    return subscriptionId;
  }

  /**
   * Unsubscribe from a subscription.
   * @param subscriptionId Subscription ID to unsubscribe
   */
  unsubscribe(subscriptionId: string): void {
    if (!this.subscriptions.has(subscriptionId)) return;

    this.subscriptions.delete(subscriptionId);

    // Send CLOSE to all connected relays
    const message = JSON.stringify(['CLOSE', subscriptionId]);
    for (const [, relay] of this.relays) {
      if (relay.connected && relay.socket?.readyState === OPEN) {
        relay.socket.send(message);
      }
    }
  }

  /**
   * Query for a public key by nametag.
   * @param nametagId Nametag identifier
   * @returns Promise that resolves with the public key hex, or null if not found
   */
  async queryPubkeyByNametag(nametagId: string): Promise<string | null> {
    const NametagBinding = await import('../nametag/NametagBinding.js');
    const filter = NametagBinding.createNametagToPubkeyFilter(nametagId);

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.unsubscribe(subscriptionId);
        resolve(null);
      }, this.queryTimeoutMs);

      let result: string | null = null;
      let latestCreatedAt = 0;

      const subscriptionId = this.subscribe(filter, {
        onEvent: (event) => {
          // Keep the most recent binding
          if (event.created_at > latestCreatedAt) {
            latestCreatedAt = event.created_at;
            result = event.pubkey;
          }
        },
        onEndOfStoredEvents: () => {
          clearTimeout(timeoutId);
          this.unsubscribe(subscriptionId);
          resolve(result);
        },
      });
    });
  }

  /**
   * Create and publish a signed event.
   * @param data Unsigned event data
   * @returns Promise that resolves with the event ID
   */
  async createAndPublishEvent(data: UnsignedEventData): Promise<string> {
    const event = Event.create(this.keyManager, data);
    return this.publishEvent(event);
  }

  // ========== NIP-17 Private Messages ==========

  /**
   * Send a private message using NIP-17 gift-wrapping.
   * @param recipientPubkeyHex Recipient's public key (hex)
   * @param message Message content
   * @param options Optional message options (reply-to, etc.)
   * @returns Promise that resolves with the gift wrap event ID
   */
  async sendPrivateMessage(
    recipientPubkeyHex: string,
    message: string,
    options?: PrivateMessageOptions
  ): Promise<string> {
    const giftWrap = NIP17.createGiftWrap(
      this.keyManager,
      recipientPubkeyHex,
      message,
      options
    );
    return this.publishEvent(giftWrap);
  }

  /**
   * Send a private message to a recipient identified by their nametag.
   * Resolves the nametag to a pubkey automatically.
   * @param recipientNametag Recipient's nametag (Unicity ID)
   * @param message Message content
   * @param options Optional message options (reply-to, etc.)
   * @returns Promise that resolves with the gift wrap event ID
   */
  async sendPrivateMessageToNametag(
    recipientNametag: string,
    message: string,
    options?: PrivateMessageOptions
  ): Promise<string> {
    const pubkey = await this.queryPubkeyByNametag(recipientNametag);
    if (!pubkey) {
      throw new Error(`Nametag not found: ${recipientNametag}`);
    }
    return this.sendPrivateMessage(pubkey, message, options);
  }

  /**
   * Send a read receipt for a message using NIP-17 gift-wrapping.
   * @param recipientPubkeyHex Recipient (original sender) public key
   * @param messageEventId Event ID of the message being acknowledged
   * @returns Promise that resolves with the gift wrap event ID
   */
  async sendReadReceipt(
    recipientPubkeyHex: string,
    messageEventId: string
  ): Promise<string> {
    const giftWrap = NIP17.createReadReceipt(
      this.keyManager,
      recipientPubkeyHex,
      messageEventId
    );
    return this.publishEvent(giftWrap);
  }

  /**
   * Unwrap a gift-wrapped private message.
   * @param giftWrap Gift wrap event (kind 1059)
   * @returns Parsed private message
   */
  unwrapPrivateMessage(giftWrap: Event): PrivateMessage {
    return NIP17.unwrap(giftWrap, this.keyManager);
  }
}
