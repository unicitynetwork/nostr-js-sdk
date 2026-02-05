/**
 * Comprehensive tests for EventKinds helper functions
 * Covers isReplaceable, isEphemeral, isParameterizedReplaceable, getName
 * Techniques: [BVA] Boundary Value Analysis, [EP] Equivalence Partitioning
 */

import { describe, it, expect } from 'vitest';
import * as EventKinds from '../../src/protocol/EventKinds.js';

describe('EventKinds Helper Functions', () => {
  // ==========================================================
  // isReplaceable
  // ==========================================================
  describe('isReplaceable', () => {
    it('should return true for kind 0 (Profile)', () => {
      expect(EventKinds.isReplaceable(0)).toBe(true);
    });

    it('should return false for kind 1 (Text Note)', () => {
      expect(EventKinds.isReplaceable(1)).toBe(false);
    });

    it('should return false for kind 2', () => {
      expect(EventKinds.isReplaceable(2)).toBe(false);
    });

    it('should return true for kind 3 (Contacts)', () => {
      expect(EventKinds.isReplaceable(3)).toBe(true);
    });

    it('should return false for kind 4', () => {
      expect(EventKinds.isReplaceable(4)).toBe(false);
    });

    // Boundary: 9999 (just below range)
    it('should return false for kind 9999', () => {
      expect(EventKinds.isReplaceable(9999)).toBe(false);
    });

    // Boundary: 10000 (start of range)
    it('should return true for kind 10000', () => {
      expect(EventKinds.isReplaceable(10000)).toBe(true);
    });

    // Inside range
    it('should return true for kind 15000', () => {
      expect(EventKinds.isReplaceable(15000)).toBe(true);
    });

    // Boundary: 19999 (end of range)
    it('should return true for kind 19999', () => {
      expect(EventKinds.isReplaceable(19999)).toBe(true);
    });

    // Boundary: 20000 (just above range)
    it('should return false for kind 20000', () => {
      expect(EventKinds.isReplaceable(20000)).toBe(false);
    });
  });

  // ==========================================================
  // isEphemeral
  // ==========================================================
  describe('isEphemeral', () => {
    it('should return false for kind 0', () => {
      expect(EventKinds.isEphemeral(0)).toBe(false);
    });

    it('should return false for kind 1', () => {
      expect(EventKinds.isEphemeral(1)).toBe(false);
    });

    // Boundary: 19999 (just below range)
    it('should return false for kind 19999', () => {
      expect(EventKinds.isEphemeral(19999)).toBe(false);
    });

    // Boundary: 20000 (start of range)
    it('should return true for kind 20000', () => {
      expect(EventKinds.isEphemeral(20000)).toBe(true);
    });

    // AUTH is in ephemeral range
    it('should return true for AUTH kind (22242)', () => {
      expect(EventKinds.isEphemeral(EventKinds.AUTH)).toBe(true);
    });

    // Inside range
    it('should return true for kind 25000', () => {
      expect(EventKinds.isEphemeral(25000)).toBe(true);
    });

    // Boundary: 29999 (end of range)
    it('should return true for kind 29999', () => {
      expect(EventKinds.isEphemeral(29999)).toBe(true);
    });

    // Boundary: 30000 (just above range)
    it('should return false for kind 30000', () => {
      expect(EventKinds.isEphemeral(30000)).toBe(false);
    });
  });

  // ==========================================================
  // isParameterizedReplaceable
  // ==========================================================
  describe('isParameterizedReplaceable', () => {
    it('should return false for kind 0', () => {
      expect(EventKinds.isParameterizedReplaceable(0)).toBe(false);
    });

    it('should return false for kind 1', () => {
      expect(EventKinds.isParameterizedReplaceable(1)).toBe(false);
    });

    // Boundary: 29999 (just below range)
    it('should return false for kind 29999', () => {
      expect(EventKinds.isParameterizedReplaceable(29999)).toBe(false);
    });

    // Boundary: 30000 (start of range)
    it('should return true for kind 30000', () => {
      expect(EventKinds.isParameterizedReplaceable(30000)).toBe(true);
    });

    // APP_DATA is parameterized replaceable
    it('should return true for APP_DATA kind (30078)', () => {
      expect(EventKinds.isParameterizedReplaceable(EventKinds.APP_DATA)).toBe(true);
    });

    // TOKEN_TRANSFER is parameterized replaceable
    it('should return true for TOKEN_TRANSFER kind (31113)', () => {
      expect(EventKinds.isParameterizedReplaceable(EventKinds.TOKEN_TRANSFER)).toBe(true);
    });

    // Inside range
    it('should return true for kind 35000', () => {
      expect(EventKinds.isParameterizedReplaceable(35000)).toBe(true);
    });

    // Boundary: 39999 (end of range)
    it('should return true for kind 39999', () => {
      expect(EventKinds.isParameterizedReplaceable(39999)).toBe(true);
    });

    // Boundary: 40000 (just above range)
    it('should return false for kind 40000', () => {
      expect(EventKinds.isParameterizedReplaceable(40000)).toBe(false);
    });
  });

  // ==========================================================
  // getName
  // ==========================================================
  describe('getName', () => {
    it('should return "Profile" for kind 0', () => {
      expect(EventKinds.getName(0)).toBe('Profile');
    });

    it('should return "Text Note" for kind 1', () => {
      expect(EventKinds.getName(1)).toBe('Text Note');
    });

    it('should return "Recommend Relay" for kind 2', () => {
      expect(EventKinds.getName(2)).toBe('Recommend Relay');
    });

    it('should return "Contacts" for kind 3', () => {
      expect(EventKinds.getName(3)).toBe('Contacts');
    });

    it('should return "Encrypted DM" for kind 4', () => {
      expect(EventKinds.getName(4)).toBe('Encrypted DM');
    });

    it('should return "Deletion" for kind 5', () => {
      expect(EventKinds.getName(5)).toBe('Deletion');
    });

    it('should return "Reaction" for kind 7', () => {
      expect(EventKinds.getName(7)).toBe('Reaction');
    });

    it('should return "Seal" for kind 13', () => {
      expect(EventKinds.getName(13)).toBe('Seal');
    });

    it('should return "Chat Message" for kind 14', () => {
      expect(EventKinds.getName(14)).toBe('Chat Message');
    });

    it('should return "Read Receipt" for kind 15', () => {
      expect(EventKinds.getName(15)).toBe('Read Receipt');
    });

    it('should return "Gift Wrap" for kind 1059', () => {
      expect(EventKinds.getName(1059)).toBe('Gift Wrap');
    });

    it('should return "Relay List" for kind 10002', () => {
      expect(EventKinds.getName(10002)).toBe('Relay List');
    });

    it('should return "App Data" for kind 30078', () => {
      expect(EventKinds.getName(30078)).toBe('App Data');
    });

    it('should return "Token Transfer" for kind 31113', () => {
      expect(EventKinds.getName(31113)).toBe('Token Transfer');
    });

    it('should return "Payment Request" for kind 31115', () => {
      expect(EventKinds.getName(31115)).toBe('Payment Request');
    });

    it('should return "Payment Request Response" for kind 31116', () => {
      expect(EventKinds.getName(31116)).toBe('Payment Request Response');
    });

    // Unknown kinds should include classification
    it('should return "Replaceable (X)" for unknown replaceable kinds', () => {
      expect(EventKinds.getName(10500)).toBe('Replaceable (10500)');
    });

    it('should return "Ephemeral (X)" for unknown ephemeral kinds', () => {
      expect(EventKinds.getName(25000)).toBe('Ephemeral (25000)');
    });

    it('should return "Parameterized Replaceable (X)" for unknown parameterized kinds', () => {
      expect(EventKinds.getName(35000)).toBe('Parameterized Replaceable (35000)');
    });

    it('should return "Unknown (X)" for completely unknown kinds', () => {
      expect(EventKinds.getName(999)).toBe('Unknown (999)');
    });
  });

  // ==========================================================
  // Constants existence
  // ==========================================================
  describe('constants', () => {
    it('should have all standard NIP kinds defined', () => {
      expect(EventKinds.PROFILE).toBe(0);
      expect(EventKinds.TEXT_NOTE).toBe(1);
      expect(EventKinds.RECOMMEND_RELAY).toBe(2);
      expect(EventKinds.CONTACTS).toBe(3);
      expect(EventKinds.ENCRYPTED_DM).toBe(4);
      expect(EventKinds.DELETION).toBe(5);
      expect(EventKinds.REACTION).toBe(7);
      expect(EventKinds.SEAL).toBe(13);
      expect(EventKinds.CHAT_MESSAGE).toBe(14);
      expect(EventKinds.READ_RECEIPT).toBe(15);
      expect(EventKinds.GIFT_WRAP).toBe(1059);
      expect(EventKinds.RELAY_LIST).toBe(10002);
      expect(EventKinds.AUTH).toBe(22242);
      expect(EventKinds.APP_DATA).toBe(30078);
    });

    it('should have all Unicity custom kinds defined', () => {
      expect(EventKinds.AGENT_PROFILE).toBe(31111);
      expect(EventKinds.AGENT_LOCATION).toBe(31112);
      expect(EventKinds.TOKEN_TRANSFER).toBe(31113);
      expect(EventKinds.FILE_METADATA).toBe(31114);
      expect(EventKinds.PAYMENT_REQUEST).toBe(31115);
      expect(EventKinds.PAYMENT_REQUEST_RESPONSE).toBe(31116);
    });
  });
});
