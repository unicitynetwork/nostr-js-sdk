/**
 * Unit tests for CallbackEventListener
 * Feature 12: CallbackEventListener
 * Techniques: [EP] Equivalence Partitioning
 */

import { describe, it, expect, vi } from 'vitest';
import { CallbackEventListener } from '../../src/client/NostrEventListener.js';
import { Event } from '../../src/protocol/Event.js';
import { NostrKeyManager } from '../../src/NostrKeyManager.js';
import * as EventKinds from '../../src/protocol/EventKinds.js';

describe('CallbackEventListener', () => {
  const keyManager = NostrKeyManager.generate();

  function createTestEvent(): Event {
    return Event.create(keyManager, {
      kind: EventKinds.TEXT_NOTE,
      tags: [],
      content: 'test',
    });
  }

  // [EP] Valid: onEvent callback invoked
  it('should invoke onEvent callback with the event', () => {
    const onEvent = vi.fn();
    const listener = new CallbackEventListener(onEvent);
    const event = createTestEvent();

    listener.onEvent(event);

    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(event);
  });

  // [EP] Valid: onEndOfStoredEvents callback invoked when provided
  it('should invoke onEndOfStoredEvents callback when provided', () => {
    const onEvent = vi.fn();
    const onEose = vi.fn();
    const listener = new CallbackEventListener(onEvent, onEose);

    listener.onEndOfStoredEvents('sub_1');

    expect(onEose).toHaveBeenCalledOnce();
    expect(onEose).toHaveBeenCalledWith('sub_1');
  });

  // [EP] Valid: onEndOfStoredEvents does not throw when not provided
  it('should not throw when onEndOfStoredEvents is called without callback', () => {
    const onEvent = vi.fn();
    const listener = new CallbackEventListener(onEvent);

    expect(() => listener.onEndOfStoredEvents('sub_1')).not.toThrow();
  });

  // [EP] Valid: onError callback invoked when provided
  it('should invoke onError callback when provided', () => {
    const onEvent = vi.fn();
    const onEose = vi.fn();
    const onError = vi.fn();
    const listener = new CallbackEventListener(onEvent, onEose, onError);

    listener.onError('sub_1', 'connection lost');

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith('sub_1', 'connection lost');
  });

  // [EP] Valid: onError does not throw when not provided
  it('should not throw when onError is called without callback', () => {
    const onEvent = vi.fn();
    const listener = new CallbackEventListener(onEvent);

    expect(() => listener.onError('sub_1', 'error')).not.toThrow();
  });

  // Multiple events
  it('should handle multiple events', () => {
    const onEvent = vi.fn();
    const listener = new CallbackEventListener(onEvent);

    const event1 = createTestEvent();
    const event2 = createTestEvent();

    listener.onEvent(event1);
    listener.onEvent(event2);

    expect(onEvent).toHaveBeenCalledTimes(2);
  });
});
