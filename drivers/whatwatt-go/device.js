'use strict';

const Homey = require('homey');
const whatwattAPI = require('../../lib/whatwattapi');
const whatwattEventStream = require('../../lib/eventstream');
const { updateCapability, setupCapability, convertPower, convertReport, updateMeterInformation } = require('../../lib/utils');

/**
 * whatwatt Go Device Driver for Homey
 * 
 * Connects to whatwatt Go smart meters and exposes their data as Homey capabilities.
 * Handles live data streaming, capability management, and Homey Energy integration.
 */
module.exports = class whatwattGoDevice extends Homey.Device {

  constructor(...args) {
    super(...args);
    
    // Event stream reference for cleanup
    this.eventStream = null;

    // Prevents updates after device removal
    this._isDeleted = false;

    // Tracks whether initial capability setup has completed
    this._setupCompleted = this.getSetting('_setupCompleted') || false;
    this.log(`Device setup completed flag: ${this._setupCompleted}`);
  }

  /**
   * Initializes device connection and starts live data streaming.
   * Tests connectivity before establishing the event stream.
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
   * Sets up device capabilities and meter information during device addition.
   * Fetches initial data before live updates begin.
   */
  async onAdded() {
    this.log('whatwatt Go Device has been added');

    // Initialize capabilities and meter info during onboarding
    // Live updates will be handled by the event stream once setup is complete
    try {
      await this._setupCapabilities();
      await this._setupMeterInformation();
    } catch (error) {
      this.error('Failed to set up device during device addition:', error.message);
    }
  }

  /**
   * Configures device capabilities by fetching initial data.
   * Called during device addition and repair to establish or re-establish capabilities.
   * Capabilities without data are removed.
   */
  async _setupCapabilities() {
    this.log('Setting up device capabilities');
    
    // Use connection options consistent with other API calls
    const store = this.getStore();
    const settings = this.getSettings();

    // Prioritize password from store (set during pairing) over settings
    const password = store.password || settings.password;
    
    if (password) {
      this.log('Using password for device authentication during setup');
    } else {
      this.log('No password configured for device authentication during setup');
    }
    
    const api = new whatwattAPI({
      host: store.address,
      port: store.port || 80,
      https: settings.https || false,
      username: settings.username,
      password: password,
      timeout: settings.timeout || 10000,
      device: this,
    });

    const data = await api.getReport();

    // Convert REST API format to SSE format for consistent capability handling
    const sseData = convertReport(data);

    // Initialize all capabilities that the event stream will later update
    await setupCapability(this, 'measure_power', sseData.P_In);
    await setupCapability(this, 'measure_power.export', sseData.P_Out);

    await setupCapability(this, 'measure_power.phase1', sseData.P_P1_In);
    await setupCapability(this, 'measure_power.phase2', sseData.P_P2_In);
    await setupCapability(this, 'measure_power.phase3', sseData.P_P3_In);

    await setupCapability(this, 'measure_power.phase1_export', sseData.P_P1_Out);
    await setupCapability(this, 'measure_power.phase2_export', sseData.P_P2_Out);
    await setupCapability(this, 'measure_power.phase3_export', sseData.P_P3_Out);

    await setupCapability(this, 'measure_voltage.phase1', sseData.V_P1);
    await setupCapability(this, 'measure_voltage.phase2', sseData.V_P2);
    await setupCapability(this, 'measure_voltage.phase3', sseData.V_P3);

    await setupCapability(this, 'measure_current.phase1', sseData.I_P1);
    await setupCapability(this, 'measure_current.phase2', sseData.I_P2);
    await setupCapability(this, 'measure_current.phase3', sseData.I_P3);

    await setupCapability(this, 'meter_power.imported', sseData.E_In);
    await setupCapability(this, 'meter_power.exported', sseData.E_Out);

    await setupCapability(this, 'meter_power.imported_tariff1', sseData.E_In_T1);
    await setupCapability(this, 'meter_power.imported_tariff2', sseData.E_In_T2);
    await setupCapability(this, 'meter_power.exported_tariff1', sseData.E_Out_T1);
    await setupCapability(this, 'meter_power.exported_tariff2', sseData.E_Out_T2);

    await setupCapability(this, 'measure_power_reactive_in', sseData.rP_In);
    await setupCapability(this, 'measure_power_reactive_out', sseData.rP_Out);
    await setupCapability(this, 'measure_power_factor', sseData.PF);

    this.log('Initial capability setup completed');

    // Mark setup as complete
    this._setupCompleted = true;
    
    // Persist setup completion status
    await this.setSettings({ _setupCompleted: true });
  }

  /**
   * Fetches and stores meter information from the device.
   * Called during device addition and repair.
   */
  async _setupMeterInformation() {
    this.log('Setting up meter information');
    
    // Use connection options consistent with other API calls
    const store = this.getStore();
    const settings = this.getSettings();

    // Prioritize password from store (set during pairing) over settings
    const password = store.password || settings.password;
    
    if (password) {
      this.log('Using password for device authentication during meter info setup');
    } else {
      this.log('No password configured for device authentication during meter info setup');
    }
    
    const api = new whatwattAPI({
      host: store.address,
      port: store.port || 80,
      https: settings.https || false,
      username: settings.username,
      password: password,
      timeout: settings.timeout || 10000,
      device: this,
    });

    // Fetch system info which contains all meter information
    const systemInfo = await api.getSystemInfo();

    // Update meter information in device settings
    await updateMeterInformation(this, systemInfo, null);

    this.log('Meter information setup completed');
  }

  /**
   * Handles settings changes and reinitializes connection when credentials are updated.
   * Allows users to update connection settings without re-adding the device.
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
   * Cleans up resources and stops the event stream when the device is removed.
   * Prevents memory leaks.
   */
  async onDeleted() {
    this.log('whatwatt Go Device has been deleted');
    // Mark device as deleted to prevent ongoing async operations
    this._isDeleted = true;
    
    // Stop the event stream and clean up resources
    if (this.eventStream) {
      this.eventStream.stop();
      this.eventStream = null;
    }
  }

  // ============================================================================
  // INITIALIZATION METHODS
  // ============================================================================

  /**
   * Validates connection to the whatwatt device before starting the event stream.
   * Ensures the device is reachable and credentials are valid.
   */
  async _testConnection() {
    const store = this.getStore();
    const settings = this.getSettings();
    
    // Prioritize password from store (set during pairing) over settings
    const password = store.password || settings.password;
    
    if (password) {
      this.log('Using password for device authentication');
    } else {
      this.log('No password configured for device authentication');
    }
    
    const api = new whatwattAPI({
      host: store.address,
      port: store.port || 80,
      https: settings.https || false,
      username: settings.username,
      password: password,
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
   * Establishes Server-Sent Events stream for real-time data from the whatwatt device.
   * Uses SSE instead of polling to minimize device load.
   */
  _initializeEventStream() {
    const store = this.getStore();
    const settings = this.getSettings();
    
    // Prioritize password from store (set during pairing) over settings
    const password = store.password || settings.password;
    
    this.eventStream = new whatwattEventStream({
      host: store.address,
      port: store.port || 80,
      https: settings.https || false,
      username: settings.username,
      password: password,
      logger: (message) => this.log(`[EventStream] ${message}`),
      onData: (data) => this._handleLiveData(data),
      onConnect: () => this._onStreamConnect(),
      onError: (error) => this._onStreamError(error),
      onDisconnect: () => this._onStreamDisconnect()
    });
    
    this.eventStream.start();
  }

  /**
   * Updates connection settings and restarts the event stream when credentials change.
   * Only restarts when connection parameters actually change.
   */
  async _reinitializeConnection(newSettings) {
    try {
      // Test new connection
      await this._testConnection();
      
      // Update event stream settings
      if (this.eventStream) {
        const store = this.getStore();
        // Prioritize password from store (set during pairing) over new settings
        const password = store.password || newSettings.password;
        
        this.eventStream.updateSettings({
          host: store.address,
          port: store.port || 80,
          https: newSettings.https || false,
          username: newSettings.username,
          password: password
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
   * Marks device as available when the SSE stream connects successfully.
   * Informs Homey that the device is operational.
   */
  _onStreamConnect() {
    this.log('Live data stream connected');
    
    // Prevent errors when device is being deleted
    try {
      this.setAvailable().catch((error) => {
        this.log('Device unavailable or deleted, skipping setAvailable call');
      });
    } catch (error) {
      this.log('Device unavailable or deleted, skipping setAvailable call');
    }
  }

  /**
   * Marks device as unavailable when the SSE stream encounters an error.
   * Schedules reconnection attempts.
   */
  _onStreamError(error) {
    this.error('Live data stream error:', error);
    
    // Prevent errors when device is being deleted
    try {
      this.setUnavailable('Live data stream disconnected').catch((error) => {
        this.log('Device unavailable or deleted, skipping setUnavailable call');
      });
    } catch (error) {
      this.log('Device unavailable or deleted, skipping setUnavailable call');
    }
  }

  /**
   * Marks device as unavailable when the SSE stream disconnects.
   * Indicates to Homey that the device is temporarily unreachable.
   */
  _onStreamDisconnect() {
    this.log('Live data stream disconnected');
    
    // Prevent errors when device is being deleted
    try {
      this.setUnavailable('Live data stream disconnected').catch((error) => {
        this.log('Device unavailable or deleted, skipping setUnavailable call');
      });
    } catch (error) {
      this.log('Device unavailable or deleted, skipping setUnavailable call');
    }
  }

  /**
   * Processes incoming live data from the SSE stream and updates device capabilities.
   * Converts whatwatt data format to Homey capabilities and handles unit conversions.
   * Only processes data after initial setup is complete.
   */
  async _handleLiveData(data) {
    // Skip processing if device is marked as deleted
    if (this._isDeleted) {
      return;
    }

    // Ignore live data until initial capability setup is finished
    if (!this._setupCompleted) {
      return;
    }

    try {
      
      // Total power consumption and export (whatwatt provides kW, Homey expects W)
      await updateCapability(this, 'measure_power', convertPower(data.P_In));
      await updateCapability(this, 'measure_power.export', convertPower(data.P_Out));
      
      // Individual phase power consumption - helps identify which phase has high load
      await updateCapability(this, 'measure_power.phase1', convertPower(data.P_P1_In));
      await updateCapability(this, 'measure_power.phase2', convertPower(data.P_P2_In));
      await updateCapability(this, 'measure_power.phase3', convertPower(data.P_P3_In));
      
      // Individual phase power export - shows which phase is generating power (solar)
      await updateCapability(this, 'measure_power.phase1_export', convertPower(data.P_P1_Out));
      await updateCapability(this, 'measure_power.phase2_export', convertPower(data.P_P2_Out));
      await updateCapability(this, 'measure_power.phase3_export', convertPower(data.P_P3_Out));
      
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
      await updateCapability(this, 'measure_power_reactive_in', convertPower(data.rP_In));
      await updateCapability(this, 'measure_power_reactive_out', convertPower(data.rP_Out));
      await updateCapability(this, 'measure_power_factor', data.PF);
      
    } catch (error) {
      this.error('Error handling live data:', error.message);
    }
  }


};