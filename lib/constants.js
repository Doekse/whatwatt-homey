'use strict';

/**
 * Shared timeout and timeout-related constants for whatwatt Go.
 * Used by API client, event stream, pairing, and repair flows.
 */

/** Default request/auth probe timeout in ms. */
const DEFAULT_TIMEOUT = 10000;

/** Timeout for pairing connection test in ms. */
const PAIRING_TIMEOUT = 5000;

/** Time without SSE data before treating connection as dead (ms). */
const HEARTBEAT_TIMEOUT = 300000;

module.exports = {
  DEFAULT_TIMEOUT,
  PAIRING_TIMEOUT,
  HEARTBEAT_TIMEOUT,
};
