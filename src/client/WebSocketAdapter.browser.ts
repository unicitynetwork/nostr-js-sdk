/**
 * WebSocketAdapter - Browser implementation.
 * Uses the native WebSocket API.
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
 * Create a WebSocket connection using native browser WebSocket.
 * @param url WebSocket URL (ws:// or wss://)
 * @returns WebSocket instance
 */
export async function createWebSocket(url: string): Promise<IWebSocket> {
  if (typeof WebSocket === 'undefined') {
    throw new Error('WebSocket not available in this environment');
  }
  return new WebSocket(url) as unknown as IWebSocket;
}

/**
 * Extract string data from WebSocket message event.
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
    throw new Error('Blob messages are not supported');
  }
  return String(event.data);
}
