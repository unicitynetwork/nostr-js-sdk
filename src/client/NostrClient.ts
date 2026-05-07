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
import {
  createBindingEvent,
  createNametagToPubkeyFilter,
  createAddressToBindingFilter,
  createIdentityBindingEvent,
  parseBindingInfo,
} from '../nametag/NametagBinding.js';
import type { IdentityBindingParams, BindingInfo } from '../nametag/NametagBinding.js';

/** Connection timeout in milliseconds */
const CONNECTION_TIMEOUT_MS = 30000;

/** Default options */
const DEFAULT_QUERY_TIMEOUT_MS = 5000;
const DEFAULT_RECONNECT_INTERVAL_MS = 1000;
const DEFAULT_MAX_RECONNECT_INTERVAL_MS = 30000;
const DEFAULT_PING_INTERVAL_MS = 30000;

/**
 * Internal sub_id reserved for the keepalive REQ. Namespaced with a
 * `__nostr-sdk-` prefix so that user code calling
 * {@link NostrClient.subscribe} with an explicit `subscriptionId`
 * cannot collide — a user choosing the literal `"ping"` would
 * otherwise have their subscription forcibly CLOSE/REQ'd every
 * ping interval. The leading `__` is a stable convention for
 * "do not pick this name."
 */
const PING_SUB_ID = '__nostr-sdk-keepalive__';

/**
 * Delay before resubscribing after NIP-42 authentication.
 * This gives the relay time to process the AUTH response before we send
 * subscription requests. Without this delay, some relays may still reject
 * the subscriptions as the AUTH hasn't been fully processed yet.
 */
const AUTH_RESUBSCRIBE_DELAY_MS = 100;

/**
 * Options for configuring NostrClient behavior.
 */
export interface NostrClientOptions {
  /** Query timeout in milliseconds (default: 5000) */
  queryTimeoutMs?: number;
  /** Enable automatic reconnection on connection loss (default: true) */
  autoReconnect?: boolean;
  /** Initial reconnection interval in milliseconds (default: 1000) */
  reconnectIntervalMs?: number;
  /** Maximum reconnection interval with exponential backoff (default: 30000) */
  maxReconnectIntervalMs?: number;
  /** Ping interval for health checks in milliseconds (default: 30000, 0 to disable) */
  pingIntervalMs?: number;
}

/**
 * Connection event listener for monitoring relay connections.
 */
export interface ConnectionEventListener {
  /** Called when a relay connection is established */
  onConnect?(relayUrl: string): void;
  /** Called when a relay connection is lost */
  onDisconnect?(relayUrl: string, reason: string): void;
  /** Called when reconnection is being attempted */
  onReconnecting?(relayUrl: string, attempt: number): void;
  /** Called when reconnection succeeds */
  onReconnected?(relayUrl: string): void;
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
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  lastPongTime: number;
  unansweredPings: number;
  wasConnected: boolean;  // Track if this relay was previously connected (for reconnect vs initial connect)
  // Sub_ids this specific relay has CLOSED for us. Used to skip them in
  // resubscribeAll / post-AUTH resubscribe so we don't loop on a
  // rejected REQ. Per-relay (not global) because multi-relay clients
  // may have the same sub_id alive on a different healthy relay.
  closedSubIds: Set<string>;
  // Sub_ids this specific relay has EOSE'd for us. Combined with
  // closedSubIds, lets queryWithFirstSeenWins decide when ALL
  // connected relays have finished (either streamed EOSE or rejected
  // with CLOSED) so it doesn't settle early off a single fast relay
  // while a slower one still has matching events to deliver.
  eosedSubIds: Set<string>;
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

  // Configuration options
  private queryTimeoutMs: number;
  private autoReconnect: boolean;
  private reconnectIntervalMs: number;
  private maxReconnectIntervalMs: number;
  private pingIntervalMs: number;

  // Connection event listeners
  private connectionListeners: ConnectionEventListener[] = [];

  /**
   * Create a NostrClient instance.
   * @param keyManager Key manager with signing keys
   * @param options Optional configuration options
   */
  constructor(keyManager: NostrKeyManager, options?: NostrClientOptions) {
    this.keyManager = keyManager;
    this.queryTimeoutMs = options?.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
    this.autoReconnect = options?.autoReconnect ?? true;
    this.reconnectIntervalMs = options?.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS;
    this.maxReconnectIntervalMs = options?.maxReconnectIntervalMs ?? DEFAULT_MAX_RECONNECT_INTERVAL_MS;
    this.pingIntervalMs = options?.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  }

