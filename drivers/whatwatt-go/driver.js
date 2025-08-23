'use strict';

const Homey = require('homey');

module.exports = class whatwattGoDriver extends Homey.Driver {

  /**
   * Called when the driver is initialized.
   * Sets up the driver and logs initialization.
   */
  async onInit() {
    this.log('whatwatt Go Driver has been initialized');
  }

  /**
   * Called when the user is adding a device and the device list is shown.
   * Converts mDNS discovery results into device objects for pairing.
   * 
   * @returns {Array} Array of device objects available for pairing
   */
  async onPairListDevices() {
    const discoveryStrategy = this.getDiscoveryStrategy();
    const discoveryResults = discoveryStrategy.getDiscoveryResults();

    const devices = Object.values(discoveryResults).map(discoveryResult => {
      // Clean up device name by removing "WebUI" suffix and using last 6 chars of ID as fallback
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

};
