'use strict';

const axios = require('axios');

/**
 * whatwatt Go API client
 * 
 * Handles HTTP requests to the whatwatt device's REST API.
 * Manages authentication, error handling, and request/response logging.
 */
class whatwattAPI {
  /**
   * Creates a new API client instance.
   * Sets up axios with base URL, authentication, and interceptors for logging.
   * 
   * @param {Object} options - Configuration options
   * @param {string} options.host - Device IP address or hostname
   * @param {number} [options.port=80] - Device port (default: 80)
   * @param {boolean} [options.https=false] - Use HTTPS instead of HTTP
   * @param {string} [options.username] - Basic auth username (if device has protection enabled)
   * @param {string} [options.password] - Basic auth password (if device has protection enabled)
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
    this.timeout = options.timeout || 10000;
    this.device = options.device;

    // Set up axios with base URL and timeout
    this.client = axios.create({
      baseURL: `${this.protocol}://${this.host}:${this.port}`,
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });

    // Add basic authentication if credentials are provided
    // whatwatt Go devices may only require password authentication
    if (options.password) {
      this.client.defaults.auth = {
        username: options.username || '', // Use empty string if no username provided
        password: options.password,
      };
    }

    // Add interceptors for request/response logging
    this.client.interceptors.request.use(
      (config) => {
        if (this.device) {
          this.device.log(`whatwatt API Request: ${config.method?.toUpperCase()} ${config.url}`);
        }
        return config;
      },
      (error) => {
        if (this.device) {
          this.device.error(`whatwatt API Request Error: ${error.message}`);
        }
        return Promise.reject(error);
      },
    );

    this.client.interceptors.response.use(
      (response) => {
        if (this.device) {
          this.device.log(`whatwatt API Response: ${response.status} ${response.statusText}`);
        }
        return response;
      },
      (error) => {
        if (this.device) {
          this.device.error(`whatwatt API Response Error: ${error.response?.status} ${error.response?.statusText}`);
        }
        return Promise.reject(error);
      },
    );
  }

  // === SYSTEM INFORMATION ===

  /**
   * Gets system information from the device.
   * Returns device details, meter status, and network configuration.
   * 
   * @returns {Promise<Object>} System information object
   */
  async getSystemInfo() {
    try {
      const response = await this.client.get('/api/v1/system');
      return response.data;
    } catch (error) {
      throw await this._handleError('Failed to get system info', error);
    }
  }

  // === METER REPORTS ===

  /**
   * Gets the latest meter report.
   * Contains current energy measurements and meter status.
   * 
   * @returns {Promise<Object>} Latest meter report data
   */
  async getReport() {
    try {
      const response = await this.client.get('/api/v1/report');
      return response.data;
    } catch (error) {
      throw await this._handleError('Failed to get meter report', error);
    }
  }

  /**
   * Gets live meter data stream configuration.
   * Returns stream setup for Server-Sent Events (SSE).
   * Note: This returns a stream, not a promise.
   * 
   * @returns {Promise<Object>} Stream configuration for live data
   */
  async getLiveDataStream() {
    try {
      const response = await this.client.get('/api/v1/live', {
        responseType: 'stream',
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      });
      return response.data;
    } catch (error) {
      throw await this._handleError('Failed to get live data stream', error);
    }
  }

  /**
   * Gets all available variables from the device.
   * Returns current values for all device variables.
   * 
   * @returns {Promise<Array>} Array of variable objects with current values
   */
  async getVariables() {
    try {
      const response = await this.client.get('/api/v1/variables');
      return response.data;
    } catch (error) {
      throw await this._handleError('Failed to get variables', error);
    }
  }

  // === SETTINGS MANAGEMENT ===

  /**
   * Gets current device settings.
   * Returns services configuration and system settings.
   * 
   * @returns {Promise<Object>} Current settings object
   */
  async getSettings() {
    try {
      const response = await this.client.get('/api/v1/settings');
      return response.data;
    } catch (error) {
      throw await this._handleError('Failed to get settings', error);
    }
  }