  /**
   * Replace the key manager used for signing and encryption.
   *
   * The connection stays alive — but every operation that consults the
   * key manager from this point on uses the new key, including:
   *   - signing future published events,
   *   - signing NIP-42 AUTH challenge responses,
   *   - the `authors:[selfPubkey]` filter on the keepalive ping REQ
   *     (computed each ping interval),
   *   - any other code path that calls `getPublicKeyHex()` on the
   *     stored manager.
   *
   * Existing in-flight subscriptions are not re-issued or re-keyed.
   * @param keyManager New key manager
   */
  setKeyManager(keyManager: NostrKeyManager): void {
    this.keyManager = keyManager;
  }

  /**
   * Get the current key manager.
   */
  getKeyManager(): NostrKeyManager {
    return this.keyManager;
  }

  /**
   * Add a connection event listener.
   * @param listener Listener for connection events
   */
  addConnectionListener(listener: ConnectionEventListener): void {
    this.connectionListeners.push(listener);
  }

  /**
   * Remove a connection event listener.
   * @param listener Listener to remove
   */
  removeConnectionListener(listener: ConnectionEventListener): void {
    const index = this.connectionListeners.indexOf(listener);
    if (index !== -1) {
      this.connectionListeners.splice(index, 1);
    }
  }

  /**
   * Emit a connection event to all listeners.
   */
  private emitConnectionEvent(
    eventType: 'connect' | 'disconnect' | 'reconnecting' | 'reconnected',
    relayUrl: string,
    extra?: string | number
  ): void {
    for (const listener of this.connectionListeners) {
      try {
        switch (eventType) {
          case 'connect':
            listener.onConnect?.(relayUrl);
            break;
          case 'disconnect':
            listener.onDisconnect?.(relayUrl, extra as string);
            break;
          case 'reconnecting':
            listener.onReconnecting?.(relayUrl, extra as number);
            break;
          case 'reconnected':
            listener.onReconnected?.(relayUrl);
            break;
        }
      } catch {
        // Ignore listener errors
      }
    }
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
   * @param isReconnect Whether this is a reconnection attempt
   */
  private async connectToRelay(url: string, isReconnect = false): Promise<void> {
    const existingRelay = this.relays.get(url);
    if (existingRelay?.connected) {
      return;
    }

    return new Promise((resolve, reject) => {
      // The connection-setup timeout has three races to defend
      // against:
      //   A) createWebSocket resolves AFTER the timeout fired.
      //   B) createWebSocket resolves BEFORE the timeout, but
      //      `onopen` fires AFTER the timeout fired.
      //   C) createWebSocket resolves and `onopen` fires BEFORE the
      //      timeout (the success path).
      // `pendingSocket` lets the timeout proactively close any
      // socket that's already been created but hasn't fired
      // `onopen` yet. The `timedOut` flag covers (A) inside `.then`
      // and (B) inside `socket.onopen`.
      let timedOut = false;
      let pendingSocket: IWebSocket | null = null;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        if (pendingSocket) {
          try { pendingSocket.close(1000, 'Connection setup timed out'); } catch { /* ignore */ }
        }
        reject(new Error(`Connection to ${url} timed out`));
      }, CONNECTION_TIMEOUT_MS);

      createWebSocket(url)
        .then((socket) => {
          if (timedOut) {
            // Caller already saw the rejection. Discard the late
            // socket so we don't leak it.
            try { socket.close(1000, 'Connection setup timed out'); } catch { /* ignore */ }
            return;
          }
          pendingSocket = socket;
          const relay: RelayConnection = {
            url,
            socket,
            connected: false,
            reconnecting: false,
            reconnectAttempts: 0,
            reconnectTimer: null,
            pingTimer: null,
            lastPongTime: Date.now(),
            unansweredPings: 0,
            wasConnected: existingRelay?.wasConnected ?? false,
            // Reset on every new connection: a relay's per-connection
            // sub-slot accounting is fresh, so previously-rejected REQs
            // should be re-issued on the new socket.
            closedSubIds: new Set<string>(),
            eosedSubIds: new Set<string>(),
          };

          socket.onopen = () => {
            // The `.then` block already guards against a socket
            // arriving after the connection timeout, but the socket
            // can also be created BEFORE the timeout while
            // `onopen` fires AFTER the timeout has rejected the
            // outer promise. Without this second guard we'd register
            // the relay, start a pingTimer, and resubscribe — orphan
            // background resources the caller can't see or clean up
            // because their connect() call already saw a rejection.
            if (timedOut) {
              try { socket.close(1000, 'Connection setup timed out'); } catch { /* ignore */ }
              return;
            }
            clearTimeout(timeoutId);
            relay.connected = true;
            relay.reconnectAttempts = 0;  // Reset on successful connection
            relay.lastPongTime = Date.now();
            this.relays.set(url, relay);

            // Emit appropriate connection event
            if (isReconnect && relay.wasConnected) {
              this.emitConnectionEvent('reconnected', url);
            } else {
              this.emitConnectionEvent('connect', url);
            }
            relay.wasConnected = true;

            // Start ping health check
            this.startPingTimer(url);

            // Re-establish subscriptions
            this.resubscribeAll(url);

            // Flush queued events
            this.flushEventQueue();

            resolve();
          };

          socket.onmessage = (event) => {
            try {
              const data = extractMessageData(event);
              // Update last pong time and reset unanswered pings on any message (relay is alive)
              const r = this.relays.get(url);
              if (r) {
                r.lastPongTime = Date.now();
                r.unansweredPings = 0;
              }
              this.handleRelayMessage(url, data);
            } catch (error) {
              console.error(`Error handling message from ${url}:`, error);
            }
          };

          socket.onclose = (event) => {
            const wasConnected = relay.connected;
            relay.connected = false;
            this.stopPingTimer(url);

            // Pre-onopen close: TCP handshake failure or relay
            // immediately closed the WS during the upgrade. Without
            // this, the connectToRelay promise stays pending until
            // CONNECTION_TIMEOUT_MS (30s) expires; surfacing it now
            // lets the caller see the failure promptly and retry.
            if (!wasConnected && !timedOut) {
              timedOut = true;
              clearTimeout(timeoutId);
              reject(new Error(
                `Connection to ${url} closed during handshake: ${event?.reason || 'no reason'}`,
              ));
            }

            if (wasConnected) {
              const reason = event?.reason || 'Connection closed';
              this.emitConnectionEvent('disconnect', url, reason);

              // Re-trigger the all-done check on every active sub.
              // queryWithFirstSeenWins.allRelaysDoneFor only runs
              // from listener callbacks (EOSE / CLOSED via onError);
              // a socket that drops without sending either would
              // otherwise leave the query hanging until
              // queryTimeoutMs even though the disconnected relay no
              // longer counts toward "still pending" relays. Firing
              // a synthetic onError gives every active sub a chance
              // to re-evaluate now that the relay set has shrunk.
              // Include the relay URL so listeners in a multi-relay
              // client can attribute which relay dropped.
              const inflight = Array.from(this.subscriptions.entries());
              for (const [subId, sub] of inflight) {
                try {
                  sub.listener.onError?.(subId, `Relay disconnected (${url}): ${reason}`);
                } catch {
                  // Ignore listener errors — we're notifying
                  // best-effort.
                }
              }
            }

            if (!this.closed && this.autoReconnect && !relay.reconnecting) {
              this.scheduleReconnect(url);
            }
          };

          socket.onerror = (error) => {
            if (!relay.connected) {
              clearTimeout(timeoutId);
              reject(new Error(`Failed to connect to ${url}: ${error.message || 'Unknown error'}`));
            }
          };

          // Note: we do NOT register the relay in `this.relays` here —
          // only after `onopen` fires successfully. Registering eagerly
          // (before onopen) would leak the relay into the global map
          // even when the connection setup times out and the caller's
          // promise has already rejected.
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  /**
   * Schedule a reconnection attempt for a relay with exponential backoff.
   */
  private scheduleReconnect(url: string): void {
    const relay = this.relays.get(url);
    if (!relay || this.closed || !this.autoReconnect) return;

    // Clear any existing reconnect timer
    if (relay.reconnectTimer) {
      clearTimeout(relay.reconnectTimer);
    }

    relay.reconnecting = true;
    relay.reconnectAttempts++;

    // Calculate delay with exponential backoff
    const baseDelay = this.reconnectIntervalMs;
    const exponentialDelay = baseDelay * Math.pow(2, relay.reconnectAttempts - 1);
    const delay = Math.min(exponentialDelay, this.maxReconnectIntervalMs);

    this.emitConnectionEvent('reconnecting', url, relay.reconnectAttempts);

    relay.reconnectTimer = setTimeout(async () => {
      if (this.closed) return;

      relay.reconnectTimer = null;

      try {
        relay.reconnecting = false;
        await this.connectToRelay(url, true);
      } catch {
        // Connection failed, schedule another attempt
        if (!this.closed && this.autoReconnect) {
          this.scheduleReconnect(url);
        }
      }
    }, delay);
  }

  /**
   * Start the ping timer for a relay to detect stale connections.
   */
  private startPingTimer(url: string): void {
    if (this.pingIntervalMs <= 0) return;

    const relay = this.relays.get(url);
    if (!relay) return;

    // Stop existing timer if any
    this.stopPingTimer(url);

    relay.pingTimer = setInterval(() => {
      if (!relay.connected || !relay.socket) {
        this.stopPingTimer(url);
        return;
      }

      const timeSinceLastPong = Date.now() - relay.lastPongTime;

      if (timeSinceLastPong > this.pingIntervalMs * 2 && relay.unansweredPings >= 2) {
        // No inbound message for 2x the ping interval AND we've sent at least 2 pings
        // without any response — the connection is truly stale.
        // The unanswered pings gate handles browser tab throttling: on the first tick
        // after waking, unansweredPings is 0, so we send a ping and wait. If the relay
        // is alive it responds (resetting the counter). If dead, subsequent ticks
        // increment the counter until it reaches the threshold, even under sustained
        // throttling where intervals are irregular.
        console.warn(`Relay ${url} appears stale (no response for ${timeSinceLastPong}ms, ${relay.unansweredPings} unanswered pings), reconnecting...`);
        this.stopPingTimer(url);
        try {
          relay.socket.close();
        } catch {
          // Ignore close errors
        }
        return;
      }

      // Send a subscription request as a ping (relays respond with EOSE).
      // The filter MUST be tightly scoped — an open `{ limit: 1 }` filter
      // with no kinds/authors/#p will, after EOSE, stream every event the
      // relay receives (NIP-01 live tail), saturating the connection and
      // exhausting per-connection subscription slots on busy relays.
      // Scoping by `authors:[self]` keeps the live tail empty in practice
      // (the relay would only forward our own future events).
      try {
        const selfPubkey = this.keyManager.getPublicKeyHex();
        // First close any existing ping subscription to ensure we don't accumulate
        const closeMessage = JSON.stringify(['CLOSE', PING_SUB_ID]);
        relay.socket.send(closeMessage);
        // Then send the new ping request (limit:1 ensures relay sends EOSE)
        const pingMessage = JSON.stringify([
          'REQ',
          PING_SUB_ID,
          { authors: [selfPubkey], limit: 1 },
        ]);
        relay.socket.send(pingMessage);
        relay.unansweredPings++;
      } catch {
        // Send failed, connection likely dead
        console.warn(`Ping to ${url} failed, reconnecting...`);
        this.stopPingTimer(url);
        try {
          relay.socket.close();
        } catch {
          // Ignore close errors
        }
      }
    }, this.pingIntervalMs);
  }

  /**
   * Stop the ping timer for a relay.
   */
  private stopPingTimer(url: string): void {
    const relay = this.relays.get(url);
    if (relay?.pingTimer) {
      clearInterval(relay.pingTimer);
      relay.pingTimer = null;
    }
  }

  /**
   * Re-establish all subscriptions for a relay.
   */
  private resubscribeAll(url: string): void {
    const relay = this.relays.get(url);
    if (!relay?.socket || !relay.connected) return;

    for (const [subId, info] of this.subscriptions) {
      // Skip subs this relay has previously CLOSED — re-issuing them
      // just triggers the same rejection in a loop. Other healthy
      // relays still resubscribe.
      if (relay.closedSubIds.has(subId)) continue;
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
  private handleRelayMessage(relayUrl: string, message: string): void {
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
          this.handleEOSEMessage(relayUrl, json);
          break;
        case 'NOTICE':
          this.handleNoticeMessage(json);
          break;
        case 'CLOSED':
          this.handleClosedMessage(relayUrl, json);
          break;
        case 'AUTH':
          this.handleAuthMessage(relayUrl, json);
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
    if (json.length < 3 || typeof json[1] !== 'string') return;

    const subscriptionId = json[1];
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
   *
   * Records the per-relay EOSE marker (mirroring closedSubIds) so
   * queryWithFirstSeenWins can decide when ALL connected relays have
   * finished — either streamed EOSE or rejected with CLOSED — instead
   * of settling off the first fast relay's EOSE while a slower relay
   * is still about to deliver matching events.
   */
  private handleEOSEMessage(relayUrl: string, json: unknown[]): void {
    if (json.length < 2 || typeof json[1] !== 'string') return;

    const subscriptionId = json[1];
    if (!this.subscriptions.has(subscriptionId)) return;

    const relay = this.relays.get(relayUrl);
    if (relay) {
      relay.eosedSubIds.add(subscriptionId);
    }

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
   *
   * NIP-01 CLOSED frames are terminal for the named subscription **on
   * the sending relay**. In a multi-relay client the same sub_id may
   * still be alive on a healthy relay, so we must NOT delete the
   * global `this.subscriptions` entry here — that would silently drop
   * EVENT/EOSE frames from the still-healthy relays in
   * `handleEventMessage` (which consults the global map).
   *
   * Instead we record the rejection on the sending relay's
   * `closedSubIds` set so `resubscribeAll` and post-AUTH resubscribe
   * skip it on this relay only. The listener is notified via
   * `onError` so callers (e.g. queryWithFirstSeenWins) can decide to
   * settle and explicitly `unsubscribe()` if they want to give up
   * across all relays.
   */
  private handleClosedMessage(relayUrl: string, json: unknown[]): void {
    // NIP-01 makes the message field optional: `["CLOSED", <sub>]` is
    // valid. Dropping such frames was exactly the leak this PR sets out
    // to fix — no closedSubIds marker and no onError notification means
    // queries hang until timeout and resubscribe loops persist.
    if (json.length < 2 || typeof json[1] !== 'string') return;

    const subscriptionId = json[1];
    // Ignore CLOSED for sub_ids we don't know about. A misbehaving or
    // malicious relay could otherwise spam us with arbitrary sub_ids
    // and grow `closedSubIds` unbounded over a long-lived connection,
    // and could pre-emptively block sub_ids we might use later.
    if (!this.subscriptions.has(subscriptionId)) return;

    const message = typeof json[2] === 'string' ? json[2] : 'no reason provided';

    // NIP-42 transient case: relays that require AUTH typically reject
    // pre-auth REQs with `CLOSED("auth-required:...")` and then send
    // an AUTH challenge. resubscribeAfterAuth re-issues the sub, so
    // this rejection is NOT terminal. If we marked closedSubIds here,
    // queryWithFirstSeenWins.onError would settle the future
    // prematurely (single-relay → allRelaysDoneFor=true), unsubscribe
    // the sub, and the post-AUTH retry would find nothing to retry.
    // Listener still gets onError so callers see the reason; we just
    // don't poison the per-relay state with a transient marker.
    //
    // We accept three on-the-wire shapes: `auth-required:...`
    // (NIP-42 standard with reason), `auth-required ...` (whitespace
    // separator), and bare `auth-required` (no suffix at all — some
    // relays / tests).
    const isAuthRequired = message === 'auth-required'
        || message.startsWith('auth-required:')
        || message.startsWith('auth-required ');

    const relay = this.relays.get(relayUrl);
    if (relay && !isAuthRequired) {
      relay.closedSubIds.add(subscriptionId);
    }

    const subscription = this.subscriptions.get(subscriptionId);
    if (subscription?.listener.onError) {
      // Pass the relay's reason through verbatim so callers can
      // pattern-match on standard prefixes (`auth-required:`,
      // `rate-limited:`, `blocked:`, etc.) without parsing through
      // a wrapper string.
      subscription.listener.onError(subscriptionId, message);
    }
  }

  /**
   * Handle AUTH message from relay (NIP-42 authentication challenge).
   */
  private handleAuthMessage(relayUrl: string, json: unknown[]): void {
    if (json.length < 2) return;

    const challenge = json[1] as string;
    const relay = this.relays.get(relayUrl);
    if (!relay?.socket || !relay.connected) return;

    // Create and sign the auth event (kind 22242)
    const authEvent = Event.create(this.keyManager, {
      kind: EventKinds.AUTH,
      tags: [
        ['relay', relayUrl],
        ['challenge', challenge],
      ],
      content: '',
    });

    // Send AUTH response
    const message = JSON.stringify(['AUTH', authEvent.toJSON()]);
    relay.socket.send(message);

    // Re-send subscriptions after auth (relay may have ignored pre-auth
    // requests). Two separate per-relay markers, two separate decisions:
    //
    //  - `closedSubIds`: do NOT clear. handleClosedMessage already
    //    skips the auth-required transient case, so anything in this
    //    set is a TERMINAL rejection (rate-limited, blocked, etc.)
    //    that AUTH does not relax. The resubscribeAll guard then
    //    correctly skips terminal-rejected subs on this relay. They
    //    will be retried on the next reconnect, when onopen creates a
    //    fresh RelayConnection with empty markers.
    //
    //  - `eosedSubIds`: clear. A relay may have EOSE'd a pre-auth sub
    //    with zero events (filter unsatisfiable without auth context);
    //    post-auth the same filter might match. We must re-arm the
    //    local "still waiting" state so any in-flight
    //    queryWithFirstSeenWins doesn't see this relay as already-done
    //    from a stale marker.
    setTimeout(() => {
      const r = this.relays.get(relayUrl);
      if (r) r.eosedSubIds.clear();
      this.resubscribeAll(relayUrl);
    }, AUTH_RESUBSCRIBE_DELAY_MS);
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

    // Close all relay connections and clean up timers. Mark every
    // relay disconnected synchronously BEFORE we notify subscriptions
    // below, so any listener that consults `allRelaysDoneFor` sees
    // zero connected relays and settles immediately.
    for (const [url, relay] of this.relays) {
      relay.connected = false;
      if (relay.pingTimer) {
        clearInterval(relay.pingTimer);
        relay.pingTimer = null;
      }
      if (relay.reconnectTimer) {
        clearTimeout(relay.reconnectTimer);
        relay.reconnectTimer = null;
      }
      if (relay.socket && relay.socket.readyState !== CLOSED) {
        relay.socket.close(1000, 'Client disconnected');
      }
      this.emitConnectionEvent('disconnect', url, 'Client disconnected');
    }

    // Notify in-flight subscriptions that we're shutting down.
    // queryWithFirstSeenWins.onError re-checks allRelaysDoneFor (now
    // 0 connected → trivially true) and settles immediately, sparing
    // callers the full queryTimeoutMs wait. Snapshot keys first
    // because the listener may call unsubscribe(), which mutates
    // this.subscriptions while we iterate.
    const inflightSubs = Array.from(this.subscriptions.entries());
    for (const [subId, sub] of inflightSubs) {
      try {
        sub.listener.onError?.(subId, 'Client disconnected');
      } catch {
        // Ignore listener errors — we're tearing down anyway.
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
      deadline?: number | null;
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
   * Send a payment request response (decline/expiration notification).
   * @param targetPubkeyHex Original requester's public key
   * @param response Response details
   * @returns Promise that resolves with the event ID
   */
  async sendPaymentRequestResponse(
    targetPubkeyHex: string,
    response: {
      requestId: string;
      originalEventId: string;
      status: 'DECLINED' | 'EXPIRED';
      reason?: string;
    }
  ): Promise<string> {
    const PaymentRequestProtocol = await import('../payment/PaymentRequestProtocol.js');
    const event = await PaymentRequestProtocol.createPaymentRequestResponseEvent(
      this.keyManager,
      targetPubkeyHex,
      {
        requestId: response.requestId,
        originalEventId: response.originalEventId,
        status: response.status === 'DECLINED'
          ? PaymentRequestProtocol.ResponseStatus.DECLINED
          : PaymentRequestProtocol.ResponseStatus.EXPIRED,
        reason: response.reason,
      }
    );
    return this.publishEvent(event);
  }

  /**
   * Send a payment request decline response.
   * Convenience method for declining a payment request.
   * @param originalRequestSenderPubkey Pubkey of who sent the original payment request
   * @param originalEventId Event ID of the original payment request
   * @param requestId Request ID from the original payment request
   * @param reason Optional reason for declining
   * @returns Promise that resolves with the event ID
   */
  async sendPaymentRequestDecline(
    originalRequestSenderPubkey: string,
    originalEventId: string,
    requestId: string,
    reason?: string
  ): Promise<string> {
    return this.sendPaymentRequestResponse(originalRequestSenderPubkey, {
      requestId,
      originalEventId,
      status: 'DECLINED',
      reason,
    });
  }

  /**
   * Publish a nametag binding.
   * Checks for existing claims by other pubkeys before publishing.
   * @param nametagId Nametag identifier
   * @param unicityAddress Unicity address
   * @returns Promise that resolves with success status
   * @throws Error if nametag is invalid or already claimed by another pubkey
   */
  async publishNametagBinding(
    nametagId: string,
    unicityAddress: string,
    identity?: IdentityBindingParams,
  ): Promise<boolean> {
    // Check if already claimed by another pubkey
    const existingOwner = await this.queryPubkeyByNametag(nametagId);
    if (existingOwner && existingOwner !== this.keyManager.getPublicKeyHex()) {
      throw new Error(
        `Nametag "${nametagId}" is already claimed by another pubkey`
      );
    }

    const event = await createBindingEvent(
      this.keyManager,
      nametagId,
      unicityAddress,
      undefined,
      identity,
    );

    try {
      await this.publishEvent(event);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Publish a base identity binding (no nametag).
   * Uses d-tag = SHA256('unicity:identity:' + nostrPubkey) so each wallet
   * has exactly one identity binding. Subsequent calls replace the previous event.
   * @param identity Identity parameters (publicKey, l1Address, directAddress)
   * @returns true if published successfully
   */
  async publishIdentityBinding(identity: IdentityBindingParams): Promise<boolean> {
    const event = createIdentityBindingEvent(this.keyManager, identity);

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

    // Reserved prefix for SDK-internal sub_ids (currently just the
    // keepalive `PING_SUB_ID`). Reject explicit caller use so the
    // keepalive timer's CLOSE/REQ cycle can't stomp on user state.
    if (subscriptionId.startsWith('__nostr-sdk-')) {
      throw new Error(
        `Subscription ID "${subscriptionId}" uses the reserved "__nostr-sdk-" prefix — pick a different id.`,
      );
    }

    this.subscriptions.set(subscriptionId, { filter, listener });

    // Wipe any stale per-relay EOSE/CLOSED markers for this sub_id
    // before issuing the REQ — otherwise a fresh subscribe with a
    // sub_id that was previously CLOSED (or was just freshly
    // EOSE'd) would be skipped or treated as "already done" on
    // those relays.
    for (const [, relay] of this.relays) {
      relay.closedSubIds.delete(subscriptionId);
      relay.eosedSubIds.delete(subscriptionId);
    }

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

    // Send CLOSE to all connected relays — except those that already
    // CLOSED the sub themselves (no point telling the relay something
    // it told us).
    const message = JSON.stringify(['CLOSE', subscriptionId]);
    for (const [, relay] of this.relays) {
      if (relay.connected && relay.socket?.readyState === OPEN
          && !relay.closedSubIds.has(subscriptionId)) {
        relay.socket.send(message);
      }
      // Drop both per-relay markers now that the sub is gone from
      // the global map.
      relay.closedSubIds.delete(subscriptionId);
      relay.eosedSubIds.delete(subscriptionId);
    }
  }

  /**
   * Query binding events with first-seen-wins anti-hijacking resolution.
   *
   * Strategy: first-seen-wins across authors, latest-wins for same author.
   * - Across authors: the pubkey that first published wins (earliest created_at)
   * - Same author: the most recent event is used (latest created_at = most complete data)
   * - Tie-breaking: deterministic by lexicographic pubkey comparison (lowest wins)
   *
   * Events with invalid signatures are silently skipped to prevent relay injection attacks.
   *
   * Known limitations:
   * - Timestamps are self-reported (NIP-01). An attacker can set created_at to 0.
   *   Chain-anchored proof of registration time is the only reliable defense.
   * - TOCTOU: between conflict check and publish, another user can claim the same nametag.
   *   This is inherent to Nostr's eventually-consistent relay model.
   *
   * @param filter Subscription filter
   * @param extractResult Callback to extract the desired result from the winning event
   * @returns Promise resolving to the extracted result, or null
   */
  private queryWithFirstSeenWins<T>(
    filter: Filter,
    extractResult: (event: Event) => T,
  ): Promise<T | null> {
    return new Promise((resolve) => {
      let subscriptionId = '';
      let settled = false;
      // Declared as `let` and initialized lazily so `finishWith` can be
      // invoked before the setTimeout call below without hitting the
      // TDZ on `clearTimeout(timeoutId)`. (The same comment on the
      // listener anticipates synchronous-callback hypothetical paths.)
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      // Accept an explicit `id` so callers from inside the listener can
      // pass the sub_id the relay echoed back. This guards against any
      // future change to subscribe() that would invoke listener
      // callbacks before its return value is bound to `subscriptionId`
      // — the closure-captured value would still be `''` and we'd skip
      // the CLOSE frame, leaking the slot on the relay.
      const finishWith = (result: T | null, id?: string) => {
        if (settled) return;
        settled = true;
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        const subId = id || subscriptionId;
        if (subId) this.unsubscribe(subId);
        resolve(result);
      };

      timeoutId = setTimeout(() => finishWith(null), this.queryTimeoutMs);

      const authors = new Map<string, { firstSeen: number; latestEvent: Event }>();

      const allRelaysDone = (id: string): boolean => this.allRelaysDoneFor(id);

      const pickWinner = (): T | null => {
        let winnerEntry: { firstSeen: number; latestEvent: Event } | null = null;
        let winnerPubkey = '';
        for (const [pubkey, entry] of authors) {
          if (!winnerEntry
              || entry.firstSeen < winnerEntry.firstSeen
              || (entry.firstSeen === winnerEntry.firstSeen && pubkey < winnerPubkey)) {
            winnerEntry = entry;
            winnerPubkey = pubkey;
          }
        }
        return winnerEntry ? extractResult(winnerEntry.latestEvent) : null;
      };

      subscriptionId = this.subscribe(filter, {
        onEvent: (event) => {
          // Verify signature to prevent relay injection of forged events (#4)
          if (!event.verify()) return;

          const existing = authors.get(event.pubkey);
          if (!existing) {
            authors.set(event.pubkey, { firstSeen: event.created_at, latestEvent: event });
          } else {
            if (event.created_at < existing.firstSeen) {
              existing.firstSeen = event.created_at;
            }
            if (event.created_at > existing.latestEvent.created_at) {
              existing.latestEvent = event;
            }
          }
        },
        // EOSE means *this relay* has finished delivering stored
        // events. In a multi-relay client we must not settle yet — a
        // slower relay may still be about to deliver matching events.
        // Settle only when every connected relay has either EOSE'd
        // OR CLOSED'd this sub. (Single-relay clients are unaffected:
        // allDone is trivially true with one relay.)
        onEndOfStoredEvents: (id) => {
          if (allRelaysDone(id)) {
            finishWith(pickWinner(), id);
          }
        },
        // Subscription error from the SDK — fires from three paths
        // that all need the same "is it time to settle?" check:
        //   1. Relay sent CLOSED for this sub. In a multi-relay
        //      client the same sub_id may still be alive on a
        //      healthy relay; settling on the first CLOSED would
        //      prematurely abort a query other relays could
        //      satisfy. handleClosedMessage records the rejection
        //      on the sending relay's closedSubIds before invoking
        //      us, so we can decide via allRelaysDoneFor.
        //   2. Relay disconnected mid-query (socket.onclose →
        //      synthetic onError). The relay no longer counts as
        //      connected, so allRelaysDoneFor excludes it.
        //   3. Client disconnected (disconnect() → synthetic
        //      onError). All relays are torn down, allRelaysDoneFor
        //      sees zero connected and settles.
        onError: (id, message) => {
          console.warn(`Subscription error on ${id}: ${message}`);
          if (allRelaysDone(id)) {
            finishWith(pickWinner(), id);
          }
          // else: keep waiting for EOSE / CLOSED from remaining
          // relays or the overall query timeout.
        },
      });
    });
  }

  /**
   * True if every currently-connected relay has finished delivering
   * for the given sub_id (either EOSE'd or CLOSED'd it). Used by
   * queryWithFirstSeenWins to coordinate multi-relay settlement.
   */
  private allRelaysDoneFor(subscriptionId: string): boolean {
    const connected = Array.from(this.relays.values()).filter((r) => r.connected);
    // No connected relays at all → nothing to wait for; settle.
    if (connected.length === 0) return true;
    return connected.every(
      (r) => r.eosedSubIds.has(subscriptionId) || r.closedSubIds.has(subscriptionId),
    );
  }

  /**
   * Query for a public key by nametag.
   * Uses first-seen-wins anti-hijacking resolution.
   * @param nametagId Nametag identifier
   * @returns Promise that resolves with the public key hex, or null if not found
   */
  async queryPubkeyByNametag(nametagId: string): Promise<string | null> {
    return this.queryWithFirstSeenWins(
      createNametagToPubkeyFilter(nametagId),
      (event) => event.pubkey,
    );
  }

  /**
   * Query for full binding info by nametag.
   * Returns extended identity fields (chain pubkey, addresses, etc.) when available.
   * Uses first-seen-wins across authors, latest-wins for same author.
   * @param nametagId Nametag identifier
   * @returns Promise that resolves with BindingInfo, or null if not found
   */
  async queryBindingByNametag(nametagId: string): Promise<BindingInfo | null> {
    return this.queryWithFirstSeenWins(
      createNametagToPubkeyFilter(nametagId),
      parseBindingInfo,
    );
  }

  /**
   * Query for binding info by address (reverse lookup).
   * Supports DIRECT://, PROXY://, alpha1..., or chain pubkey lookups.
   * Uses first-seen-wins across authors, latest-wins for same author.
   * @param address Address string
   * @returns Promise that resolves with BindingInfo, or null if not found
   */
  async queryBindingByAddress(address: string): Promise<BindingInfo | null> {
    return this.queryWithFirstSeenWins(
      createAddressToBindingFilter(address),
      parseBindingInfo,
    );
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
