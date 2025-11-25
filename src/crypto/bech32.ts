/**
 * Bech32 encoding/decoding for NIP-19 key formats (npub, nsec).
 * Implements the Bech32 specification for Nostr key encoding.
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

/**
 * Decoded Bech32 data structure
 */
export interface DecodedBech32 {
  /** Human-readable part (e.g., "npub", "nsec") */
  hrp: string;
  /** Decoded data bytes */
  data: Uint8Array;
}

/**
 * Compute the Bech32 polymod checksum
 */
function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) {
        chk ^= GENERATOR[i]!;
      }
    }
  }
  return chk;
}

/**
 * Expand the human-readable part for checksum computation
 */
function hrpExpand(hrp: string): number[] {
  const result: number[] = [];
  for (let i = 0; i < hrp.length; i++) {
    result.push(hrp.charCodeAt(i) >> 5);
  }
  result.push(0);
  for (let i = 0; i < hrp.length; i++) {
    result.push(hrp.charCodeAt(i) & 31);
  }
  return result;
}

/**
 * Verify the Bech32 checksum
 */
function verifyChecksum(hrp: string, data: number[]): boolean {
  return polymod(hrpExpand(hrp).concat(data)) === 1;
}

/**
 * Create the Bech32 checksum
 */
function createChecksum(hrp: string, data: number[]): number[] {
  const values = hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const mod = polymod(values) ^ 1;
  const result: number[] = [];
  for (let i = 0; i < 6; i++) {
    result.push((mod >> (5 * (5 - i))) & 31);
  }
  return result;
}

/**
 * Convert bits between different widths
 */
function convertBits(
  data: number[] | Uint8Array,
  fromBits: number,
  toBits: number,
  pad: boolean
): number[] | null {
  let acc = 0;
  let bits = 0;
  const result: number[] = [];
  const maxv = (1 << toBits) - 1;

  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) {
      return null;
    }
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >> bits) & maxv);
    }
  }

  if (pad) {
    if (bits > 0) {
      result.push((acc << (toBits - bits)) & maxv);
    }
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    return null;
  }

  return result;
}

/**
 * Encode data with Bech32 checksum
 * @param hrp Human-readable part (e.g., "npub", "nsec")
 * @param data Data bytes to encode
 * @returns Bech32-encoded string
 */
export function encode(hrp: string, data: Uint8Array): string {
  const values = convertBits(Array.from(data), 8, 5, true);
  if (values === null) {
    throw new Error('Failed to convert bits for Bech32 encoding');
  }

  const checksum = createChecksum(hrp, values);
  const combined = values.concat(checksum);

  let result = hrp + '1';
  for (const v of combined) {
    result += CHARSET.charAt(v);
  }

  return result;
}

/**
 * Decode a Bech32-encoded string
 * @param bech32String The Bech32 string to decode
 * @returns Decoded data with human-readable part
 */
export function decode(bech32String: string): DecodedBech32 {
  const str = bech32String.toLowerCase();

  // Find separator
  const pos = str.lastIndexOf('1');
  if (pos < 1 || pos + 7 > str.length || str.length > 90) {
    throw new Error('Invalid Bech32 string');
  }

  const hrp = str.slice(0, pos);
  const dataChars = str.slice(pos + 1);

  // Decode data characters
  const data: number[] = [];
  for (const char of dataChars) {
    const idx = CHARSET.indexOf(char);
    if (idx === -1) {
      throw new Error(`Invalid character '${char}' in Bech32 string`);
    }
    data.push(idx);
  }

  // Verify checksum
  if (!verifyChecksum(hrp, data)) {
    throw new Error('Invalid Bech32 checksum');
  }

  // Remove checksum and convert bits
  const dataWithoutChecksum = data.slice(0, -6);
  const converted = convertBits(dataWithoutChecksum, 5, 8, false);
  if (converted === null) {
    throw new Error('Failed to convert bits in Bech32 decoding');
  }

  return {
    hrp,
    data: new Uint8Array(converted),
  };
}

/**
 * Encode a public key as npub
 * @param publicKey 32-byte public key
 * @returns npub-encoded string
 */
export function encodeNpub(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error('Public key must be 32 bytes');
  }
  return encode('npub', publicKey);
}

/**
 * Decode an npub string to public key bytes
 * @param npub npub-encoded string
 * @returns 32-byte public key
 */
export function decodeNpub(npub: string): Uint8Array {
  const decoded = decode(npub);
  if (decoded.hrp !== 'npub') {
    throw new Error(`Expected 'npub' prefix, got '${decoded.hrp}'`);
  }
  if (decoded.data.length !== 32) {
    throw new Error(`Expected 32 bytes, got ${decoded.data.length}`);
  }
  return decoded.data;
}

/**
 * Encode a private key as nsec
 * @param privateKey 32-byte private key
 * @returns nsec-encoded string
 */
export function encodeNsec(privateKey: Uint8Array): string {
  if (privateKey.length !== 32) {
    throw new Error('Private key must be 32 bytes');
  }
  return encode('nsec', privateKey);
}

/**
 * Decode an nsec string to private key bytes
 * @param nsec nsec-encoded string
 * @returns 32-byte private key
 */
export function decodeNsec(nsec: string): Uint8Array {
  const decoded = decode(nsec);
  if (decoded.hrp !== 'nsec') {
    throw new Error(`Expected 'nsec' prefix, got '${decoded.hrp}'`);
  }
  if (decoded.data.length !== 32) {
    throw new Error(`Expected 32 bytes, got ${decoded.data.length}`);
  }
  return decoded.data;
}