  /**
   * Updates device settings (partial update).
   * Only updates the specified settings, leaving others unchanged.
   * 
   * @param {Object} settings - Settings to update
   * @returns {Promise<Object>} Updated settings object
   */
  async updateSettings(settings) {
    try {
      const response = await this.client.put('/api/v1/settings', settings);
      return response.data;
    } catch (error) {
      throw await this._handleError('Failed to update settings', error);
    }
  }

  /**
   * Replaces all device settings (full replacement).
   * Overwrites all settings with the provided configuration.
   * 
   * @param {Object} settings - Complete settings object
   * @returns {Promise<Object>} New settings object
   */
  async replaceSettings(settings) {
    try {
      const response = await this.client.post('/api/v1/settings', settings);
      return response.data;
    } catch (error) {
      throw await this._handleError('Failed to replace settings', error);
    }
  }

  // === METER CONFIGURATION ===

  /**
   * Gets meter communication settings.
   * Returns configuration for meter interface and protocol.
   * 
   * @returns {Promise<Object>} Meter settings object
   */
  async getMeterSettings() {
    try {
      const response = await this.client.get('/api/v1/meter/settings');
      return response.data;
    } catch (error) {
      throw await this._handleError('Failed to get meter settings', error);
    }
  }

  /**
   * Updates meter communication settings.
   * Changes meter interface configuration and protocol settings.
   * 
   * @param {Object} settings - Meter settings to update
   * @returns {Promise<Object>} Updated meter settings
   */
  async updateMeterSettings(settings) {
    try {
      const response = await this.client.put('/api/v1/meter/settings', settings);
      return response.data;
    } catch (error) {
      throw await this._handleError('Failed to update meter settings', error);
    }
  }

  /**
   * Gets current scaler values for DLMS meters.
   * Returns scaling factors used for energy calculations.
   * 
   * @returns {Promise<Array>} Array of current scaler objects
   */
  async getCurrentScalers() {
    try {
      const response = await this.client.get('/api/v1/meter/scalers/current');
      return response.data;
    } catch (error) {
      throw await this._handleError('Failed to get current scalers', error);
    }
  }

  /**
   * Gets custom scaler settings.
   * Returns user-defined scaling factors for energy calculations.
   * 
   * @returns {Promise<Array>} Array of custom scaler objects
   */
  async getCustomScalers() {
    try {
      const response = await this.client.get('/api/v1/meter/scalers/custom');
      return response.data;
    } catch (error) {
      throw await this._handleError('Failed to get custom scalers', error);
    }
  }

  /**
   * Sets custom scaler values.
   * Overwrites user-defined scaling factors for energy calculations.
   * 
   * @param {Array} scalers - Array of scaler objects with obis and scaler properties
   * @returns {Promise<Array>} Updated custom scalers
   */
  async setCustomScalers(scalers) {
    try {
      const response = await this.client.post('/api/v1/meter/scalers/custom', scalers);
      return response.data;
    } catch (error) {
      throw await this._handleError('Failed to set custom scalers', error);
    }
  }

  // === NETWORK CONFIGURATION ===

  /**
   * Gets Wi-Fi station settings.
   * Returns current Wi-Fi connection configuration.
   * 
   * @returns {Promise<Object>} Wi-Fi settings object
   */
  async getWiFiSettings() {
    try {
      const response = await this.client.get('/api/v1/wifi/sta/settings');
      return response.data;
    } catch (error) {
      throw await this._handleError('Failed to get WiFi settings', error);
    }
  }

  /**
   * Updates Wi-Fi station settings.
   * Changes Wi-Fi connection configuration.
   * 
   * @param {Object} settings - Wi-Fi settings to update
   * @returns {Promise<Object>} Updated Wi-Fi settings
   */
  async updateWiFiSettings(settings) {
    try {
      const response = await this.client.put('/api/v1/wifi/sta/settings', settings);
      return response.data;
    } catch (error) {
      throw await this._handleError('Failed to update WiFi settings', error);
    }
  }

