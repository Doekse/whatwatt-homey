'use strict';

const Homey = require('homey');
const whatwattAPI = require('../../lib/whatwattapi');
const whatwattEventStream = require('../../lib/eventstream');
const { updateCapability, setupCapability, convertPower, convertReport, updateMeterInformation, calculatePower } = require('../../lib/utils');

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
      this._initializeEventStream();
    } catch (error) {
      this.log('Initial connection failed, attempting IP discovery and retry...');
      
      try {
        // Attempt to discover the device's current IP address to handle network changes
        const { refreshDeviceIP } = require('../../lib/utils');
        const ipResult = await refreshDeviceIP(this, this.homey.drivers.getDriver('whatwatt-go'));
        
        if (ipResult.success && ipResult.ipUpdated) {
          this.log('IP address updated, retrying connection...');
          await this._testConnection();
          this._initializeEventStream();
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
      await this._setupCapabilities();
      await this._setupMeterInformation();
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
  async _setupCapabilities() {
    this.log('Setting up device capabilities');
    
    // Build connection parameters from device configuration
    const store = this.getStore();
    const settings = this.getSettings();

    // Retrieve device-specific password from Homey manager settings
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

    // Convert REST API response to standardized format for consistent processing
    const sseData = convertReport(data);

    // Calculate net power values to handle bidirectional energy flow
    const powerData = calculatePower(sseData);
    
    // Set up net power capabilities with proper bidirectional flow handling
    // Values are already in watts from convertReport, no additional conversion needed
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
  async _setupMeterInformation() {
    this.log('Setting up meter information');
    
    // Build connection parameters from device configuration
    const store = this.getStore();
    const settings = this.getSettings();

    // Retrieve device-specific password from Homey manager settings
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

    // Retrieve comprehensive system information from the meter
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
    
    // Check if any connection-affecting settings were modified
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
   * Clean up resources when device is removed.
   * 
   * Stops active data streams and releases references to prevent memory leaks
   * and orphaned network connections after device removal.
   */
  async onDeleted() {
    this.log('whatwatt Go Device has been deleted');
    // Prevent any pending async operations from executing
    this._isDeleted = true;
    
    // Clean up active event stream to prevent resource leaks
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
    // Prevent any pending async operations from executing
    this._isDeleted = true;
    
    // Clean up active event stream to prevent resource leaks
    if (this.eventStream) {
      this.eventStream.stop();
      this.eventStream = null;
    }
  }

  // ============================================================================
  // INITIALIZATION METHODS
  // ============================================================================

  /**
   * Test device connectivity and validate credentials.
   * 
   * Performs connection validation to ensure the device is reachable and
   * credentials are valid before establishing the live data stream.
   */
  async _testConnection() {
    const store = this.getStore();
    const settings = this.getSettings();
    
    // Retrieve device-specific password from Homey manager settings
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
   * Initialize Server-Sent Events stream for real-time meter data.
   * 
   * Establishes a persistent connection to receive live meter readings efficiently.
   * Uses SSE instead of polling to minimize device load and ensure timely updates.
   */
  _initializeEventStream() {
    const store = this.getStore();
    const settings = this.getSettings();
    
    // Retrieve device-specific password from Homey manager settings
    const passwordKey = `password_${this.getData().id}`;
    const password = this.homey.settings.get(passwordKey);
    
    this.eventStream = new whatwattEventStream({
      homey: this.homey,
      host: store.address,
      port: store.port || 80,
      https: settings.https || false,
      username: settings.username,
      password: password,
      heartbeatTimeout: 300000,
      logger: (message) => this.log(`[EventStream] ${message}`),
      onData: (data) => this._handleLiveData(data),
      onConnect: () => this._onStreamConnect(),
      onError: (error) => this._onStreamError(error),
      onDisconnect: () => this._onStreamDisconnect(),
      device: this,
      driver: this.homey.drivers.getDriver('whatwatt-go')
    });
    
    this.eventStream.start();
  }

  /**
   * Update connection parameters and reinitialize the event stream.
   * 
   * Validates new connection settings and updates the active event stream
   * configuration when connection parameters are modified.
   */
  async _reinitializeConnection(newSettings) {
    try {
      // Verify connectivity with new settings before applying changes
      await this._testConnection();
      
      // Update existing event stream with new configuration
      if (this.eventStream) {
        const store = this.getStore();
        // Retrieve device-specific password from Homey manager settings
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
   * Handle successful event stream connection.
   * 
   * Marks the device as available when the SSE connection is established,
   * indicating the device is online and ready to receive live data.
   */
  _onStreamConnect() {
    this.log('Live data stream connected');
    
    // Safely update device availability status, handling potential cleanup scenarios
    try {
      this.setAvailable().catch((error) => {
        this.log('Device unavailable or deleted, skipping setAvailable call');
      });
    } catch (error) {
      this.log('Device unavailable or deleted, skipping setAvailable call');
    }
  }

  /**
   * Handle event stream errors.
   * 
   * Marks the device as unavailable when the SSE stream encounters errors,
   * indicating temporary connectivity issues to the user.
   */
  _onStreamError(error) {
    this.error('Live data stream error:', error);
    
    // Safely update device availability status, handling potential cleanup scenarios
    try {
      this.setUnavailable('Live data stream disconnected').catch((error) => {
        this.log('Device unavailable or deleted, skipping setUnavailable call');
      });
    } catch (error) {
      this.log('Device unavailable or deleted, skipping setUnavailable call');
    }
  }

  /**
   * Handle event stream disconnection.
   * 
   * Marks the device as unavailable when the SSE connection is lost,
   * signaling temporary connectivity issues to the user.
   */
  _onStreamDisconnect() {
    this.log('Live data stream disconnected');
    
    // Safely update device availability status, handling potential cleanup scenarios
    try {
      this.setUnavailable('Live data stream disconnected').catch((error) => {
        this.log('Device unavailable or deleted, skipping setUnavailable call');
      });
    } catch (error) {
      this.log('Device unavailable or deleted, skipping setUnavailable call');
    }
  }

  /**
   * Process live meter data and update device capabilities.
   * 
   * Receives real-time meter readings from the SSE stream and updates all
   * relevant device capabilities. Only processes data after initial setup
   * is complete to ensure proper capability configuration.
   */
  async _handleLiveData(data) {
    // Exit early if device is being removed to prevent errors
    if (this._isDeleted) {
      return;
    }

    // Skip updates until initial capability setup is finished
    if (!this._setupCompleted) {
      return;
    }

    try {
      
      // Calculate net power values to handle bidirectional energy flow
      const powerData = calculatePower(data);
      
      // Update net power capabilities with proper bidirectional flow handling
      await updateCapability(this, 'measure_power', convertPower(powerData.total)).catch(this.error);
      
      // Update per-phase net power values
      await updateCapability(this, 'measure_power.phase1', convertPower(powerData.phase1)).catch(this.error);
      await updateCapability(this, 'measure_power.phase2', convertPower(powerData.phase2)).catch(this.error);
      await updateCapability(this, 'measure_power.phase3', convertPower(powerData.phase3)).catch(this.error);
      
      // Update voltage readings for all phases
      await updateCapability(this, 'measure_voltage', data.V_P1).catch(this.error);
      await updateCapability(this, 'measure_voltage.phase2', data.V_P2).catch(this.error);
      await updateCapability(this, 'measure_voltage.phase3', data.V_P3).catch(this.error);
      
      // Update current readings for all phases
      await updateCapability(this, 'measure_current', data.I_P1).catch(this.error);
      await updateCapability(this, 'measure_current.phase2', data.I_P2).catch(this.error);
      await updateCapability(this, 'measure_current.phase3', data.I_P3).catch(this.error);
      
      // Update cumulative energy meters for Homey Energy integration
      await updateCapability(this, 'meter_power', data.E_In).catch(this.error);
      await updateCapability(this, 'meter_power.exported', data.E_Out).catch(this.error);
      
      // Update time-of-use tariff energy counters
      await updateCapability(this, 'meter_power.imported_tariff1', data.E_In_T1).catch(this.error);
      await updateCapability(this, 'meter_power.imported_tariff2', data.E_In_T2).catch(this.error);
      await updateCapability(this, 'meter_power.exported_tariff1', data.E_Out_T1).catch(this.error);
      await updateCapability(this, 'meter_power.exported_tariff2', data.E_Out_T2).catch(this.error);
      
      // Update power quality metrics for reactive power and power factor
      await updateCapability(this, 'measure_power_reactive_in', convertPower(data.rP_In)).catch(this.error);
      await updateCapability(this, 'measure_power_reactive_out', convertPower(data.rP_Out)).catch(this.error);
      await updateCapability(this, 'measure_power_factor', data.PF).catch(this.error);
      
    } catch (error) {
      this.error('Error handling live data:', error.message);
    }
  }


};