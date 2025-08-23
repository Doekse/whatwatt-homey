'use strict';

const Homey = require('homey');
const whatwattAPI = require('../../lib/whatwattapi');
const whatwattEventStream = require('../../lib/eventstream');

/**
 * Manages device capabilities based on data availability.
 * Adds capabilities when data is present, removes them when unavailable.
 * This prevents showing broken capabilities when the meter doesn't provide certain data.
 */
async function updateCapability(device, capability, value) {
  try {
    // Remove capability when data is unavailable to keep interface clean
    if (value === null || value === undefined) {
      if (device.hasCapability(capability)) {
        await device.removeCapability(capability).catch(device.error);
        device.log(`Removed capability: ${capability} (no valid data)`);
      }
      return;
    }

    // Add capability when data becomes available
    if (!device.hasCapability(capability)) {
      await device.addCapability(capability).catch(device.error);
      device.log(`Added capability: ${capability}`);
    }

    // Only update when value changes to minimize unnecessary capability updates
    const current = device.getCapabilityValue(capability);
    if (current !== value) {
      await device.setCapabilityValue(capability, value).catch(device.error);
    }
  } catch (error) {
    device.error(`Failed to update capability ${capability}:`, error.message);
  }
}

/**
 * whatwatt Go Device Driver for Homey
 * 
 * Connects to whatwatt Go smart meters and exposes their data as Homey capabilities.
 * Handles live data streaming, capability management, and Homey Energy integration.
 */
