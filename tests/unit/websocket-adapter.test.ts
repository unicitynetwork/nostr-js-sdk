/**
 * Unit tests for WebSocketAdapter
 * Feature 10: WebSocket message data extraction
 * Techniques: [EP] Equivalence Partitioning, [BVA] Boundary Value Analysis, [EG] Error Guessing
 */

import { describe, it, expect } from 'vitest';
import {
  extractMessageData,
  createWebSocket,
  CONNECTING,
  OPEN,
  CLOSING,
  CLOSED,
} from '../../src/client/WebSocketAdapter.js';
import type { WebSocketMessageEvent } from '../../src/client/WebSocketAdapter.js';

describe('WebSocketAdapter', () => {
  describe('extractMessageData', () => {
    // [EP] Valid: string data
    it('should extract string data from string message', () => {
      const event: WebSocketMessageEvent = { data: 'hello' };
      expect(extractMessageData(event)).toBe('hello');
    });

    // [EP] Valid: ArrayBuffer data
    it('should extract string data from ArrayBuffer message', () => {
      const encoder = new TextEncoder();
      const buffer = encoder.encode('hello').buffer;
      const event: WebSocketMessageEvent = { data: buffer as ArrayBuffer };
      expect(extractMessageData(event)).toBe('hello');
    });

    // [EP] Valid: Node.js Buffer data
    it('should extract string data from Node.js Buffer message', () => {
      const buf = Buffer.from('hello', 'utf-8');
      const event = { data: buf } as unknown as WebSocketMessageEvent;
      expect(extractMessageData(event)).toBe('hello');
    });

    // [EP] Invalid: Blob data throws error
    it('should throw for Blob messages', () => {
      const blob = new Blob(['hello']);
      const event = { data: blob } as unknown as WebSocketMessageEvent;
      expect(() => extractMessageData(event)).toThrow('Blob messages are not supported');
    });

    // [BVA] Empty string
    it('should return empty string for empty string data', () => {
      const event: WebSocketMessageEvent = { data: '' };
      expect(extractMessageData(event)).toBe('');
    });

    // [BVA] Empty ArrayBuffer
    it('should return empty string for empty ArrayBuffer', () => {
      const event: WebSocketMessageEvent = { data: new ArrayBuffer(0) };
      expect(extractMessageData(event)).toBe('');
    });

    // [BVA] Large ArrayBuffer
    it('should handle large ArrayBuffer message', () => {
      const text = 'A'.repeat(100000);
      const encoder = new TextEncoder();
      const buffer = encoder.encode(text).buffer;
      const event: WebSocketMessageEvent = { data: buffer as ArrayBuffer };
      expect(extractMessageData(event)).toBe(text);
    });

    // [EP] Valid: JSON relay message
    it('should correctly extract JSON relay message', () => {
      const json = '["EVENT","sub_1",{"id":"abc","kind":1}]';
      const event: WebSocketMessageEvent = { data: json };
      expect(extractMessageData(event)).toBe(json);
    });

    // [EP] Unicode content
    it('should handle unicode in ArrayBuffer', () => {
      const text = 'Hello \ud83c\udf0d \u4e16\u754c';
      const encoder = new TextEncoder();
      const buffer = encoder.encode(text).buffer;
      const event: WebSocketMessageEvent = { data: buffer as ArrayBuffer };
      expect(extractMessageData(event)).toBe(text);
    });
  });

  describe('ready state constants', () => {
    it('should have correct WebSocket ready state values', () => {
      expect(CONNECTING).toBe(0);
      expect(OPEN).toBe(1);
      expect(CLOSING).toBe(2);
      expect(CLOSED).toBe(3);
    });
  });

  describe('createWebSocket', () => {
    // [EP] Node.js environment uses ws package
    it('should return a WebSocket instance in Node.js environment', async () => {
      const ws = await createWebSocket('wss://relay.example.com');
      // Suppress async connection errors — no server is running
      ws.onerror = () => {};
      expect(ws).toBeDefined();
      expect(ws.readyState).toBeDefined();
    });
  });
});