  /**
   * Scans for available Wi-Fi networks.
   * Returns list of networks the device can detect.
   * 
   * @returns {Promise<Array>} Array of available networks
   */
  async scanWiFiNetworks() {
    try {
      const response = await this.client.get('/api/v1/wifi/scan');
      return response.data;
    } catch (error) {
      throw await this._handleError('Failed to scan WiFi networks', error);
    }
  }

  /**
   * Starts WPS pairing process.
   * Initiates Wi-Fi Protected Setup for easy network connection.
   * 
   * @returns {Promise<void>} Resolves when WPS pairing is started
   */
  async startWPSPairing() {
    try {
      await this.client.post('/api/v1/wifi/wps');
    } catch (error) {
      throw await this._handleError('Failed to start WPS pairing', error);
    }
  }

  /**
   * Gets Ethernet settings.
   * Returns current Ethernet connection configuration.
   * 
   * @returns {Promise<Object>} Ethernet settings object
   */
  async getEthernetSettings() {
    try {
      const response = await this.client.get('/api/v1/eth/settings');
      return response.data;
    } catch (error) {
      throw await this._handleError('Failed to get Ethernet settings', error);
    }
  }

  /**
   * Updates Ethernet settings.
   * Changes Ethernet connection configuration.
   * 
   * @param {Object} settings - Ethernet settings to update
   * @returns {Promise<Object>} Updated Ethernet settings
   */
  async updateEthernetSettings(settings) {
    try {
      const response = await this.client.put('/api/v1/eth/settings', settings);
      return response.data;
    } catch (error) {
      throw await this._handleError('Failed to update Ethernet settings', error);
    }
  }

  // === MQTT CONFIGURATION ===

  /**
   * Gets MQTT client settings.
   * Returns MQTT broker configuration and connection settings.
   * 
   * @returns {Promise<Object>} MQTT settings object
   */
  async getMQTTSettings() {
    try {
      const response = await this.client.get('/api/v1/mqtt/settings');
      return response.data;
    } catch (error) {
      throw await this._handleError('Failed to get MQTT settings', error);
    }
  }

  /**
   * Updates MQTT client settings.
   * Changes MQTT broker configuration and connection settings.
   * 
   * @param {Object} settings - MQTT settings to update
   * @returns {Promise<Object>} Updated MQTT settings
   */
  async updateMQTTSettings(settings) {
    try {
      const response = await this.client.put('/api/v1/mqtt/settings', settings);
      return response.data;
    } catch (error) {
      throw await this._handleError('Failed to update MQTT settings', error);
    }
  }

  // === DEVICE CONTROL ===

  /**
   * Reboots the device.
   * Sends reboot command to restart the whatwatt device.
   * 
   * @returns {Promise<void>} Resolves when reboot command is sent
   */
  async rebootDevice() {
    try {
      await this.client.post('/api/v1/reboot');
    } catch (error) {
      throw await this._handleError('Failed to reboot device', error);
    }
  }

  /**
   * Factory resets the device.
   * Sends factory reset command to restore device to default settings.
   * 
   * @returns {Promise<void>} Resolves when factory reset command is sent
   */
  async factoryReset() {
    try {
      await this.client.post('/api/v1/restore');
    } catch (error) {
      throw await this._handleError('Failed to factory reset device', error);
    }
  }

  // === UTILITY METHODS ===

  /**
   * Tests connection to the device.
   * Attempts to get system info to verify device is reachable.
   * 
   * @returns {Promise<boolean>} True if device is reachable and responding
   */
  async testConnection() {
    try {
      await this.getSystemInfo();
      return true;
    } catch (error) {
      if (this.device) {
        this.device.error('Connection test failed:', error.message);
      }
      
      // For 401 errors, the device has already been set unavailable in _handleError
      // Return false instead of throwing to prevent initialization failure
      if (error.isUnauthorized) {
        return false;
      }
      
      return false;
    }
  }

