'use strict';

const Homey = require('homey');
const WhatwattAPI = require('../../lib/whatwattapi');
const WhatwattEventStream = require('../../lib/eventstream');
const {
  updateCapability, setupCapability, convertPower, convertReport, updateMeterInformation, calculatePower, refreshDeviceIP,
} = require('../../lib/utils');
const { DEFAULT_TIMEOUT, HEARTBEAT_TIMEOUT } = require('../../lib/constants');

/** Maps capability IDs to value extractors for live data updates. */
const LIVE_DATA_CAPABILITIES = [
  ['measure_power', (d, power) => convertPower(power.total)],
  ['measure_power.phase1', (d, power) => convertPower(power.phase1)],
  ['measure_power.phase2', (d, power) => convertPower(power.phase2)],
  ['measure_power.phase3', (d, power) => convertPower(power.phase3)],
  ['measure_voltage', (d) => d.V_P1],
  ['measure_voltage.phase2', (d) => d.V_P2],
  ['measure_voltage.phase3', (d) => d.V_P3],
  ['measure_current', (d) => d.I_P1],
  ['measure_current.phase2', (d) => d.I_P2],
  ['measure_current.phase3', (d) => d.I_P3],
  ['meter_power', (d) => d.E_In],
  ['meter_power.exported', (d) => d.E_Out],
  ['meter_power.imported_tariff1', (d) => d.E_In_T1],
  ['meter_power.imported_tariff2', (d) => d.E_In_T2],
  ['meter_power.exported_tariff1', (d) => d.E_Out_T1],
  ['meter_power.exported_tariff2', (d) => d.E_Out_T2],
  ['measure_power_reactive_in', (d) => convertPower(d.rP_In)],
  ['measure_power_reactive_out', (d) => convertPower(d.rP_Out)],
  ['measure_power_factor', (d) => d.PF],
];

/**
 * whatwatt Go device driver for Homey.
 *
 * Manages connectivity to whatwatt Go energy meters and provides real-time data streaming
 * through Server-Sent Events. Handles device initialization, capability setup, and live
 * data updates while ensuring proper lifecycle management.
 */
