'use strict';

const Homey = require('homey');

module.exports = class whatwattGoDriver extends Homey.Driver {

  /**
   * Initializes the driver when Homey starts.
   * Sets up the driver instance.
   */
  async onInit() {
    this.log('whatwatt Go Driver has been initialized');
  }

  /**
   * Discovers available whatwatt Go devices for pairing.
   * Converts mDNS discovery results into device objects.
   * 
   * @returns {Array} Array of device objects available for pairing
   */
  async onPairListDevices() {
    const discoveryStrategy = this.getDiscoveryStrategy();
    const discoveryResults = discoveryStrategy.getDiscoveryResults();

    const devices = Object.values(discoveryResults).map(discoveryResult => {
      // Clean device name by removing "WebUI" suffix and using last 6 chars of ID as fallback
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
   * Manages the device pairing process with password authentication.
   * Sets up event handlers for the custom password input view.
   */
  async onPair(session) {
    let cachedPassword = '';

    // Cache password from custom input view
    session.setHandler('password_entered', async ({ password }) => {
      cachedPassword = (password || '').trim();
      this.log('Password received via password_entered handler:', cachedPassword ? '***' : '(none)');
      return true;
    });

    // Inject cached password into device store
    session.setHandler('list_devices', async () => {
      const devices = await this.onPairListDevices();
      
      this.log(`Password from pairing: ${cachedPassword ? '***' : '(none)'}`);
      
      // Add the password to each device's store
      devices.forEach(device => {
        if (cachedPassword) {
          device.store.password = cachedPassword;
          this.log(`Added password to device ${device.name} (${device.data.id})`);
        }
      });
      
      return devices;
    });
  }

  /**
   * Manages device repair process including password testing and capability reconfiguration.
   * Allows users to update credentials without re-pairing.
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
        const api = new whatwattAPI({
          host: store.address,
          port: store.port || 80,
          https: settings.https || false,
          username: settings.username,
          password: cachedPassword,
          timeout: settings.timeout || 10000,
          device: device,
        });

        const connectionSuccess = await api.testConnection();
        
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

        // Update device password in store
        if (cachedPassword !== undefined) {
          if (cachedPassword) {
            await device.setStoreValue('password', cachedPassword);
            this.log('Updated device password during repair');
          } else {
            await device.unsetStoreValue('password');
            this.log('Removed device password during repair');
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
