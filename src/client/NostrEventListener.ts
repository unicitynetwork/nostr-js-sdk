/**
 * NostrEventListener - Callback interface for receiving events and subscription status.
 */

import { Event } from '../protocol/Event.js';

/**
 * Listener interface for Nostr event subscriptions.
 */
export interface NostrEventListener {
  /**
   * Called when an event matching the subscription filter is received.
   * @param event The received event
   */
  onEvent(event: Event): void;

  /**
   * Called when the relay signals End-Of-Stored-Events (EOSE).
   * This indicates that all stored events matching the filter have been sent.
   * @param subscriptionId The subscription ID
   */
  onEndOfStoredEvents?(subscriptionId: string): void;

  /**
   * Called when a subscription error occurs.
   * @param subscriptionId The subscription ID
   * @param error Error message from the relay
   */
  onError?(subscriptionId: string, error: string): void;
}

/**
 * Simple callback-based event listener.
 * Useful for creating listeners from callback functions.
 */
export class CallbackEventListener implements NostrEventListener {
  private eventCallback: (event: Event) => void;
  private eoseCallback?: (subscriptionId: string) => void;
  private errorCallback?: (subscriptionId: string, error: string) => void;

  constructor(
    onEvent: (event: Event) => void,
    onEndOfStoredEvents?: (subscriptionId: string) => void,
    onError?: (subscriptionId: string, error: string) => void
  ) {
    this.eventCallback = onEvent;
    this.eoseCallback = onEndOfStoredEvents;
    this.errorCallback = onError;
  }

  onEvent(event: Event): void {
    this.eventCallback(event);
  }

  onEndOfStoredEvents(subscriptionId: string): void {
    this.eoseCallback?.(subscriptionId);
  }

  onError(subscriptionId: string, error: string): void {
    this.errorCallback?.(subscriptionId, error);
  }
}
