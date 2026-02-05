# =============================================================================
# BDD TEST SCENARIOS FOR NOSTR-JS-SDK — MISSING COVERAGE
# =============================================================================
# Techniques applied per scenario are annotated with:
#   [EP] = Equivalence Partitioning
#   [BVA] = Boundary Value Analysis
#   [DT] = Decision Table Testing
#   [ST] = State Transition Testing
#   [UC] = Use Case Testing
#   [EG] = Error Guessing
#   [PW] = Pairwise/Combinatorial Testing
#   [SC] = Statement/Branch/Condition Coverage
#   [LC] = Loop Testing
#   [RB] = Risk-Based Testing
# =============================================================================


# =============================================================================
# FEATURE 1: NostrClient — Relay Connection Lifecycle
# =============================================================================

Feature: NostrClient relay connection lifecycle
  As a Nostr application developer
  I want the client to manage WebSocket connections to relays
  So that events can be published and received reliably

  Background:
    Given a NostrKeyManager with a generated key pair
    And a NostrClient created with that key manager

  # --- State Transition Testing [ST] ---
  # States: Created → Connecting → Connected → Disconnected → (terminal)
  #         Created → Connecting → Failed
  #         Connected → Reconnecting → Connected

  Scenario: Client starts in disconnected state
    Then the client should report isConnected as false
    And getConnectedRelays should return an empty set

  Scenario: Successful connection to a single relay
    Given a mock WebSocket that opens successfully
    When I connect to "wss://relay1.example.com"
    Then the client should report isConnected as true
    And getConnectedRelays should contain "wss://relay1.example.com"

  Scenario: Successful connection to multiple relays
    Given mock WebSockets that open successfully
    When I connect to "wss://relay1.example.com" and "wss://relay2.example.com"
    Then getConnectedRelays should contain both relay URLs
    And the client should report isConnected as true

  Scenario: Connection to already-connected relay is idempotent
    Given I am connected to "wss://relay1.example.com"
    When I connect to "wss://relay1.example.com" again
    Then the connection should succeed without creating a second socket
    And getConnectedRelays should contain exactly 1 entry

  Scenario: Connection timeout after 30 seconds
    Given a mock WebSocket that never fires onopen
    When I connect to "wss://slow-relay.example.com"
    And 30 seconds elapse without onopen
    Then the connect promise should reject with "timed out"

  # [BVA] — Connection timeout boundary
  Scenario: Connection succeeds just before timeout
    Given a mock WebSocket that opens at 29999ms
    When I connect to "wss://relay.example.com"
    Then the connect promise should resolve successfully

  Scenario: WebSocket creation fails
    Given createWebSocket rejects with "ECONNREFUSED"
    When I connect to "wss://down-relay.example.com"
    Then the connect promise should reject with an error

  Scenario: WebSocket fires onerror before onopen
    Given a mock WebSocket that fires onerror immediately
    When I connect to "wss://bad-relay.example.com"
    Then the connect promise should reject with "Failed to connect"

  # [ST] — Closed state is terminal
  Scenario: All operations reject after disconnect
    Given I am connected to "wss://relay.example.com"
    When I call disconnect
    Then calling connect should reject with "disconnected"
    And calling publishEvent should reject with "disconnected"
    And calling sendPrivateMessage should reject with "disconnected"
    And calling sendTokenTransfer should reject with "disconnected"
    And calling sendPaymentRequest should reject with "disconnected"

  # [EG] — Double disconnect
  Scenario: Calling disconnect multiple times does not throw
    When I call disconnect
    And I call disconnect again
    Then no error should be thrown


# =============================================================================
# FEATURE 2: NostrClient — Relay Message Handling
# =============================================================================

