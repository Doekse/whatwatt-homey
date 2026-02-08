'use strict';

const { detectAuthScheme, createAuthenticatedFetch } = require('./authentication');
const { DEFAULT_TIMEOUT } = require('./constants');

/**
 * whatwatt Go API client.
 *
 * Handles HTTP requests to the whatwatt device REST API. Supports Digest (firmware 1.10+)
 * and Basic (older firmware) auth via probe-and-select. Uses native fetch with digest-fetch.
 */
class WhatwattAPI {
  /**
   * Creates a new API client instance.
   *
   * @param {Object} options - Configuration options
   * @param {string} options.host - Device IP address or hostname
   * @param {number} [options.port=80] - Device port (default: 80)
   * @param {boolean} [options.https=false] - Use HTTPS instead of HTTP
   * @param {string} [options.username] - Auth username (empty for whatwatt)
   * @param {string} [options.password] - Web UI password (if protection enabled)
   * @param {string} [options.authScheme='auto'] - 'auto' | 'digest' | 'basic'
   * @param {number} [options.timeout=10000] - Request timeout in milliseconds
   * @param {Object} [options.device] - Homey device instance for logging
   */
  constructor(options) {
    if (!options.host) {
      throw new Error('Host is required');
    }

    this.host = options.host;
    this.port = options.port || 80;
    this.protocol = options.https ? 'https' : 'http';
    this.username = options.username || '';
    this.password = options.password || '';
    this.authScheme = options.authScheme || 'auto';
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
    this.device = options.device;

    this._baseUrl = `${this.protocol}://${this.host}:${this.port}`;
    this._authSchemeDetected = null;
    this._authenticatedFetch = null;
  }

  /**
   * Resolves authentication before requests. Detects Digest vs Basic via probe when
   * authScheme is 'auto' to support both firmware 1.10+ (Digest) and older (Basic).
   * @private
   */
  async _ensureAuth() {
    if (!this.password) return;
    if (this._authenticatedFetch) return;

    let scheme = this._authSchemeDetected;
    if (this.authScheme === 'auto' || !scheme) {
      scheme = await detectAuthScheme(this.host, this.port, this.protocol === 'https', this.timeout);
      this._authSchemeDetected = scheme;
    } else {
      scheme = this.authScheme;
    }
    if (scheme) {
      this._authenticatedFetch = createAuthenticatedFetch(this.username, this.password, scheme);
    }
  }

