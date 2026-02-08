'use strict';

/**
 * Authentication helpers for whatwatt Go devices.
 *
 * Detects Digest vs Basic auth scheme and creates authenticated fetch functions.
 * Devices with firmware 1.10+ use Digest; older firmware uses Basic.
 */

const DigestClient = require('digest-fetch');
const { DEFAULT_TIMEOUT } = require('./constants');

/**
 * Detects the authentication scheme required by the device.
 * Probes /api/v1/system without auth; on 401, parses WWW-Authenticate header.
 * Falls back to 'digest' for unknown schemes since newer firmware uses Digest.
 *
 * @param {string} host - Device host or IP
 * @param {number} [port=80] - Device port
 * @param {boolean} [https=false] - Use HTTPS
 * @param {number} [timeout=10000] - Request timeout in milliseconds
 * @returns {Promise<'digest'|'basic'|null>} Auth scheme, or null if no auth required
 */
async function detectAuthScheme(host, port = 80, https = false, timeout = DEFAULT_TIMEOUT) {
  const protocol = https ? 'https' : 'http';
  const url = `${protocol}://${host}:${port}/api/v1/system`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timeoutId);

    if (response.status === 200) return null;

    if (response.status === 401) {
      const wwwAuth = response.headers.get('www-authenticate');
      const scheme = wwwAuth?.trim().split(/\s+/)[0]?.toLowerCase();
      if (scheme === 'basic') return 'basic';
      if (scheme === 'digest') return 'digest';
    }

    return 'digest';
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * Creates an authenticated fetch function for Basic or Digest auth.
 *
 * @param {string} username - Username (empty string for whatwatt)
 * @param {string} password - Web UI password
 * @param {'digest'|'basic'} scheme - Auth scheme to use
 * @returns {Function} Fetch-compatible function
 */
function createAuthenticatedFetch(username, password, scheme) {
  const client = new DigestClient(username || '', password, {
    basic: scheme === 'basic',
  });
  return client.fetch.bind(client);
}

module.exports = {
  detectAuthScheme,
  createAuthenticatedFetch,
};