Feature: NostrClient relay message handling
  As a Nostr application developer
  I want the client to correctly parse and dispatch relay messages
  So that my subscriptions receive the right events

  Background:
    Given a connected NostrClient with a mock relay

  # --- Decision Table Testing [DT] ---
  # Message Type | Array Length | Subscription Exists | Expected Behavior
  # EVENT        | >= 3         | yes                 | Parse event, call onEvent
  # EVENT        | >= 3         | no                  | Ignore silently
  # EVENT        | < 3          | any                 | Ignore silently
  # OK           | >= 4         | pending exists      | Resolve/reject pending promise
  # OK           | < 4          | any                 | Ignore silently
  # EOSE         | >= 2         | yes with callback   | Call onEndOfStoredEvents
  # EOSE         | >= 2         | no callback          | Ignore silently
  # NOTICE       | >= 2         | any                 | Log warning
  # CLOSED       | >= 3         | yes with onError    | Call onError
  # AUTH         | >= 2         | any                 | Send AUTH event, resubscribe
  # (unknown)    | any          | any                 | Ignore silently
  # (malformed)  | any          | any                 | Ignore silently

  Scenario: Receiving EVENT message dispatches to correct subscription listener
    Given I have an active subscription "sub_1" with a listener
    When the relay sends '["EVENT", "sub_1", {"id":"abc","pubkey":"...","kind":1,"content":"hello","tags":[],"created_at":1000,"sig":"..."}]'
    Then the listener's onEvent should be called with the parsed Event
    And the event content should be "hello"

  Scenario: EVENT for unknown subscription is silently ignored
    When the relay sends '["EVENT", "unknown_sub", {"id":"abc","pubkey":"...","kind":1,"content":"test","tags":[],"created_at":1000,"sig":"..."}]'
    Then no error should be thrown
    And no listener should be called

  # [BVA] — Minimum valid array length for EVENT
  Scenario: EVENT message with fewer than 3 elements is ignored
    When the relay sends '["EVENT", "sub_1"]'
    Then no listener should be called

  Scenario: OK message resolves pending publish (accepted)
    Given I published an event with id "event123" that is awaiting OK
    When the relay sends '["OK", "event123", true, ""]'
    Then the publish promise should resolve with "event123"

  Scenario: OK message rejects pending publish (rejected)
    Given I published an event with id "event123" that is awaiting OK
    When the relay sends '["OK", "event123", false, "blocked: rate limit exceeded"]'
    Then the publish promise should reject with "Event rejected: blocked: rate limit exceeded"

  # [BVA] — OK message with fewer than 4 elements
  Scenario: OK message with insufficient elements is ignored
    Given I published an event with id "event123" that is awaiting OK
    When the relay sends '["OK", "event123", true]'
    Then the pending promise should remain unresolved

  Scenario: EOSE triggers onEndOfStoredEvents callback
    Given I have an active subscription "sub_1" with an onEndOfStoredEvents callback
    When the relay sends '["EOSE", "sub_1"]'
    Then onEndOfStoredEvents should be called with "sub_1"

  Scenario: EOSE for subscription without onEndOfStoredEvents is handled gracefully
    Given I have an active subscription "sub_1" with only onEvent
    When the relay sends '["EOSE", "sub_1"]'
    Then no error should be thrown

  Scenario: CLOSED message triggers onError callback
    Given I have an active subscription "sub_1" with an onError callback
    When the relay sends '["CLOSED", "sub_1", "auth-required: must authenticate"]'
    Then onError should be called with "sub_1" and message containing "auth-required"

  Scenario: NOTICE message is logged as warning
    When the relay sends '["NOTICE", "rate-limited: slow down"]'
    Then a console warning should be emitted with "rate-limited: slow down"

  Scenario: AUTH message triggers NIP-42 authentication flow
    When the relay sends '["AUTH", "challenge-string-abc"]'
    Then the client should send an AUTH event with kind 22242
    And the AUTH event should contain a "relay" tag with the relay URL
    And the AUTH event should contain a "challenge" tag with "challenge-string-abc"
    And all subscriptions should be resubscribed after a 100ms delay

  # [EG] — Malformed and garbage messages
  Scenario: Malformed JSON message is silently ignored
    When the relay sends "this is not JSON"
    Then no error should be thrown

  Scenario: Non-array JSON message is silently ignored
    When the relay sends '{"type": "EVENT"}'
    Then no error should be thrown

  Scenario: Empty array message is silently ignored
    When the relay sends '[]'
    Then no error should be thrown

  Scenario: Single-element array message is silently ignored
    When the relay sends '["EVENT"]'
    Then no error should be thrown

  Scenario: Unknown message type is silently ignored
    When the relay sends '["UNKNOWN_TYPE", "data"]'
    Then no error should be thrown

  # [EG] — Invalid event data in EVENT message
  Scenario: EVENT message with invalid event JSON is silently ignored
    Given I have an active subscription "sub_1" with a listener
    When the relay sends '["EVENT", "sub_1", {"invalid": "event"}]'
    Then the listener's onEvent should NOT be called

  # [SC] — Branch: lastPongTime update on any message
  Scenario: Any relay message updates the lastPongTime
    Given the relay last-pong time was 60 seconds ago
    When the relay sends '["NOTICE", "hello"]'
    Then the relay last-pong time should be updated to now


# =============================================================================
# FEATURE 3: NostrClient — Event Publishing
# =============================================================================

Feature: NostrClient event publishing
  As a Nostr application developer
  I want to publish events to connected relays
  So that other users can receive them

  Background:
    Given a NostrKeyManager with a generated key pair
    And a NostrClient created with that key manager

  # --- Equivalence Partitioning [EP] ---
  # Valid: connected to 1+ relays, event is well-formed
  # Invalid: not connected, client disconnected

  Scenario: Publishing event broadcasts to all connected relays
    Given I am connected to "wss://relay1.example.com" and "wss://relay2.example.com"
    When I publish a text note event with content "Hello Nostr"
    Then the event should be sent to both relays as '["EVENT", ...]'
    And the publish promise should eventually resolve with the event ID

  Scenario: Publishing event broadcasts only to connected relays (skips disconnected)
    Given I am connected to "wss://relay1.example.com"
    And "wss://relay2.example.com" has a disconnected socket
    When I publish a text note event
    Then the event should be sent only to relay1

  # [ST] — Offline queuing
  Scenario: Publishing when not connected queues the event
    Given I am not connected to any relay
    When I publish a text note event
    Then the event should be queued
    And the publish promise should remain pending

  Scenario: Queued events are flushed upon connection
    Given I published 3 events while offline (queued)
    When I connect to "wss://relay.example.com"
    Then all 3 queued events should be broadcast to the relay
    And all 3 publish promises should resolve

  Scenario: Queued events are rejected on disconnect
    Given I published 2 events while offline (queued)
    When I call disconnect
    Then both publish promises should reject with "Client disconnected"

  # [BVA] — OK timeout behavior (5 second timeout)
  Scenario: Publish resolves after 5 seconds even without OK response
    Given I am connected to "wss://relay.example.com"
    When I publish a text note event
    And the relay never sends an OK response
    And 5 seconds elapse
    Then the publish promise should resolve with the event ID (optimistic)

  Scenario: OK response clears the pending timeout
    Given I am connected to "wss://relay.example.com"
    When I publish a text note event
    And the relay sends OK accepted immediately
    Then the publish promise should resolve with the event ID
    And the pending OK timer should be cleared

  # [EP] — Publishing specific event types through convenience methods
  Scenario: Publishing an encrypted direct message (NIP-04)
    Given I am connected to "wss://relay.example.com"
    And a recipient key pair
    When I call publishEncryptedMessage with recipient pubkey and "secret"
    Then the published event kind should be 4
    And the event should have a "p" tag with the recipient pubkey
    And the content should be NIP-04 encrypted

  Scenario: Publishing a nametag binding
    Given I am connected to "wss://relay.example.com"
    When I call publishNametagBinding with "alice" and an address
    Then the published event should be a kind 30078 event
    And publishNametagBinding should return true

  Scenario: publishNametagBinding returns false on publish failure
    Given I am connected to "wss://relay.example.com"
    And the relay rejects all events
    When I call publishNametagBinding with "alice" and an address
    Then publishNametagBinding should return false

  Scenario: createAndPublishEvent creates and publishes a signed event
    Given I am connected to "wss://relay.example.com"
    When I call createAndPublishEvent with kind 1 and content "test"
    Then the published event should be signed by my key
    And the publish promise should resolve with the event ID


