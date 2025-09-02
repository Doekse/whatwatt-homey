'use strict';

const Homey = require('homey');

/**
 * Driver for whatwatt Go devices.
 * Handles device discovery, pairing, and repair operations with password authentication.
 */
module.exports = class whatwattGoDriver extends Homey.Driver {

  /**
   * Sets up the driver instance when Homey starts.
   */
  async onInit() {
    this.log('whatwatt Go Driver has been initialized');
  }

  /**
   * Discovers available whatwatt Go devices for pairing.
   * Converts mDNS discovery results into device objects that Homey can pair with.
   * 
   * @returns {Array} Array of device objects available for pairing
   */
  async onPairListDevices() {
    const discoveryStrategy = this.getDiscoveryStrategy();
    const discoveryResults = discoveryStrategy.getDiscoveryResults();

    const devices = Object.values(discoveryResults).map(discoveryResult => {
      // Remove "WebUI" suffix from device names and use last 6 chars of ID as fallback
      const deviceName = (discoveryResult.name || `whatwatt Go ${discoveryResult.id.slice(-6)}`).replace(/\s+WebUI\s*$/i, '');
      
      return {
        name: deviceName,
        data: {
          id: discoveryResult.id,
        },
        store: {
          address: discoveryResult.address,
          port: discoveryResult.port || 80,
        },
        settings: {
          // Default settings will be configured by the user during pairing
        }
      };
    });

    this.log('Found whatwatt Go devices:', devices.map(device => `${device.name} (${device.data.id})`));
    return devices;
  }

  /**
   * Manages the device pairing process with conditional password authentication.
   * Tests device connectivity to determine if password is required, then guides user through appropriate flow.
   */
  async onPair(session) {
    let selectedDevice = null;
    let cachedPassword = '';

    // Cache password for use across multiple pairing steps
    session.setHandler('password_entered', async ({ password }) => {
      cachedPassword = (password || '').trim();
      this.log('Password received via password_entered handler:', cachedPassword ? '***' : '(none)');
      return true;
    });

    // Validate password by testing device connection
    session.setHandler('test_password', async () => {
      if (!selectedDevice) {
        return { success: false, message: 'No device selected' };
      }

      try {
        const whatwattAPI = require('../../lib/whatwattapi');
        const connectionSuccess = await whatwattAPI.testDeviceConnection(
          { host: selectedDevice.store.address, port: selectedDevice.store.port },
          cachedPassword
        );
        
        if (!connectionSuccess) {
          return { success: false, message: 'Password is incorrect or connection failed' };
        }
        
        return { success: true };
      } catch (error) {
        this.log('Password test error during pairing:', error.message);
        return { success: false, message: `Connection test failed: ${error.message}` };
      }
    });

    // Provide device list to pairing interface
    session.setHandler('list_devices', async () => {
      const devices = await this.onPairListDevices();
      return devices;
    });

    // Handle view navigation and determine authentication flow
    session.setHandler('showView', async (viewId) => {
      if (viewId === 'loading') {
        // Get the selected device from the session (Homey handles selection internally)
        try {
          const devices = await this.onPairListDevices();
          if (devices.length > 0) {
            selectedDevice = devices[0];
            this.log(`Using selected device: ${selectedDevice.name} (${selectedDevice.data.id})`);
          } else {
            this.log('No devices available, cannot proceed');
            return;
          }
        } catch (error) {
          this.log('Error getting devices from session:', error.message);
          return;
        }

        try {
          this.log('Testing connection during pairing for device:', selectedDevice.name);
          
          // Test connection without password to determine if authentication is required
          const whatwattAPI = require('../../lib/whatwattapi');
          const connectionSuccess = await whatwattAPI.testDeviceConnection(
            { host: selectedDevice.store.address, port: selectedDevice.store.port },
            '',
            5000
          );
          
          if (connectionSuccess) {
            // No password needed, proceed directly to device creation
            this.log('Device does not require password, proceeding to device creation');
            await session.showView('add_whatwatt_devices');
          } else {
            // Password required, show password test view
            this.log('Device requires password, showing password test view');
            await session.showView('pair_password');
          }
        } catch (error) {
          this.log('Connection test failed, assuming password is required:', error.message);
          // If connection fails, assume password is required
          await session.showView('pair_password');
        }
      }
      
      if (viewId === 'pair_password') {
        // Always show password test view when navigating to it
        return;
      }
      
      if (viewId === 'add_whatwatt_devices') {
        // Store the tested password in ManagerSettings for the device
        if (selectedDevice && cachedPassword) {
          // Store password in ManagerSettings using device ID as key
          const passwordKey = `password_${selectedDevice.data.id}`;
          await this.homey.settings.set(passwordKey, cachedPassword);
          this.log(`Added tested password to ManagerSettings for device ${selectedDevice.name} (${selectedDevice.data.id})`);
        }
      }
    });
  }

  /**
   * Manages device repair process including password testing and capability reconfiguration.
   * Allows users to update credentials and refresh device state without re-pairing.
   */
  async onRepair(session, device) {
    let cachedPassword = '';

    // Cache password from repair input view
    session.setHandler('password_entered', async ({ password }) => {
      cachedPassword = (password || '').trim();
      this.log('Password received via repair password_entered handler:', cachedPassword ? '***' : '(none)');
      return true;
    });

    // Perform device repair including connection testing and capability refresh
    session.setHandler('repair_device', async () => {
      this.log('Starting device repair process');
      
      try {
        const store = device.getStore();
        const settings = device.getSettings();
        
        // Test the password first
        this.log('Testing password during repair:', cachedPassword ? '***' : '(none)');
        
        const whatwattAPI = require('../../lib/whatwattapi');
        const connectionSuccess = await whatwattAPI.testDeviceConnection(
          { host: store.address, port: store.port },
          cachedPassword,
          settings.timeout || 10000
        );
        
        if (!connectionSuccess) {
          this.log('Password test failed during repair');
          return { success: false, message: 'Password is incorrect or connection failed' };
        }
        
        this.log('Password test successful during repair');
        
        // Stop current event stream
        if (device.eventStream) {
          this.log('Stopping current event stream for repair');
          device.eventStream.stop();
          device.eventStream = null;
        }

        // Update device password in ManagerSettings
        if (cachedPassword !== undefined) {
          const passwordKey = `password_${device.getData().id}`;
          if (cachedPassword) {
            await this.homey.settings.set(passwordKey, cachedPassword);
            this.log('Updated device password in ManagerSettings during repair');
          } else {
            await this.homey.settings.unset(passwordKey);
            this.log('Removed device password from ManagerSettings during repair');
          }
        }

        // Refresh device capabilities
        this.log('Re-running capability setup during repair');
        await device._setupCapabilities();
        
        // Refresh meter information
        this.log('Re-running meter information setup during repair');
        await device._setupMeterInformation();
        
        // Restart event stream with updated credentials
        this.log('Restarting event stream after repair');
        device._initializeEventStream();
        
        this.log('Device repair completed successfully');
        return { success: true, message: 'Device repaired successfully' };
      } catch (error) {
        this.log('Device repair failed:', error.message);
        return { success: false, message: `Repair failed: ${error.message}` };
      }
    });
  }

};