module.exports = class whatwattGoDevice extends Homey.Device {

  constructor(...args) {
    super(...args);
    
    // Initialize event stream reference for cleanup
    this.eventStream = null;
  }

  /**
   * Tests connection to the whatwatt device and starts live data streaming.
   * Called when the device is first initialized.
   */
  async onInit() {
    this.log('whatwatt Go Device has been initialized');
    
    try {
      await this._testConnection();
      this._initializeEventStream();
    } catch (error) {
      this.error('Failed to initialize device:', error.message);
      throw error;
    }
  }

  /**
   * Handles device addition to Homey.
   */
  async onAdded() {
    this.log('whatwatt Go Device has been added');
  }

  /**
   * Reinitializes the connection when connection settings change.
   * This allows users to update credentials without removing and re-adding the device.
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('whatwatt Go Device settings were changed:', changedKeys);
    
    const connectionChanged = changedKeys.some(key => 
      ['https', 'username', 'password', 'timeout'].includes(key)
    );
    
    if (connectionChanged) {
      this.log('Connection settings changed, reinitializing...');
      await this._reinitializeConnection(newSettings);
      return 'Connection settings updated successfully';
    }
  }

  /**
   * Cleans up resources when the device is removed from Homey.
   */
  async onDeleted() {
    this.log('whatwatt Go Device has been deleted');
    this._cleanup();
  }

  // ============================================================================
  // INITIALIZATION METHODS
  // ============================================================================

  /**
   * Tests the connection to the whatwatt device before starting the event stream.
   * Throws an error if the device is unreachable or credentials are invalid.
   */
  async _testConnection() {
    const store = this.getStore();
    const settings = this.getSettings();
    
    const api = new whatwattAPI({
      host: store.address,
      port: store.port || 80,
      https: settings.https || false,
      username: settings.username,
      password: settings.password,
      timeout: settings.timeout || 10000,
      device: this
    });

    this.log(`Testing connection to ${store.address}:${store.port || 80}`);
    
    const isConnected = await api.testConnection();
    if (!isConnected) {
      throw new Error('Failed to connect to whatwatt Go device');
    }
    
    this.log('Successfully connected to whatwatt Go device');
  }

  /**
   * Starts the Server-Sent Events stream to receive live data from the whatwatt device.
   * Uses SSE instead of polling to get real-time updates without overwhelming the device.
   */
  _initializeEventStream() {
    const store = this.getStore();
    const settings = this.getSettings();
    
    this.eventStream = new whatwattEventStream({
      host: store.address,
      port: store.port || 80,
      https: settings.https || false,
      username: settings.username,
      password: settings.password,
      logger: (message) => this.log(`EventStream: ${message}`),
      onData: (data) => this._handleLiveData(data),
      onConnect: () => this._onStreamConnect(),
      onError: (error) => this._onStreamError(error),
      onDisconnect: () => this._onStreamDisconnect()
    });
    
    this.eventStream.start();
  }

  /**
   * Updates connection settings and restarts the event stream if needed.
   * Only restarts when connection parameters actually change.
   */
  async _reinitializeConnection(newSettings) {
    try {
      // Test new connection
      await this._testConnection();
      
      // Update event stream settings
      if (this.eventStream) {
        const store = this.getStore();
        this.eventStream.updateSettings({
          host: store.address,
          port: store.port || 80,
          https: newSettings.https || false,
          username: newSettings.username,
          password: newSettings.password
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
   * Called when the SSE stream connects successfully.
   * Marks the device as available so Homey knows it's working.
   */
  _onStreamConnect() {
    this.log('Live data stream connected');
    
    // Prevent errors when device is being deleted during connection
    try {
      this.setAvailable().catch((error) => {
        this.log('Device unavailable or deleted, skipping setAvailable call');
      });
    } catch (error) {
      this.log('Device unavailable or deleted, skipping setAvailable call');
    }
  }

  /**
   * Called when the SSE stream encounters an error.
   * Marks the device as unavailable and schedules a reconnection attempt.
   */
  _onStreamError(error) {
    this.error('Live data stream error:', error);
    
    // Prevent errors when device is being deleted during error handling
    try {
      this.setUnavailable('Live data stream disconnected').catch((error) => {
        this.log('Device unavailable or deleted, skipping setUnavailable call');
      });
    } catch (error) {
      this.log('Device unavailable or deleted, skipping setUnavailable call');
    }
  }

  /**
   * Called when the SSE stream disconnects.
   * Marks the device as unavailable until the stream reconnects.
   */
  _onStreamDisconnect() {
    this.log('Live data stream disconnected');
    
    // Prevent errors when device is being deleted during disconnection
    try {
      this.setUnavailable('Live data stream disconnected').catch((error) => {
        this.log('Device unavailable or deleted, skipping setUnavailable call');
      });
    } catch (error) {
      this.log('Device unavailable or deleted, skipping setUnavailable call');
    }
  }

  /**
   * Processes incoming data from the SSE stream and updates device capabilities.
   * Converts whatwatt data format to Homey capabilities and handles unit conversions.
   */
  async _handleLiveData(data) {
    try {
      // Log initial data reception to help with debugging
      if (!this._firstDataReceived) {
        this.log('First data packet received, updating capabilities...');
        this.log('Available data fields:', Object.keys(data).join(', '));
        this._firstDataReceived = true;
      }
      
      // Total power consumption and export (whatwatt provides kW, Homey expects W)
      await updateCapability(this, 'measure_power', this._convertPower(data.P_In));
      await updateCapability(this, 'measure_power.export', this._convertPower(data.P_Out));
      
      // Individual phase power consumption - helps identify which phase has high load
      await updateCapability(this, 'measure_power.phase1', this._convertPower(data.P_P1_In));
      await updateCapability(this, 'measure_power.phase2', this._convertPower(data.P_P2_In));
      await updateCapability(this, 'measure_power.phase3', this._convertPower(data.P_P3_In));
      
      // Individual phase power export - shows which phase is generating power (solar)
      await updateCapability(this, 'measure_power.phase1_export', this._convertPower(data.P_P1_Out));
      await updateCapability(this, 'measure_power.phase2_export', this._convertPower(data.P_P2_Out));
      await updateCapability(this, 'measure_power.phase3_export', this._convertPower(data.P_P3_Out));
      
      // Phase voltages - useful for detecting voltage drops or power quality issues
      await updateCapability(this, 'measure_voltage.phase1', data.V_P1);
      await updateCapability(this, 'measure_voltage.phase2', data.V_P2);
      await updateCapability(this, 'measure_voltage.phase3', data.V_P3);
      
      // Phase currents - helps identify overloaded circuits or phases
      await updateCapability(this, 'measure_current.phase1', data.I_P1);
      await updateCapability(this, 'measure_current.phase2', data.I_P2);
      await updateCapability(this, 'measure_current.phase3', data.I_P3);
      
      // Cumulative energy counters - Homey Energy uses these for consumption reports
      await updateCapability(this, 'meter_power.imported', data.E_In);
      await updateCapability(this, 'meter_power.exported', data.E_Out);
      
      // Tariff-based counters - some meters have different rates for day/night usage
      await updateCapability(this, 'meter_power.imported_tariff1', data.E_In_T1);
      await updateCapability(this, 'meter_power.imported_tariff2', data.E_In_T2);
      await updateCapability(this, 'meter_power.exported_tariff1', data.E_Out_T1);
      await updateCapability(this, 'meter_power.exported_tariff2', data.E_Out_T2);
      
      // Power quality metrics - reactive power and power factor indicate efficiency
      await updateCapability(this, 'measure_power_reactive_in', this._convertPower(data.rP_In));
      await updateCapability(this, 'measure_power_reactive_out', this._convertPower(data.rP_Out));
      await updateCapability(this, 'measure_power_factor', data.PF);
      
    } catch (error) {
      this.error('Error handling live data:', error.message);
    }
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  /**
   * Converts power values from kW to W.
   * whatwatt provides power in kW, but Homey expects W.
   */
  _convertPower(value) {
    if (value === null || value === undefined || isNaN(value)) {
      return null;
    }
    return value * 1000;
  }

  /**
   * Stops the event stream and cleans up resources.
   * Called when the device is deleted or the driver is unloaded.
   */
  _cleanup() {
    if (this.eventStream) {
      this.eventStream.stop();
      this.eventStream = null;
    }
  }
};