# =============================================================================
# FEATURE 4: NostrClient — Subscriptions
# =============================================================================

Feature: NostrClient subscription management
  As a Nostr application developer
  I want to subscribe to events matching filters
  So that I can receive real-time updates from relays

  Background:
    Given a connected NostrClient with a mock relay

  # --- Equivalence Partitioning [EP] ---
  # Valid: auto-generated ID, custom ID
  # Invalid: unsubscribe non-existent ID

  Scenario: Subscribe with auto-generated ID
    When I subscribe with a filter for kind 1 events
    Then the subscription ID should match pattern "sub_\d+"
    And a REQ message should be sent to the relay

  Scenario: Subscribe with custom ID
    When I subscribe with ID "my-custom-sub" and a filter for kind 1 events
    Then the subscription ID should be "my-custom-sub"
    And a REQ message with ID "my-custom-sub" should be sent to the relay

  Scenario: Auto-generated IDs are sequential
    When I create 3 subscriptions
    Then the IDs should be "sub_1", "sub_2", "sub_3"

  Scenario: Subscribe sends REQ to all connected relays
    Given I am connected to 3 relays
    When I subscribe with a filter
    Then each relay should receive a REQ message

  Scenario: Subscribe while not connected stores subscription locally
    Given I am not connected to any relay
    When I subscribe with a filter for kind 1 events
    Then the subscription should be stored
    And no REQ message should be sent (no connected relays)

  # [ST] — Stored subscriptions re-established on connect
  Scenario: Subscriptions are re-established after reconnection
    Given I have subscriptions "sub_1" and "sub_2" before reconnection
    When the relay reconnects
    Then both subscriptions should be sent as REQ messages to the relay

  Scenario: Unsubscribe sends CLOSE to all connected relays
    Given I have an active subscription "sub_1"
    When I unsubscribe from "sub_1"
    Then a CLOSE message for "sub_1" should be sent to all relays
    And the subscription should be removed from internal tracking

  Scenario: Unsubscribe with unknown ID does nothing
    When I unsubscribe from "non_existent_sub"
    Then no CLOSE message should be sent
    And no error should be thrown

  # [LC] — Loop: multiple subscriptions concurrently
  Scenario: Managing 100 concurrent subscriptions
    When I create 100 subscriptions with different filters
    Then all 100 should be stored internally
    And all 100 REQ messages should be sent to the relay
    When I unsubscribe from all 100
    Then all 100 CLOSE messages should be sent
    And no subscriptions should remain


# =============================================================================
# FEATURE 5: NostrClient — Reconnection & Health
# =============================================================================

