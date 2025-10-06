'use strict';

const Homey = require('homey');

/**
 * Driver for whatwatt Go devices.
 * Manages device lifecycle including discovery, pairing with conditional authentication, and repair operations.
 */
module.exports = class whatwattGoDriver extends Homey.Driver {

  /**
   * Initializes the driver when Homey starts up.
   */
  async onInit() {
    this.log('whatwatt Go Driver has been initialized');
  }

  /**
   * Performs cleanup when the driver is destroyed.
   */
  async onUninit() {
    this.log('whatwatt Go Driver has been uninitialized');
  }

  /**
   * Updates device store values with new connection information.
   * Enables repair process to persist IP address changes without requiring re-pairing.
   * 
   * @param {Homey.Device} device - The device to update
   * @param {Object} storeData - The store data to update
   */
  async updateDeviceStore(device, storeData) {
    try {
      const currentStore = device.getStore();
      const updatedStore = { ...currentStore, ...storeData };
      
      await device.setStoreValue('address', updatedStore.address);
      if (updatedStore.port) {
        await device.setStoreValue('port', updatedStore.port);
      }
      
      this.log(`Updated device store for ${device.getName()}:`, updatedStore);
    } catch (error) {
      this.error('Failed to update device store:', error.message);
      throw error;
    }
  }

  /**
   * Discovers available whatwatt Go devices for pairing.
   * Transforms mDNS discovery results into Homey-compatible device objects for the pairing interface.
   * 
   * @returns {Array} Array of device objects available for pairing
   */
  async onPairListDevices() {
    const discoveryStrategy = this.getDiscoveryStrategy();
    const discoveryResults = discoveryStrategy.getDiscoveryResults();

    const devices = Object.values(discoveryResults).map(discoveryResult => {
      // Clean device names by removing WebUI suffix and providing fallback identifier
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
          // User will configure settings during the pairing process
        }
      };
    });

    this.log('Found whatwatt Go devices:', devices.map(device => `${device.name} (${device.data.id})`));
    return devices;
  }

  /**
   * Manages the device pairing process with adaptive authentication flow.
   * Determines authentication requirements by testing connectivity, then guides user through appropriate pairing steps.
   */
  async onPair(session) {
    let selectedDevice = null;
    let cachedPassword = '';

    // Store password for reuse across pairing flow steps
    session.setHandler('password_entered', async ({ password }) => {
      cachedPassword = (password || '').trim();
      this.log('Password received via password_entered handler:', cachedPassword ? '***' : '(none)');
      return true;
    });

    // Test password validity by establishing device connection
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

    // Supply discovered devices to the pairing interface
    session.setHandler('list_devices', async () => {
      const devices = await this.onPairListDevices();
      return devices;
    });

    // Control view navigation and determine authentication requirements
    session.setHandler('showView', async (viewId) => {
      if (viewId === 'loading') {
        // Retrieve the selected device from session (Homey manages selection internally)
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
          
          // Determine authentication requirements by testing connection without password
          const whatwattAPI = require('../../lib/whatwattapi');
          const connectionSuccess = await whatwattAPI.testDeviceConnection(
            { host: selectedDevice.store.address, port: selectedDevice.store.port },
            '',
            5000
          );
          
          if (connectionSuccess) {
            // Device accessible without authentication, proceed to device creation
            this.log('Device does not require password, proceeding to device creation');
            await session.showView('add_whatwatt_devices');
          } else {
            // Authentication required, present password input interface
            this.log('Device requires password, showing password test view');
            await session.showView('pair_password');
          }
        } catch (error) {
          this.log('Connection test failed, assuming password is required:', error.message);
          // Default to password flow when connection testing fails
          await session.showView('pair_password');
        }
      }
      
      if (viewId === 'pair_password') {
        // Display password input interface when requested
        return;
      }
      
      if (viewId === 'add_whatwatt_devices') {
        // Persist validated password for device operation
        if (selectedDevice && cachedPassword) {
          const passwordKey = `password_${selectedDevice.data.id}`;
          await this.homey.settings.set(passwordKey, cachedPassword);
          this.log(`Added tested password to ManagerSettings for device ${selectedDevice.name} (${selectedDevice.data.id})`);
        }
      }
    });
  }

  /**
   * Manages device repair process for updating credentials and refreshing device state.
   * Enables users to fix connection issues and update authentication without requiring re-pairing.
   */
  async onRepair(session, device) {
    let cachedPassword = '';

    // Store password from repair interface for validation
    session.setHandler('password_entered', async ({ password }) => {
      cachedPassword = (password || '').trim();
      this.log('Password received via repair password_entered handler:', cachedPassword ? '***' : '(none)');
      return true;
    });

    // Execute repair process including connection testing and device refresh
    session.setHandler('repair_device', async () => {
      this.log('Starting device repair process');
      
      try {
        const store = device.getStore();
        const settings = device.getSettings();
        const deviceId = device.getData().id;
        
        // Attempt to discover current device IP address via mDNS
        const { refreshDeviceIP } = require('../../lib/utils');
        const ipResult = await refreshDeviceIP(device, this);
        
        if (!ipResult.success) {
          this.log('IP discovery failed, using stored IP address');
        }
        
        const connectionHost = ipResult.connectionHost;
        const connectionPort = ipResult.connectionPort;
        
        // Validate password against current device address
        this.log('Testing password during repair:', cachedPassword ? '***' : '(none)');
        
        const whatwattAPI = require('../../lib/whatwattapi');
        const connectionSuccess = await whatwattAPI.testDeviceConnection(
          { host: connectionHost, port: connectionPort },
          cachedPassword,
          settings.timeout || 10000
        );
        
        if (!connectionSuccess) {
          this.log('Password test failed during repair');
          return { success: false, message: 'Password is incorrect or connection failed' };
        }
        
        this.log('Password test successful during repair');
        
        // Halt current event stream to prevent conflicts during repair
        if (device.eventStream) {
          this.log('Stopping current event stream for repair');
          device.eventStream.stop();
          device.eventStream = null;
        }

        // Update stored password for device operation
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

        // Reconfigure device capabilities with updated credentials
        this.log('Re-running capability setup during repair');
        await device._setupCapabilities();
        
        // Refresh meter information with new connection
        this.log('Re-running meter information setup during repair');
        await device._setupMeterInformation();
        
        // Restore event stream with updated authentication
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
