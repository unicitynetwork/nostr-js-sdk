/**
 * Unit tests for EventKinds
 */

import { describe, it, expect } from 'vitest';
import * as EventKinds from '../../src/protocol/EventKinds.js';

describe('EventKinds', () => {
  describe('constants', () => {
    it('should define standard NIP kinds', () => {
      expect(EventKinds.PROFILE).toBe(0);
      expect(EventKinds.TEXT_NOTE).toBe(1);
      expect(EventKinds.RECOMMEND_RELAY).toBe(2);
      expect(EventKinds.CONTACTS).toBe(3);
      expect(EventKinds.ENCRYPTED_DM).toBe(4);
      expect(EventKinds.DELETION).toBe(5);
      expect(EventKinds.REACTION).toBe(7);
      expect(EventKinds.GIFT_WRAP).toBe(1059);
      expect(EventKinds.RELAY_LIST).toBe(10002);
      expect(EventKinds.AUTH).toBe(22242);
      expect(EventKinds.APP_DATA).toBe(30078);
    });

    it('should define Unicity custom kinds', () => {
      expect(EventKinds.AGENT_PROFILE).toBe(31111);
      expect(EventKinds.AGENT_LOCATION).toBe(31112);
      expect(EventKinds.TOKEN_TRANSFER).toBe(31113);
      expect(EventKinds.FILE_METADATA).toBe(31114);
    });
  });

  describe('isReplaceable', () => {
    it('should return true for replaceable kinds', () => {
      expect(EventKinds.isReplaceable(0)).toBe(true); // PROFILE
      expect(EventKinds.isReplaceable(3)).toBe(true); // CONTACTS
      expect(EventKinds.isReplaceable(10002)).toBe(true); // RELAY_LIST
      expect(EventKinds.isReplaceable(15000)).toBe(true); // In range
    });

    it('should return false for non-replaceable kinds', () => {
      expect(EventKinds.isReplaceable(1)).toBe(false); // TEXT_NOTE
      expect(EventKinds.isReplaceable(4)).toBe(false); // ENCRYPTED_DM
      expect(EventKinds.isReplaceable(20000)).toBe(false); // Ephemeral
      expect(EventKinds.isReplaceable(30078)).toBe(false); // Parameterized
    });
  });

  describe('isEphemeral', () => {
    it('should return true for ephemeral kinds', () => {
      expect(EventKinds.isEphemeral(20000)).toBe(true);
      expect(EventKinds.isEphemeral(25000)).toBe(true);
      expect(EventKinds.isEphemeral(29999)).toBe(true);
    });

    it('should return false for non-ephemeral kinds', () => {
      expect(EventKinds.isEphemeral(1)).toBe(false);
      expect(EventKinds.isEphemeral(10000)).toBe(false);
      expect(EventKinds.isEphemeral(30000)).toBe(false);
    });
  });

  describe('isParameterizedReplaceable', () => {
    it('should return true for parameterized replaceable kinds', () => {
      expect(EventKinds.isParameterizedReplaceable(30000)).toBe(true);
      expect(EventKinds.isParameterizedReplaceable(30078)).toBe(true); // APP_DATA
      expect(EventKinds.isParameterizedReplaceable(31113)).toBe(true); // TOKEN_TRANSFER
      expect(EventKinds.isParameterizedReplaceable(39999)).toBe(true);
    });

    it('should return false for non-parameterized kinds', () => {
      expect(EventKinds.isParameterizedReplaceable(1)).toBe(false);
      expect(EventKinds.isParameterizedReplaceable(10000)).toBe(false);
      expect(EventKinds.isParameterizedReplaceable(29999)).toBe(false);
      expect(EventKinds.isParameterizedReplaceable(40000)).toBe(false);
    });
  });

  describe('getName', () => {
    it('should return names for known kinds', () => {
      expect(EventKinds.getName(0)).toBe('Profile');
      expect(EventKinds.getName(1)).toBe('Text Note');
      expect(EventKinds.getName(4)).toBe('Encrypted DM');
      expect(EventKinds.getName(31113)).toBe('Token Transfer');
    });

    it('should return descriptive names for unknown kinds', () => {
      expect(EventKinds.getName(15000)).toBe('Replaceable (15000)');
      expect(EventKinds.getName(25000)).toBe('Ephemeral (25000)');
      expect(EventKinds.getName(35000)).toBe('Parameterized Replaceable (35000)');
      expect(EventKinds.getName(999999)).toBe('Unknown (999999)');
    });
  });
});