Feature: NostrClient automatic reconnection
  As a Nostr application developer
  I want the client to automatically reconnect on connection loss
  So that the application remains resilient to network issues

  Background:
    Given a NostrKeyManager with a generated key pair

  # --- State Transition Testing [ST] ---
  # Connected → socket.onclose → scheduleReconnect → Reconnecting → connectToRelay → Connected
  # Connected → socket.onclose → (autoReconnect=false) → stays Disconnected

  Scenario: Auto-reconnect after connection loss
    Given a NostrClient with autoReconnect enabled (default)
    And I am connected to "wss://relay.example.com"
    When the WebSocket fires onclose
    Then the client should emit a "disconnect" event
    And the client should schedule a reconnection attempt

  Scenario: No auto-reconnect when disabled
    Given a NostrClient with autoReconnect set to false
    And I am connected to "wss://relay.example.com"
    When the WebSocket fires onclose
    Then the client should emit a "disconnect" event
    And the client should NOT schedule a reconnection attempt

  # [BVA] — Exponential backoff boundaries
  Scenario Outline: Exponential backoff delay calculation
    Given reconnectIntervalMs is <base> and maxReconnectIntervalMs is <max>
    When reconnect attempt <attempt> is scheduled
    Then the delay should be <expected_delay> ms

    Examples:
      | base | max   | attempt | expected_delay |
      | 1000 | 30000 | 1       | 1000           |
      | 1000 | 30000 | 2       | 2000           |
      | 1000 | 30000 | 3       | 4000           |
      | 1000 | 30000 | 4       | 8000           |
      | 1000 | 30000 | 5       | 16000          |
      | 1000 | 30000 | 6       | 30000          |
      | 1000 | 30000 | 100     | 30000          |
      | 500  | 10000 | 1       | 500            |
      | 500  | 10000 | 5       | 8000           |
      | 500  | 10000 | 6       | 10000          |

  Scenario: Reconnection resets attempt counter on success
    Given I am reconnecting after 5 failed attempts
    When the reconnection succeeds
    Then the reconnect attempt counter should reset to 0

  Scenario: Reconnection emits "reconnected" event (not "connect")
    Given I was previously connected to "wss://relay.example.com"
    When the client successfully reconnects
    Then the "reconnected" event should be emitted (not "connect")

  Scenario: First connection emits "connect" event
    When I connect to "wss://relay.example.com" for the first time
    Then the "connect" event should be emitted

  # --- Connection Event Listeners [DT] ---
  # Listener has | Event Type    | Expected callback
  # onConnect    | connect       | onConnect called
  # onConnect    | disconnect    | nothing (no onDisconnect)
  # all methods  | reconnecting  | onReconnecting called with attempt number
  # all methods  | reconnected   | onReconnected called

  Scenario: Connection listener errors are swallowed
    Given a connection listener whose onConnect throws an exception
    When the client connects to a relay
    Then the connection should succeed
    And the error from the listener should be swallowed

  # --- Ping/Health Check [ST][BVA] ---
  Scenario: Ping sends subscription request as health check
    Given I am connected with pingIntervalMs set to 30000
    When 30 seconds elapse
    Then the client should send a CLOSE "ping" then REQ "ping" with limit:1

  Scenario: Stale connection is force-closed after 2x ping interval
    Given I am connected with pingIntervalMs set to 30000
    And the relay has not sent any message for 61 seconds
    When the next ping check runs
    Then the socket should be force-closed
    And reconnection should be triggered

  # [BVA] — Exactly at the stale threshold
  Scenario: Connection at exactly 2x ping interval is not considered stale
    Given I am connected with pingIntervalMs set to 30000
    And the relay last message was exactly 60000ms ago
    When the next ping check runs
    Then the connection should NOT be force-closed

  Scenario: Ping disabled when pingIntervalMs is 0
    Given a NostrClient with pingIntervalMs set to 0
    When I connect to a relay
    Then no ping timer should be started

  Scenario: Ping timer is stopped on disconnect
    Given I am connected with active ping timer
    When the WebSocket fires onclose
    Then the ping timer should be cleared

  Scenario: Ping send failure triggers reconnect
    Given I am connected to a relay
    And the socket.send throws an error
    When the ping check runs
    Then the socket should be force-closed


# =============================================================================
# FEATURE 6: NostrClient — NIP-17 Private Messaging
# =============================================================================