  /**
   * Static method to test connection to a device during pairing/repair.
   * Creates a temporary API instance to test connectivity without affecting device state.
   * 
   * @param {Object} deviceConfig - Device configuration object
   * @param {string} deviceConfig.host - Device IP address or hostname
   * @param {number} [deviceConfig.port=80] - Device port
   * @param {string} password - Password to test (can be empty)
   * @param {number} timeout - Connection timeout in milliseconds
   * @returns {Promise<boolean>} True if connection successful, false otherwise
   */
  static async testDeviceConnection(deviceConfig, password = '', timeout = 10000) {
    try {
      const api = new whatwattAPI({
        host: deviceConfig.host,
        port: deviceConfig.port || 80,
        https: false,
        username: '',
        password: password,
        timeout: timeout,
        device: null,
      });
      
      return await api.testConnection();
    } catch (error) {
      // Return false for any connection errors during testing
      return false;
    }
  }

  /**
   * Gets device power consumption data in a simplified format.
   * Extracts and formats energy measurements from the meter report.
   * 
   * @returns {Promise<Object>} Simplified power data object
   */
  async getPowerData() {
    try {
      const report = await this.getReport();
      const powerData = {
        timestamp: report.report?.date_time,
        instantaneousPower: {
          total: report.report?.instantaneous_power?.active?.positive?.total || 0,
          l1: report.report?.instantaneous_power?.active?.positive?.l1 || 0,
          l2: report.report?.instantaneous_power?.active?.positive?.l2 || 0,
          l3: report.report?.instantaneous_power?.active?.positive?.l3 || 0,
        },
        energy: {
          imported: report.report?.energy?.active?.positive?.total || 0,
          exported: report.report?.energy?.active?.negative?.total || 0,
        },
        voltage: {
          l1: report.report?.voltage?.l1 || 0,
          l2: report.report?.voltage?.l2 || 0,
          l3: report.report?.voltage?.l3 || 0,
        },
        current: {
          l1: report.report?.current?.l1 || 0,
          l2: report.report?.current?.l2 || 0,
          l3: report.report?.current?.l3 || 0,
        },
        meter: {
          status: report.meter?.status,
          interface: report.meter?.interface,
          protocol: report.meter?.protocol,
          id: report.meter?.id,
        },
      };

      return powerData;
    } catch (error) {
      throw await this._handleError('Failed to get power data', error);
    }
  }

  /**
   * Handles API errors and provides meaningful error messages.
   * Converts HTTP errors and network issues into user-friendly messages.
   * For 401 errors, also sets the device as unavailable with a repair message.
   * 
   * @private
   * @param {string} message - Base error message
   * @param {Error} error - Original error object
   * @returns {Error} Formatted error object with additional properties for 401 errors
   */
  async _handleError(message, error) {
    if (error.response) {
      // HTTP error response received
      const { status } = error.response;
      const { statusText } = error.response;

      switch (status) {
        case 400:
          return new Error(`${message}: Bad request - Invalid parameters`);
        case 401:
          // Log authentication failure for debugging
          if (this.device) {
            this.device.log('Authentication failed - device requires repair');
          }
          
          const unauthorizedError = new Error(`${message}: Unauthorized - Check credentials`);
          unauthorizedError.isUnauthorized = true;
          unauthorizedError.statusCode = 401;
          return unauthorizedError;
        case 404:
          return new Error(`${message}: Endpoint not found or disabled`);
        case 500:
          return new Error(`${message}: Internal device error`);
        case 503:
          return new Error(`${message}: Service unavailable`);
        default:
          return new Error(`${message}: HTTP ${status} ${statusText}`);
      }
    } else if (error.request) {
      // Network request failed (no response)
      return new Error(`${message}: No response from device (${this.host}:${this.port})`);
    } else {
      // Other error occurred
      return new Error(`${message}: ${error.message}`);
    }
  }
}

module.exports = whatwattAPI;