  /**
   * Performs an HTTP request.
   *
   * @private
   * @param {string} method - HTTP method
   * @param {string} path - API path (e.g. /api/v1/system)
   * @param {Object} [body] - Optional JSON body for POST/PUT
   * @returns {Promise<Object|Array>} Parsed JSON response
   */
  async _request(method, path, body = undefined) {
    await this._ensureAuth();

    const url = `${this._baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    const options = {
      method,
      headers,
      signal: controller.signal,
    };

    if (body !== undefined && (method === 'POST' || method === 'PUT')) {
      options.body = JSON.stringify(body);
    }

    const fetchFn = this._authenticatedFetch || fetch;

    if (this.device) {
      this.device.log(`whatwatt API Request: ${method} ${path}`);
    }

    try {
      const response = await fetchFn(url, options);
      clearTimeout(timeoutId);

      if (this.device) {
        this.device.log(`whatwatt API Response: ${response.status} ${response.statusText}`);
      }

      if (!response.ok) {
        const err = new Error(`HTTP ${response.status} ${response.statusText}`);
        err.response = { status: response.status, statusText: response.statusText };
        throw err;
      }

      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await response.json();
      }
      return {};
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        const abortErr = new Error('Request timeout');
        abortErr.request = true;
        throw abortErr;
      }
      if (!error.response && !error.request) {
        error.request = true;
      }
      throw error;
    }
  }

  /**
   * Executes an API call and wraps errors with context. Provides consistent error
   * messages for callers instead of raw HTTP/network errors.
   * @private
   */
  async _apiCall(method, path, body, errorMessage) {
    try {
      return await this._request(method, path, body);
    } catch (error) {
      throw this._handleError(errorMessage, error);
    }
  }

  /**
   * Fetches device system information (firmware, model, etc.).
   * @returns {Promise<Object>}
   */
  async getSystemInfo() {
    return this._apiCall('GET', '/api/v1/system', undefined, 'Failed to get system info');
  }

  /**
   * Fetches current meter report (power, energy, voltage, current).
   * @returns {Promise<Object>}
   */
  async getReport() {
    return this._apiCall('GET', '/api/v1/report', undefined, 'Failed to get meter report');
  }

  /**
   * Fetches device variables.
   * @returns {Promise<Object>}
   */
  async getVariables() {
    return this._apiCall('GET', '/api/v1/variables', undefined, 'Failed to get variables');
  }

  /**
   * Fetches device settings.
   * @returns {Promise<Object>}
   */
  async getSettings() {
    return this._apiCall('GET', '/api/v1/settings', undefined, 'Failed to get settings');
  }

  /**
   * Updates device settings (partial update).
   * @param {Object} settings - Settings to update
   * @returns {Promise<Object>}
   */
  async updateSettings(settings) {
    return this._apiCall('PUT', '/api/v1/settings', settings, 'Failed to update settings');
  }

  /**
   * Replaces device settings (full replace).
   * @param {Object} settings - Full settings object
   * @returns {Promise<Object>}
   */
  async replaceSettings(settings) {
    return this._apiCall('POST', '/api/v1/settings', settings, 'Failed to replace settings');
  }

  /**
   * Fetches meter settings.
   * @returns {Promise<Object>}
   */
  async getMeterSettings() {
    return this._apiCall('GET', '/api/v1/meter/settings', undefined, 'Failed to get meter settings');
  }

  /**
   * Updates meter settings.
   * @param {Object} settings - Meter settings to update
   * @returns {Promise<Object>}
   */
  async updateMeterSettings(settings) {
    return this._apiCall('PUT', '/api/v1/meter/settings', settings, 'Failed to update meter settings');
  }

  /**
   * Fetches current scalers.
   * @returns {Promise<Object>}
   */
  async getCurrentScalers() {
    return this._apiCall('GET', '/api/v1/meter/scalers/current', undefined, 'Failed to get current scalers');
  }

  /**
   * Fetches custom scalers.
   * @returns {Promise<Object>}
   */
  async getCustomScalers() {
    return this._apiCall('GET', '/api/v1/meter/scalers/custom', undefined, 'Failed to get custom scalers');
  }

  /**
   * Sets custom scalers.
   * @param {Object} scalers - Custom scalers
   * @returns {Promise<Object>}
   */
  async setCustomScalers(scalers) {
    return this._apiCall('POST', '/api/v1/meter/scalers/custom', scalers, 'Failed to set custom scalers');
  }

  /**
   * Fetches WiFi station settings.
   * @returns {Promise<Object>}
   */
  async getWiFiSettings() {
    return this._apiCall('GET', '/api/v1/wifi/sta/settings', undefined, 'Failed to get WiFi settings');
  }

  /**
   * Updates WiFi station settings.
   * @param {Object} settings - WiFi settings to update
   * @returns {Promise<Object>}
   */
  async updateWiFiSettings(settings) {
    return this._apiCall('PUT', '/api/v1/wifi/sta/settings', settings, 'Failed to update WiFi settings');
  }

  /**
   * Scans for available WiFi networks.
   * @returns {Promise<Object>}
   */
  async scanWiFiNetworks() {
    return this._apiCall('GET', '/api/v1/wifi/scan', undefined, 'Failed to scan WiFi networks');
  }

  /**
   * Starts WPS pairing mode on the device.
   * @returns {Promise<void>}
   */
  async startWPSPairing() {
    try {
      await this._request('POST', '/api/v1/wifi/wps');
    } catch (error) {
      throw this._handleError('Failed to start WPS pairing', error);
    }
  }

  /**
   * Fetches Ethernet settings.
   * @returns {Promise<Object>}
   */
  async getEthernetSettings() {
    return this._apiCall('GET', '/api/v1/eth/settings', undefined, 'Failed to get Ethernet settings');
  }

  /**
   * Updates Ethernet settings.
   * @param {Object} settings - Ethernet settings to update
   * @returns {Promise<Object>}
   */
  async updateEthernetSettings(settings) {
    return this._apiCall('PUT', '/api/v1/eth/settings', settings, 'Failed to update Ethernet settings');
  }

  /**
   * Fetches MQTT settings.
   * @returns {Promise<Object>}
   */
  async getMQTTSettings() {
    return this._apiCall('GET', '/api/v1/mqtt/settings', undefined, 'Failed to get MQTT settings');
  }

  /**
   * Updates MQTT settings.
   * @param {Object} settings - MQTT settings to update
   * @returns {Promise<Object>}
   */
  async updateMQTTSettings(settings) {
    return this._apiCall('PUT', '/api/v1/mqtt/settings', settings, 'Failed to update MQTT settings');
  }

  /**
   * Reboots the device.
   * @returns {Promise<void>}
   */
  async rebootDevice() {
    try {
      await this._request('POST', '/api/v1/reboot');
    } catch (error) {
      throw this._handleError('Failed to reboot device', error);
    }
  }

  /**
   * Performs factory reset on the device.
   * @returns {Promise<void>}
   */
  async factoryReset() {
    try {
      await this._request('POST', '/api/v1/restore');
    } catch (error) {
      throw this._handleError('Failed to factory reset device', error);
    }
  }

  /**
   * Tests connectivity by fetching system info. Returns false on failure.
   * @returns {Promise<boolean>}
   */
  async testConnection() {
    try {
      await this.getSystemInfo();
      return true;
    } catch (error) {
      if (this.device) {
        this.device.error('Connection test failed:', error.message);
      }
      return false;
    }
  }

  /**
   * Static helper to test device connectivity without instantiating a full API client.
   * Used during pairing and repair when no device instance exists.
   *
   * @param {Object} deviceConfig - { host, port } connection config
   * @param {string} [password=''] - Web UI password if protection enabled
   * @param {number} [timeout=DEFAULT_TIMEOUT] - Request timeout in ms
   * @returns {Promise<boolean>}
   */
  static async testDeviceConnection(deviceConfig, password = '', timeout = DEFAULT_TIMEOUT) {
    try {
      const api = new WhatwattAPI({
        host: deviceConfig.host,
        port: deviceConfig.port || 80,
        https: false,
        username: '',
        password,
        authScheme: 'auto',
        timeout,
        device: null,
      });
      return await api.testConnection();
    } catch {
      return false;
    }
  }

  _handleError(message, error) {
    if (error.response) {
      const { status, statusText } = error.response;
      switch (status) {
        case 400:
          return new Error(`${message}: Bad request - Invalid parameters`);
        case 401: {
          if (this.device) {
            this.device.log('Authentication failed - device requires repair');
          }
          const unauthorizedError = new Error(`${message}: Unauthorized - Check credentials`);
          unauthorizedError.isUnauthorized = true;
          unauthorizedError.statusCode = 401;
          return unauthorizedError;
        }
        case 404:
          return new Error(`${message}: Endpoint not found or disabled`);
        case 500:
          return new Error(`${message}: Internal device error`);
        case 503:
          return new Error(`${message}: Service unavailable`);
        default:
          return new Error(`${message}: HTTP ${status} ${statusText}`);
      }
    }
    if (error.request) {
      return new Error(`${message}: No response from device (${this.host}:${this.port})`);
    }
    return new Error(`${message}: ${error.message}`);
  }
}

module.exports = WhatwattAPI;