module.exports = class whatwattGoDevice extends Homey.Device {

  constructor(...args) {
    super(...args);

    // Maintains reference to SSE stream for proper cleanup during device lifecycle
    this.eventStream = null;

    // Prevents async operations from executing after device removal to avoid errors
    this._isDeleted = false;

    // Tracks setup completion to defer live updates until capabilities are properly initialized
    this._setupCompleted = this.getSetting('_setupCompleted') || false;
    this.log(`Device setup completed flag: ${this._setupCompleted}`);
  }

  /**
   * Initialize device connectivity and establish live data streaming.
   *
   * Performs connection validation before starting the event stream. If initial
   * connection fails, attempts IP discovery to recover from network changes.
   * Gracefully handles failures by marking device as unavailable rather than crashing.
   */
  async onInit() {
    this.log('whatwatt Go Device has been initialized');

    try {
      await this._testConnection();
      await this._initializeEventStream();
    } catch (error) {
      this.log('Initial connection failed, attempting IP discovery and retry...');

      try {
        // Attempt to discover the device's current IP address to handle network changes
        const ipResult = await refreshDeviceIP(this, this.driver);

        if (ipResult.success && ipResult.ipUpdated) {
          this.log('IP address updated, retrying connection...');
          await this._testConnection();
          await this._initializeEventStream();
          this.log('Successfully connected after IP discovery');
        } else {
          // IP discovery unsuccessful, mark device as unavailable without crashing
          this.log('IP discovery did not resolve connection issue, marking device as unavailable');
          await this.setUnavailable('Device unreachable - check network connection and IP address');
        }
      } catch (retryError) {
        this.error('Failed to recover from connection error:', retryError.message);
        // Mark device as unavailable to prevent initialization crashes
        await this.setUnavailable('Device unreachable - check network connection and IP address');
      }
    }
  }

  /**
   * Configure device capabilities and meter information during device addition.
   *
   * Establishes the complete capability set and persists meter details to settings
   * to ensure proper device configuration before live data streaming begins.
   */
  async onAdded() {
    this.log('whatwatt Go Device has been added');

    try {
      await this._initCapabilities();
      await this._initMeterInformation();
    } catch (error) {
      this.error('Failed to set up device during device addition:', error.message);
    }
  }

  /**
   * Initialize device capabilities with initial meter readings.
   *
   * Fetches current meter data and sets up all required capabilities to ensure
   * live updates operate on a properly configured and normalized capability set.
   * Called during device addition and repair operations.
   */
  async _initCapabilities() {
    this.log('Setting up device capabilities');
    const api = this._createAPI();
    const data = await api.getReport();

    // Convert REST API response to standardized format for consistent processing
    const sseData = convertReport(data);

    // Calculate net power values to handle bidirectional energy flow
    const powerData = calculatePower(sseData);

    // convertReport returns watts; no additional conversion needed for setupCapability
    await setupCapability(this, 'measure_power', powerData.total);
    await setupCapability(this, 'measure_power.phase1', powerData.phase1);
    await setupCapability(this, 'measure_power.phase2', powerData.phase2);
    await setupCapability(this, 'measure_power.phase3', powerData.phase3);

    await setupCapability(this, 'measure_voltage', sseData.V_P1);
    await setupCapability(this, 'measure_voltage.phase2', sseData.V_P2);
    await setupCapability(this, 'measure_voltage.phase3', sseData.V_P3);

    await setupCapability(this, 'measure_current', sseData.I_P1);
    await setupCapability(this, 'measure_current.phase2', sseData.I_P2);
    await setupCapability(this, 'measure_current.phase3', sseData.I_P3);

    await setupCapability(this, 'meter_power', sseData.E_In);
    await setupCapability(this, 'meter_power.exported', sseData.E_Out);

    await setupCapability(this, 'meter_power.imported_tariff1', sseData.E_In_T1);
    await setupCapability(this, 'meter_power.imported_tariff2', sseData.E_In_T2);
    await setupCapability(this, 'meter_power.exported_tariff1', sseData.E_Out_T1);
    await setupCapability(this, 'meter_power.exported_tariff2', sseData.E_Out_T2);

    await setupCapability(this, 'measure_power_reactive_in', sseData.rP_In);
    await setupCapability(this, 'measure_power_reactive_out', sseData.rP_Out);
    await setupCapability(this, 'measure_power_factor', sseData.PF);

    this.log('Initial capability setup completed');

    // Enable live data updates now that capabilities are properly configured
    this._setupCompleted = true;

    // Persist setup state to survive Homey restarts
    await this.setSettings({ _setupCompleted: true });
  }

  /**
   * Retrieve and store meter information in device settings.
   *
   * Fetches system information from the meter and persists relevant details
   * to device settings for reference and troubleshooting purposes.
   * Called during device addition and repair operations.
   */
  async _initMeterInformation() {
    this.log('Setting up meter information');
    const api = this._createAPI();
    const systemInfo = await api.getSystemInfo();

    // Store meter details in device settings for future reference
    await updateMeterInformation(this, systemInfo, null);

    this.log('Meter information setup completed');
  }

  /**
   * Handle device settings changes and update connection parameters.
   *
   * Monitors for connection-related setting changes and reinitializes the
   * connection when credentials or network parameters are modified, allowing
   * configuration updates without requiring device re-addition.
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('whatwatt Go Device settings were changed:', changedKeys);

    const connectionChanged = changedKeys.some((key) => ['https', 'username', 'password', 'timeout'].includes(key));

    if (connectionChanged) {
      this.log('Connection settings changed, reinitializing...');
      await this._reinitializeConnection(newSettings);
      return 'Connection settings updated successfully';
    }
    return undefined;
  }

  /**
   * Clean up resources when device is removed.
   *
   * Stops active data streams and releases references to prevent memory leaks
   * and orphaned network connections after device removal.
   */
  async onDeleted() {
    this.log('whatwatt Go Device has been deleted');
    this._isDeleted = true;

    if (this.eventStream) {
      this.eventStream.stop();
      this.eventStream = null;
    }
  }

  /**
   * Perform cleanup when device is uninitialized.
   *
   * Ensures proper resource cleanup during device lifecycle transitions
   * to prevent memory leaks and maintain system stability.
   */
  async onUninit() {
    this.log('whatwatt Go Device has been uninitialized');
    this._isDeleted = true;

    if (this.eventStream) {
      this.eventStream.stop();
      this.eventStream = null;
    }
  }

  // ============================================================================
  // INITIALIZATION METHODS
  // ============================================================================

  /**
   * Builds connection config from device store and settings.
   * Store holds address/port (from pairing); settings hold protocol and timeout preferences.
   * @private
   * @returns {{ host: string, port: number, https: boolean, timeout: number }}
   */
  _getConnectionConfig() {
    const store = this.getStore();
    const settings = this.getSettings();
    return {
      host: store.address,
      port: store.port || 80,
      https: settings.https || false,
      timeout: settings.timeout || DEFAULT_TIMEOUT,
    };
  }

  /**
   * Retrieves device password from Homey manager settings.
   * Stored separately from device settings for security.
   * @private
   * @returns {string}
   */
  _getPassword() {
    const passwordKey = `password_${this.getData().id}`;
    return this.homey.settings.get(passwordKey) || '';
  }

  /**
   * Creates an API client with current device configuration.
   * @private
   * @returns {whatwattAPI}
   */
  _createAPI() {
    const config = this._getConnectionConfig();
    const settings = this.getSettings();
    return new WhatwattAPI({
      host: config.host,
      port: config.port,
      https: config.https,
      username: settings.username,
      password: this._getPassword(),
      authScheme: 'auto',
      timeout: config.timeout,
      device: this,
    });
  }

  /**
   * Test device connectivity and validate credentials.
   *
   * Performs connection validation to ensure the device is reachable and
   * credentials are valid before establishing the live data stream.
   */
  async _testConnection() {
    const config = this._getConnectionConfig();
    this.log(`Testing connection to ${config.host}:${config.port}`);
    const isConnected = await WhatwattAPI.testDeviceConnection(
      { host: config.host, port: config.port },
      this._getPassword(),
      config.timeout,
    );

    if (!isConnected) {
      throw new Error('Failed to connect to whatwatt Go device');
    }

    this.log('Successfully connected to whatwatt Go device');
  }

  /**
   * Initialize Server-Sent Events stream for real-time meter data.
   *
   * Establishes a persistent connection to receive live meter readings efficiently.
   * Uses SSE instead of polling to minimize device load and ensure timely updates.
   */
  async _initializeEventStream() {
    const config = this._getConnectionConfig();
    const settings = this.getSettings();
    this.eventStream = new WhatwattEventStream({
      homey: this.homey,
      host: config.host,
      port: config.port,
      https: config.https,
      username: settings.username,
      password: this._getPassword(),
      authScheme: 'auto',
      heartbeatTimeout: HEARTBEAT_TIMEOUT,
      logger: (message) => this.log(`[EventStream] ${message}`),
      onData: (data) => this._onLiveData(data),
      onConnect: () => this._onStreamConnect(),
      onError: (error) => this._onStreamError(error),
      onDisconnect: () => this._onStreamDisconnect(),
      device: this,
      driver: this.driver,
    });

    await this.eventStream.start();
  }

  /**
   * Update connection parameters and reinitialize the event stream.
   *
   * Validates new connection settings and updates the active event stream
   * configuration when connection parameters are modified.
   */
  async _reinitializeConnection(newSettings) {
    try {
      await this._testConnection();
      if (this.eventStream) {
        const config = this._getConnectionConfig();
        this.eventStream.updateSettings({
          host: config.host,
          port: config.port,
          https: newSettings.https || false,
          username: newSettings.username,
          password: this._getPassword(),
        });
      }
    } catch (error) {
      this.error('Failed to reinitialize connection:', error.message);
      throw new Error(`Failed to update connection settings: ${error.message}`);
    }
  }

  // ============================================================================
  // EVENT STREAM HANDLERS
  // ============================================================================

  /**
   * Updates device availability. Ignores errors when device is deleted.
   * @private
   * @param {boolean} available - Whether device is available
   * @param {string} [reason] - Reason when unavailable
   */
  _setAvailability(available, reason) {
    try {
      (available ? this.setAvailable() : this.setUnavailable(reason))
        .catch(() => this.log('Device unavailable or deleted, skipping availability update'));
    } catch {
      this.log('Device unavailable or deleted, skipping availability update');
    }
  }

  /**
   * Invoked when the SSE stream connects. Marks device available.
   * @private
   */
  _onStreamConnect() {
    this.log('Live data stream connected');
    this._setAvailability(true);
  }

  /**
   * Invoked when the SSE stream encounters an error. Marks device unavailable.
   * @private
   * @param {Error} error - Stream error
   */
  _onStreamError(error) {
    this.error('Live data stream error:', error);
    this._setAvailability(false, 'Live data stream disconnected');
  }

  /**
   * Invoked when the SSE stream disconnects. Marks device unavailable.
   * @private
   */
  _onStreamDisconnect() {
    this.log('Live data stream disconnected');
    this._setAvailability(false, 'Live data stream disconnected');
  }

  /**
   * Handles live meter data from the SSE stream.
   * Skips updates until setup is complete to avoid capability writes before initialization.
   * @private
   * @param {Object} data - Parsed live data payload
   */
  async _onLiveData(data) {
    if (this._isDeleted || !this._setupCompleted) return;

    try {
      const powerData = calculatePower(data);
      for (const [capabilityId, getValue] of LIVE_DATA_CAPABILITIES) {
        const value = getValue(data, powerData);
        if (value != null) {
          await updateCapability(this, capabilityId, value).catch(this.error);
        }
      }
    } catch (error) {
      this.error('Error handling live data:', error.message);
    }
  }

};
