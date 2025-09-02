'use strict';

const Homey = require('homey');
const whatwattAPI = require('../../lib/whatwattapi');
const whatwattEventStream = require('../../lib/eventstream');
const { updateCapability, setupCapability, convertPower, convertReport, updateMeterInformation, calculatePower } = require('../../lib/utils');

/**
 * Homey device driver for whatwatt Go.
 *
 * Establishes connectivity, streams live meter data via SSE, and maps readings to Homey
 * capabilities. Defers live updates until initial capability and meter info setup completes.
 */
module.exports = class whatwattGoDevice extends Homey.Device {

  constructor(...args) {
    super(...args);
    
    // Reference to active SSE stream for lifecycle management
    this.eventStream = null;

    // Guards against updates after device removal
    this._isDeleted = false;

    // Indicates whether initial capability and meter info setup finished
    this._setupCompleted = this.getSetting('_setupCompleted') || false;
    this.log(`Device setup completed flag: ${this._setupCompleted}`);
  }

  /**
   * Initialize connectivity and start live streaming after a connectivity check.
   * Fail fast if the device is unreachable or credentials are invalid.
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
   * During add, fetch initial data and configure capabilities/meter info in the device settings.
   */
  async onAdded() {
    this.log('whatwatt Go Device has been added');

    try {
      await this._setupCapabilities();
      await this._setupMeterInformation();
    } catch (error) {
      this.error('Failed to set up device during device addition:', error.message);
    }
  }

  /**
   * Fetch initial readings and configure capabilities. Used on add/repair.
   * Ensures downstream live updates operate on a complete, normalized capability set.
   */
  async _setupCapabilities() {
    this.log('Setting up device capabilities');
    
    // Use device store/settings for connection parameters
    const store = this.getStore();
    const settings = this.getSettings();

    // Retrieve password from ManagerSettings using device ID
    const passwordKey = `password_${this.getData().id}`;
    const password = this.homey.settings.get(passwordKey);
    
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

    // Normalize REST payload to SSE shape to keep capability handling consistent
    const sseData = convertReport(data);

    // Compute net power (import - export) for bidirectional flow
    const powerData = calculatePower(sseData);
    
    // Initialize net power capabilities (import positive, export negative)
    // Note: powerData values are already in W (converted by convertReport), so no need for convertPower()
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

    // Allow live updates after initial setup
    this._setupCompleted = true;
    
    // Persist setup completion to survive restarts
    await this.setSettings({ _setupCompleted: true });
  }

  /**
   * Fetch and persist meter information. Used during add/repair.
   */
  async _setupMeterInformation() {
    this.log('Setting up meter information');
    
    // Use device store/settings for connection parameters
    const store = this.getStore();
    const settings = this.getSettings();

    // Retrieve password from ManagerSettings using device ID
    const passwordKey = `password_${this.getData().id}`;
    const password = this.homey.settings.get(passwordKey);
    
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

    // Fetch system info containing meter details
    const systemInfo = await api.getSystemInfo();

    // Persist meter details to device settings
    await updateMeterInformation(this, systemInfo, null);

    this.log('Meter information setup completed');
  }

  /**
   * Handle settings changes and reinitialize the connection when credentials change.
   * Enables updating connection parameters without re-adding the device.
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
   * Stop streaming and release resources when the device is removed to avoid orphaned connections.
   */
  async onDeleted() {
    this.log('whatwatt Go Device has been deleted');
    // Prevent further async updates
    this._isDeleted = true;
    
    // Stop SSE stream and release reference
    if (this.eventStream) {
      this.eventStream.stop();
      this.eventStream = null;
    }
  }

  // ============================================================================
  // INITIALIZATION METHODS
  // ============================================================================

  /**
   * Validate connectivity before starting the event stream to ensure reachability and valid credentials.
   */
  async _testConnection() {
    const store = this.getStore();
    const settings = this.getSettings();
    
    // Retrieve password from ManagerSettings using device ID
    const passwordKey = `password_${this.getData().id}`;
    const password = this.homey.settings.get(passwordKey);
    
    if (password) {
      this.log('Using password for device authentication');
    } else {
      this.log('No password configured for device authentication');
    }
    
    this.log(`Testing connection to ${store.address}:${store.port || 80}`);
    
    const whatwattAPI = require('../../lib/whatwattapi');
    const isConnected = await whatwattAPI.testDeviceConnection(
      { host: store.address, port: store.port },
      password,
      settings.timeout || 10000
    );
    
    if (!isConnected) {
      throw new Error('Failed to connect to whatwatt Go device');
    }
    
    this.log('Successfully connected to whatwatt Go device');
  }

  /**
   * Establish Server-Sent Events stream for real-time data.
   * Prefer SSE over polling to reduce device load. If a polling fallback is introduced,
   * normalize data with convertReport() to preserve calculatePower() assumptions.
   */
  _initializeEventStream() {
    const store = this.getStore();
    const settings = this.getSettings();
    
    // Retrieve password from ManagerSettings using device ID
    const passwordKey = `password_${this.getData().id}`;
    const password = this.homey.settings.get(passwordKey);
    
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
   * Update connection settings and restart the event stream when connection parameters change.
   */
  async _reinitializeConnection(newSettings) {
    try {
      // Validate connectivity with updated settings
      await this._testConnection();
      
      // Apply new settings to the existing event stream
      if (this.eventStream) {
        const store = this.getStore();
        // Retrieve password from ManagerSettings using device ID
        const passwordKey = `password_${this.getData().id}`;
        const password = this.homey.settings.get(passwordKey);
        
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
   * Mark device as available when the SSE stream connects.
   */
  _onStreamConnect() {
    this.log('Live data stream connected');
    
    // Avoid errors if device is being removed
    try {
      this.setAvailable().catch((error) => {
        this.log('Device unavailable or deleted, skipping setAvailable call');
      });
    } catch (error) {
      this.log('Device unavailable or deleted, skipping setAvailable call');
    }
  }

  /**
   * Mark device as unavailable when the SSE stream encounters an error.
   */
  _onStreamError(error) {
    this.error('Live data stream error:', error);
    
    // Avoid errors if device is being removed
    try {
      this.setUnavailable('Live data stream disconnected').catch((error) => {
        this.log('Device unavailable or deleted, skipping setUnavailable call');
      });
    } catch (error) {
      this.log('Device unavailable or deleted, skipping setUnavailable call');
    }
  }

  /**
   * Mark device as unavailable when the SSE stream disconnects.
   * Indicates temporary unreachability to Homey.
   */
  _onStreamDisconnect() {
    this.log('Live data stream disconnected');
    
    // Avoid errors if device is being removed
    try {
      this.setUnavailable('Live data stream disconnected').catch((error) => {
        this.log('Device unavailable or deleted, skipping setUnavailable call');
      });
    } catch (error) {
      this.log('Device unavailable or deleted, skipping setUnavailable call');
    }
  }

  /**
   * Handle live readings and map them to capabilities.
   * Runs only after initial setup; relies on normalized fields expected by calculatePower().
   */
  async _handleLiveData(data) {
    // Do nothing if device is being removed
    if (this._isDeleted) {
      return;
    }

    // Defer until initial setup completes
    if (!this._setupCompleted) {
      return;
    }

    try {
      
      // Compute net power (import - export)
      const powerData = calculatePower(data);
      
      // Net power (import positive, export negative)
      await updateCapability(this, 'measure_power', convertPower(powerData.total));
      
      // Net power per phase
      await updateCapability(this, 'measure_power.phase1', convertPower(powerData.phase1));
      await updateCapability(this, 'measure_power.phase2', convertPower(powerData.phase2));
      await updateCapability(this, 'measure_power.phase3', convertPower(powerData.phase3));
      
      // Phase voltages
      await updateCapability(this, 'measure_voltage', data.V_P1);
      await updateCapability(this, 'measure_voltage.phase2', data.V_P2);
      await updateCapability(this, 'measure_voltage.phase3', data.V_P3);
      
      // Phase currents
      await updateCapability(this, 'measure_current', data.I_P1);
      await updateCapability(this, 'measure_current.phase2', data.I_P2);
      await updateCapability(this, 'measure_current.phase3', data.I_P3);
      
      // Cumulative energy counters (used by Homey Energy)
      await updateCapability(this, 'meter_power', data.E_In);
      await updateCapability(this, 'meter_power.exported', data.E_Out);
      
      // Tariff-specific energy counters
      await updateCapability(this, 'meter_power.imported_tariff1', data.E_In_T1);
      await updateCapability(this, 'meter_power.imported_tariff2', data.E_In_T2);
      await updateCapability(this, 'meter_power.exported_tariff1', data.E_Out_T1);
      await updateCapability(this, 'meter_power.exported_tariff2', data.E_Out_T2);
      
      // Power quality metrics: reactive power and power factor
      await updateCapability(this, 'measure_power_reactive_in', convertPower(data.rP_In));
      await updateCapability(this, 'measure_power_reactive_out', convertPower(data.rP_Out));
      await updateCapability(this, 'measure_power_factor', data.PF);
      
    } catch (error) {
      this.error('Error handling live data:', error.message);
    }
  }


};