Feature: NostrClient NIP-17 private message integration
  As a Nostr application user
  I want to send and receive private messages via the client
  So that my communication is end-to-end encrypted with sender anonymity

  Background:
    Given a connected NostrClient "Alice" with a mock relay
    And a separate NostrKeyManager "Bob"

  # --- Use Case Testing [UC] ---

  Scenario: Send a private message via gift-wrapping
    When Alice sends a private message "Hello Bob" to Bob's pubkey
    Then a kind 1059 (gift wrap) event should be published
    And the gift wrap's "p" tag should contain Bob's pubkey
    And the gift wrap should be signed by an ephemeral key (not Alice's)

  Scenario: Send a private message to a nametag (resolved via relay)
    Given Bob has a nametag binding "bob123" published on the relay
    When Alice sends a private message to nametag "bob123"
    Then the client should first query the relay for "bob123"
    And then send a gift-wrapped message to Bob's resolved pubkey

  Scenario: Send private message to unknown nametag fails
    Given no nametag binding exists for "unknown-user"
    When Alice sends a private message to nametag "unknown-user"
    Then the promise should reject with "Nametag not found: unknown-user"

  Scenario: Send a read receipt
    When Alice sends a read receipt to Bob for message "event-id-123"
    Then a kind 1059 (gift wrap) event should be published
    And the inner rumor should be kind 15 (read receipt)

  Scenario: Unwrap a received gift-wrapped message
    Given a gift-wrapped message from Bob to Alice
    When Alice calls unwrapPrivateMessage
    Then the result should contain Bob's pubkey as sender
    And the result should contain the decrypted message content

  # [EG] — Reply message
  Scenario: Send a reply to a previous message
    When Alice sends a private message "reply text" to Bob with replyToEventId "prev-event-id"
    Then the inner rumor should have an "e" tag with "prev-event-id"


# =============================================================================
# FEATURE 7: NostrClient — Token Transfer & Payment via Client
# =============================================================================

Feature: NostrClient token transfer and payment request delegation
  As a Nostr application developer
  I want convenience methods on the client for transfers and payments
  So that I don't have to construct protocol events manually

  Background:
    Given a connected NostrClient with a mock relay

  # --- Use Case Testing [UC] ---

  Scenario: Send token transfer
    When I call sendTokenTransfer with recipient pubkey and token JSON '{"id":"tok1"}'
    Then a kind 31113 event should be published
    And the content should be NIP-04 encrypted

  Scenario: Send token transfer with amount and symbol
    When I call sendTokenTransfer with options amount=100 and symbol="ALPHA"
    Then the published event should have an "amount" tag with "100"
    And the published event should have a "symbol" tag with "ALPHA"

  Scenario: Send token transfer as reply to payment request
    When I call sendTokenTransfer with replyToEventId "req-event-id"
    Then the published event should have an "e" tag with "req-event-id"

  Scenario: Send payment request
    When I call sendPaymentRequest with target pubkey and amount 1000000000n and coinId "0x01"
    Then a kind 31115 event should be published

  Scenario: Send payment request decline
    When I call sendPaymentRequestDecline with original sender pubkey, eventId, and requestId
    Then a kind 31116 response event should be published
    And the response status should be "DECLINED"

  Scenario: Send payment request response with EXPIRED status
    When I call sendPaymentRequestResponse with status "EXPIRED"
    Then the response status should be "EXPIRED"


# =============================================================================
# FEATURE 8: NostrClient — Nametag Query
# =============================================================================

Feature: NostrClient nametag query
  As a Nostr application developer
  I want to look up public keys by nametag
  So that I can address users by human-readable identifiers

  Background:
    Given a connected NostrClient with a mock relay

  # --- State Transition Testing [ST] ---
  # Query states: Pending → (receive events) → EOSE → Resolved
  # Query states: Pending → (timeout) → Resolved(null)

  Scenario: Query resolves with pubkey on EOSE
    Given a nametag binding event for "alice" with pubkey "abc123" exists on the relay
    When I call queryPubkeyByNametag("alice")
    And the relay sends the binding event followed by EOSE
    Then the promise should resolve with "abc123"

  Scenario: Query resolves with null when no binding exists
    When I call queryPubkeyByNametag("nobody")
    And the relay sends EOSE with no events
    Then the promise should resolve with null

  Scenario: Query returns most recent binding when multiple exist
    Given two nametag binding events for "alice":
      | pubkey | created_at |
      | old123 | 1000       |
      | new456 | 2000       |
    When I call queryPubkeyByNametag("alice")
    And the relay sends both events followed by EOSE
    Then the promise should resolve with "new456"

  # [BVA] — Query timeout
  Scenario: Query times out and resolves with null
    Given queryTimeoutMs is 5000
    When I call queryPubkeyByNametag("slow-lookup")
    And 5 seconds elapse without EOSE
    Then the promise should resolve with null
    And the subscription should be cleaned up

  Scenario: Query timeout respects custom timeout value
    Given queryTimeoutMs is set to 1000
    When I call queryPubkeyByNametag("test")
    And 1 second elapses without EOSE
    Then the promise should resolve with null


# =============================================================================
# FEATURE 9: NostrClient — Disconnect Cleanup
# =============================================================================

Feature: NostrClient disconnect cleanup
  As a Nostr application developer
  I want disconnect to clean up all resources
  So that there are no resource leaks or dangling promises

  Background:
    Given a NostrClient connected to 2 relays with active subscriptions

  # --- Risk-Based Testing [RB] ---

  Scenario: Disconnect clears all pending OK promises
    Given I have 3 pending OK acknowledgments
    When I call disconnect
    Then all 3 pending promises should reject with "Client disconnected"
    And the pendingOks map should be empty

  Scenario: Disconnect rejects all queued events
    Given I have 2 events queued for offline delivery
    When I call disconnect
    Then both queued event promises should reject with "Client disconnected"
    And the event queue should be empty

  Scenario: Disconnect closes all WebSocket connections
    When I call disconnect
    Then socket.close(1000, "Client disconnected") should be called for each relay
    And each relay should receive a "disconnect" event emission

  Scenario: Disconnect clears all timers
    Given relay1 has an active ping timer
    And relay2 has an active reconnect timer
    When I call disconnect
    Then both timers should be cleared

  Scenario: Disconnect clears all subscriptions
    Given I have 5 active subscriptions
    When I call disconnect
    Then the subscriptions map should be empty

  Scenario: Disconnect clears relay map
    When I call disconnect
    Then the relays map should be empty


# =============================================================================
# FEATURE 10: WebSocketAdapter — Message Extraction
# =============================================================================

Feature: WebSocket message data extraction
  As the NostrClient internals
  I want to extract string data from various WebSocket message formats
  So that relay messages can be parsed regardless of platform

  # --- Equivalence Partitioning [EP] ---
  # Valid partitions: string data, ArrayBuffer data, Node.js Buffer data
  # Invalid partitions: Blob data, unknown type

  Scenario: Extract string data from string message
    Given a WebSocket message event with data "hello"
    When I call extractMessageData
    Then the result should be "hello"

  Scenario: Extract string data from ArrayBuffer message
    Given a WebSocket message event with data as ArrayBuffer of "hello"
    When I call extractMessageData
    Then the result should be "hello"

  Scenario: Extract string data from Node.js Buffer message
    Given a WebSocket message event with data as Buffer of "hello"
    When I call extractMessageData
    Then the result should be "hello"

  Scenario: Blob message throws an error
    Given a WebSocket message event with Blob data
    When I call extractMessageData
    Then it should throw "Blob messages are not supported"

  # [EG] — Unusual data types
  Scenario: Numeric data is converted to string
    Given a WebSocket message event with data as number 42
    When I call extractMessageData
    Then the result should be "42"

  # [BVA] — Empty string
  Scenario: Empty string data returns empty string
    Given a WebSocket message event with data ""
    When I call extractMessageData
    Then the result should be ""

  # [BVA] — Large message
  Scenario: Very large ArrayBuffer message is extracted correctly
    Given a WebSocket message event with a 1MB ArrayBuffer of repeated text
    When I call extractMessageData
    Then the result should be the full decoded text

  # [PW] — Platform combinations
  Scenario: createWebSocket uses native WebSocket in browser environment
    Given the global WebSocket constructor is available
    When I call createWebSocket("wss://relay.example.com")
    Then it should return a native WebSocket instance

  Scenario: createWebSocket uses ws package in Node.js environment
    Given the global WebSocket constructor is NOT available
    And the "ws" package is importable
    When I call createWebSocket("wss://relay.example.com")
    Then it should return a ws WebSocket instance

  Scenario: createWebSocket throws when no WebSocket is available
    Given the global WebSocket constructor is NOT available
    And the "ws" package import fails
    When I call createWebSocket("wss://relay.example.com")
    Then it should throw 'WebSocket not available. In Node.js, install the "ws" package'


# =============================================================================
# FEATURE 11: NostrKeyManager — NIP-44 Encryption Methods
# =============================================================================

Feature: NostrKeyManager NIP-44 encryption
  As a Nostr application developer
  I want to use NIP-44 encryption through the KeyManager
  So that I can use modern XChaCha20-Poly1305 encryption without raw key handling

  Background:
    Given a NostrKeyManager "Alice" with a generated key pair
    And a NostrKeyManager "Bob" with a generated key pair

  # --- Equivalence Partitioning [EP] ---
  # Valid: normal message, unicode, long message
  # Invalid: cleared key manager, empty message

  Scenario: Encrypt and decrypt a message with NIP-44 (bytes keys)
    When Alice encrypts "Hello Bob" with NIP-44 using Bob's public key bytes
    And Bob decrypts the result with NIP-44 using Alice's public key bytes
    Then the decrypted message should be "Hello Bob"

  Scenario: Encrypt and decrypt a message with NIP-44 (hex keys)
    When Alice encrypts "Hello Bob" with encryptNip44Hex using Bob's public key hex
    And Bob decrypts the result with decryptNip44Hex using Alice's public key hex
    Then the decrypted message should be "Hello Bob"

  Scenario: NIP-44 encryption produces different ciphertext each time
    When Alice encrypts "same message" with NIP-44 twice
    Then the two ciphertexts should be different (random nonce)

  Scenario: NIP-44 encryption with unicode content
    When Alice encrypts "Привіт 🌍 مرحبا" with NIP-44 using Bob's public key
    And Bob decrypts the result
    Then the decrypted message should be "Привіт 🌍 مرحبا"

  # [BVA] — Message length boundaries
  Scenario: NIP-44 encryption of 1-byte message
    When Alice encrypts "x" with NIP-44 using Bob's public key
    And Bob decrypts the result
    Then the decrypted message should be "x"

  Scenario: NIP-44 encryption of maximum-length message (65535 bytes)
    Given a message of exactly 65535 bytes
    When Alice encrypts it with NIP-44 using Bob's public key
    And Bob decrypts the result
    Then the decrypted message should match the original

  Scenario: NIP-44 encryption of message exceeding max length rejects
    Given a message of 65536 bytes
    When Alice tries to encrypt it with NIP-44
    Then it should throw "Message too long"

  # [EP] — Wrong key decryption
  Scenario: Decrypting with wrong key fails
    Given a third NostrKeyManager "Eve"
    When Alice encrypts "secret" with NIP-44 for Bob
    And Eve tries to decrypt the result using Alice's public key
    Then it should throw an error (authentication failure)

  # [ST] — Cleared key manager
  Scenario: NIP-44 encryption fails after key manager is cleared
    When Alice's key manager is cleared
    Then calling encryptNip44 should throw "KeyManager has been cleared"
    And calling decryptNip44 should throw "KeyManager has been cleared"
    And calling encryptNip44Hex should throw "KeyManager has been cleared"
    And calling decryptNip44Hex should throw "KeyManager has been cleared"
    And calling deriveConversationKey should throw "KeyManager has been cleared"

  # --- Conversation Key Derivation ---

  Scenario: Derive conversation key produces consistent result
    When Alice derives a conversation key with Bob's public key
    And Alice derives the conversation key again with Bob's public key
    Then both keys should be identical

  Scenario: Conversation key is symmetric (A→B equals B→A)
    When Alice derives a conversation key with Bob's public key
    And Bob derives a conversation key with Alice's public key
    Then both conversation keys should be identical

  Scenario: Different key pairs produce different conversation keys
    Given a third NostrKeyManager "Charlie"
    When Alice derives conversation key with Bob
    And Alice derives conversation key with Charlie
    Then the two conversation keys should differ


# =============================================================================
# FEATURE 12: CallbackEventListener
# =============================================================================

Feature: CallbackEventListener
  As a developer
  I want a convenience class for creating event listeners from callbacks
  So that I can use inline functions instead of implementing the full interface

  # --- Equivalence Partitioning [EP] ---

  Scenario: onEvent callback is invoked
    Given a CallbackEventListener with an onEvent callback
    When onEvent is called with an Event
    Then the callback should receive the event

  Scenario: onEndOfStoredEvents callback is invoked when provided
    Given a CallbackEventListener with onEvent and onEndOfStoredEvents callbacks
    When onEndOfStoredEvents is called with "sub_1"
    Then the EOSE callback should receive "sub_1"

  Scenario: onEndOfStoredEvents does not throw when not provided
    Given a CallbackEventListener with only an onEvent callback
    When onEndOfStoredEvents is called with "sub_1"
    Then no error should be thrown

  Scenario: onError callback is invoked when provided
    Given a CallbackEventListener with all three callbacks
    When onError is called with "sub_1" and "connection lost"
    Then the error callback should receive "sub_1" and "connection lost"

  Scenario: onError does not throw when not provided
    Given a CallbackEventListener with only an onEvent callback
    When onError is called with "sub_1" and "error"
    Then no error should be thrown


# =============================================================================
# FEATURE 13: Edge Cases — NIP-04 Corrupted Data
# =============================================================================

Feature: NIP-04 corrupted and malformed data handling
  As the encryption layer
  I want to handle corrupted inputs gracefully
  So that the application doesn't crash on bad data

  # --- Error Guessing [EG] ---

  Scenario: Decrypt with corrupted base64 ciphertext
    Given an encrypted NIP-04 message
    When I corrupt the base64 ciphertext portion
    And I attempt to decrypt
    Then it should throw an error (decryption failure)

  Scenario: Decrypt with corrupted IV
    Given an encrypted NIP-04 message
    When I corrupt the IV portion
    And I attempt to decrypt
    Then it should throw an error

  Scenario: Decrypt with missing IV separator
    When I attempt to decrypt "justbase64withoutiv"
    Then it should throw an error about invalid format

  Scenario: Decrypt with empty ciphertext
    When I attempt to decrypt "?iv=aGVsbG8="
    Then it should throw an error

  Scenario: Decrypt compressed message with corrupted GZIP data
    When I attempt to decrypt "gz:invalidbase64data?iv=aGVsbG8="
    Then it should throw an error

  Scenario: Decrypt message with truncated ciphertext
    Given an encrypted NIP-04 message
    When I truncate the ciphertext to half its length
    And I attempt to decrypt
    Then it should throw an error


# =============================================================================
# FEATURE 14: Edge Cases — NIP-44 Corrupted Data
# =============================================================================

Feature: NIP-44 corrupted and malformed data handling
  As the encryption layer
  I want to handle corrupted NIP-44 inputs gracefully
  So that authentication failures are caught

  # --- Error Guessing [EG] ---

  Scenario: Decrypt with corrupted base64 payload
    Given a valid NIP-44 encrypted message
    When I corrupt a byte in the ciphertext portion
    And I attempt to decrypt
    Then it should throw an error (authentication failure / Poly1305 MAC mismatch)

  Scenario: Decrypt with wrong version byte
    Given a NIP-44 payload with version byte 0x01 instead of 0x02
    When I attempt to decrypt
    Then it should throw "Unsupported NIP-44 version: 1"

  Scenario: Decrypt with version byte 0x00
    Given a NIP-44 payload with version byte 0x00
    When I attempt to decrypt
    Then it should throw "Unsupported NIP-44 version: 0"

  # [BVA] — Payload too short
  Scenario: Decrypt with payload shorter than minimum
    Given a base64 payload of only 10 bytes
    When I attempt to decrypt with NIP-44
    Then it should throw "Payload too short"

  Scenario: Decrypt with exactly minimum valid payload length
    Given a base64 payload of exactly 1 + 24 + 32 + 16 = 73 bytes (but invalid crypto)
    When I attempt to decrypt with NIP-44
    Then it should throw an error (crypto failure, not "too short")

  Scenario: Decrypt with truncated nonce
    Given a NIP-44 payload with correct version but only 10 bytes of nonce
    When I attempt to decrypt
    Then it should throw "Payload too short"


# =============================================================================
# FEATURE 15: Edge Cases — NIP-44 Padding
# =============================================================================

Feature: NIP-44 padding edge cases
  As the encryption layer
  I want padding to work correctly at all boundary values
  So that message lengths are properly hidden

  # --- Boundary Value Analysis [BVA] ---

  Scenario Outline: calcPaddedLen returns correct padded length
    When I calculate padded length for <input_len>
    Then the result should be <expected>

    Examples:
      | input_len | expected |
      | 1         | 32       |
      | 31        | 32       |
      | 32        | 32       |
      | 33        | 64       |
      | 37        | 40       |
      | 63        | 64       |
      | 64        | 64       |
      | 65        | 80       |
      | 100       | 112      |
      | 255       | 256      |
      | 256       | 256      |
      | 257       | 320      |
      | 1000      | 1024     |
      | 65535     | 65536    |

  # [BVA] — Invalid inputs
  Scenario: calcPaddedLen rejects zero length
    When I call calcPaddedLen(0)
    Then it should throw "Message too short"

  Scenario: calcPaddedLen rejects negative length
    When I call calcPaddedLen(-1)
    Then it should throw "Message too short"

  Scenario: calcPaddedLen rejects length exceeding maximum
    When I call calcPaddedLen(65536)
    Then it should throw "Message too long"

  # --- Pad/Unpad roundtrip [EP] ---
  Scenario: pad and unpad roundtrip preserves message
    Given a message of 50 bytes
    When I pad the message
    And I unpad the result
    Then the output should equal the original message

  Scenario: Unpad rejects payload with wrong padding length
    Given a padded message with deliberately incorrect padding size
    When I call unpad
    Then it should throw "Invalid padding"

  Scenario: Unpad rejects payload with zero length prefix
    Given a padded message where the 2-byte length prefix is 0
    When I call unpad
    Then it should throw "Invalid message length: 0"


# =============================================================================
# FEATURE 16: Edge Cases — Event Handling
# =============================================================================

Feature: Event edge cases
  As the Nostr protocol layer
  I want events to handle unusual inputs correctly

  # --- Error Guessing [EG] ---

  Scenario: Event with empty tags array
    When I create an event with kind 1, empty tags, and content "test"
    Then the event should be created successfully
    And getTagValue for any tag should return undefined

  Scenario: Event with many tags (1000+)
    When I create an event with 1000 tags
    Then the event should be created and signed successfully
    And the event ID should be valid

  Scenario: Event with empty content string
    When I create an event with content ""
    Then the event should be created successfully

  # [BVA] — Tag access methods
  Scenario: getTagEntryValues returns all entries for a tag name
    Given an event with tags [["p","pk1"],["p","pk2"],["p","pk3"]]
    When I call getTagEntryValues("p")
    Then the result should be [["p","pk1"],["p","pk2"],["p","pk3"]]

  Scenario: getTagValues returns values at index 1 for a tag name
    Given an event with tags [["p","pk1","relay1"],["p","pk2","relay2"]]
    When I call getTagValues("p")
    Then the result should be ["pk1","pk2"]

  Scenario: hasTag returns false for non-existent tag
    Given an event with tags [["p","pk1"]]
    When I call hasTag("e")
    Then the result should be false


# =============================================================================
# FEATURE 17: Pairwise — Client Configuration Combinations
# =============================================================================

Feature: NostrClient configuration combinations
  As a Nostr application developer
  I want all combinations of client options to work correctly

  # --- Pairwise Testing [PW] ---

  Scenario Outline: Client works with various option combinations
    Given a NostrClient with options:
      | autoReconnect   | <autoReconnect>   |
      | queryTimeoutMs  | <queryTimeoutMs>  |
      | pingIntervalMs  | <pingIntervalMs>  |
    Then the client should be created successfully
    And getQueryTimeout should return <queryTimeoutMs>

    Examples:
      | autoReconnect | queryTimeoutMs | pingIntervalMs |
      | true          | 5000           | 30000          |
      | true          | 1000           | 0              |
      | false         | 5000           | 0              |
      | false         | 10000          | 30000          |
      | true          | 30000          | 60000          |
      | false         | 100            | 10000          |


# =============================================================================
# FEATURE 18: Risk-Based — Security Critical Paths
# =============================================================================

Feature: Security-critical operations
  As a security-conscious developer
  I want to verify that sensitive operations behave correctly
  So that no cryptographic keys or messages leak

  # --- Risk-Based Testing [RB] ---

  Scenario: Private key is not accessible after clear()
    Given a NostrKeyManager with a key pair
    When I call clear()
    Then getPrivateKey should throw "KeyManager has been cleared"
    And getPrivateKeyHex should throw "KeyManager has been cleared"
    And getNsec should throw "KeyManager has been cleared"
    And sign should throw "KeyManager has been cleared"
    And encrypt should throw "KeyManager has been cleared"

  Scenario: Private key memory is zeroed on clear
    Given a NostrKeyManager with a key pair
    When I call clear()
    Then the internal private key buffer should contain all zeros

  Scenario: getPrivateKey returns a copy, not a reference
    Given a NostrKeyManager with a key pair
    When I get the private key
    And I modify the returned array
    Then getting the private key again should return the original unmodified key

  Scenario: Gift wrap does not leak sender identity
    Given a gift-wrapped message from Alice to Bob
    Then the gift wrap event's pubkey should NOT be Alice's pubkey
    And the gift wrap event's signature should be from an ephemeral key

  Scenario: NIP-44 conversation key is symmetric
    When Alice derives conversation key with Bob's public key
    And Bob derives conversation key with Alice's public key
    Then both keys should be byte-identical

  Scenario: NIP-17 timestamps are randomized for privacy
    When Alice creates 20 gift wraps
    Then the created_at timestamps should vary (not all the same)
    And all timestamps should be within ±2 days of current time

  Scenario: AUTH event contains correct challenge-response
    Given a relay sends AUTH challenge "test-challenge-123"
    When the client responds with an AUTH event
    Then the AUTH event kind should be 22242
    And the AUTH event should have tag ["relay", "<relay_url>"]
    And the AUTH event should have tag ["challenge", "test-challenge-123"]
    And the AUTH event should be signed by the client's key manager


# =============================================================================
# FEATURE 19: Loop Testing — Subscription Re-establishment
# =============================================================================

Feature: Subscription re-establishment on reconnect
  As a Nostr application developer
  I want all subscriptions to be re-established after reconnect
  So that no events are missed during brief disconnections

  # --- Loop Testing [LC] ---

  Scenario: Zero subscriptions — nothing to re-establish
    Given I have no active subscriptions
    When the relay reconnects
    Then no REQ messages should be sent

  Scenario: One subscription is re-established
    Given I have 1 active subscription
    When the relay reconnects
    Then exactly 1 REQ message should be sent

  Scenario: Many subscriptions are all re-established
    Given I have 50 active subscriptions
    When the relay reconnects
    Then exactly 50 REQ messages should be sent
    And each REQ should contain the original filter

  Scenario: Unsubscribed subscriptions are NOT re-established
    Given I had 3 subscriptions and unsubscribed from 1
    When the relay reconnects
    Then exactly 2 REQ messages should be sent


# =============================================================================
# FEATURE 20: Exploratory — Concurrent Operations
# =============================================================================

Feature: Concurrent operations safety
  As a Nostr application developer
  I want concurrent operations to not corrupt state

  # --- Exploratory / Error Guessing [EG] ---

  Scenario: Publishing 100 events concurrently
    Given I am connected to a relay
    When I publish 100 events concurrently (Promise.all)
    Then all 100 should be sent without errors
    And the pending OKs map should have 100 entries

  Scenario: Subscribing and unsubscribing rapidly
    When I subscribe and immediately unsubscribe 50 times
    Then no subscriptions should remain
    And no errors should be thrown

  Scenario: Disconnect while publish is pending
    Given I am connected and have published an event awaiting OK
    When I call disconnect before OK arrives
    Then the pending publish should reject with "Client disconnected"

  Scenario: Connect to same relay URL concurrently
    When I call connect("wss://relay.example.com") twice concurrently
    Then only one WebSocket connection should be established
    Or both connect calls should resolve without error
