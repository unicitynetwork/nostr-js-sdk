/**
 * WebSocketAdapter - Cross-platform WebSocket implementation.
 * Provides a unified interface for WebSocket connections in Node.js and browsers.
 */

/**
 * WebSocket message event interface
 */
export interface WebSocketMessageEvent {
  data: string | ArrayBuffer | Blob;
}

/**
 * WebSocket close event interface
 */
export interface WebSocketCloseEvent {
  code: number;
  reason: string;
}

/**
 * WebSocket error event interface
 */
export interface WebSocketErrorEvent {
  message?: string;
  error?: Error;
}

/**
 * Unified WebSocket interface for cross-platform compatibility.
 */
export interface IWebSocket {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null;
  onclose: ((event: WebSocketCloseEvent) => void) | null;
  onerror: ((event: WebSocketErrorEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** WebSocket ready state constants */
export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

/**
 * Create a WebSocket connection that works in both Node.js and browsers.
 * @param url WebSocket URL (ws:// or wss://)
 * @returns WebSocket instance
 */
export async function createWebSocket(url: string): Promise<IWebSocket> {
  // Check if we're in a browser environment
  if (typeof WebSocket !== 'undefined') {
    return new WebSocket(url) as unknown as IWebSocket;
  }

  // Node.js environment - dynamically import ws
  try {
    const { default: WS } = await import('ws');
    return new WS(url) as unknown as IWebSocket;
  } catch {
    throw new Error(
      'WebSocket not available. In Node.js, install the "ws" package: npm install ws'
    );
  }
}

/**
 * Extract string data from WebSocket message event.
 * Handles different message types across platforms.
 * @param event WebSocket message event
 * @returns String message data
 */
export function extractMessageData(event: WebSocketMessageEvent): string {
  if (typeof event.data === 'string') {
    return event.data;
  }
  if (event.data instanceof ArrayBuffer) {
    return new TextDecoder().decode(event.data);
  }
  if (typeof Blob !== 'undefined' && event.data instanceof Blob) {
    // This shouldn't happen in normal Nostr relay communication
    throw new Error('Blob messages are not supported');
  }
  // Node.js Buffer case
  if (Buffer && Buffer.isBuffer(event.data)) {
    return (event.data as Buffer).toString('utf-8');
  }
  return String(event.data);
}
