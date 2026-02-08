'use strict';

const Homey = require('homey');
const WhatwattAPI = require('../../lib/whatwattapi');
const { refreshDeviceIP, formatDeviceName } = require('../../lib/utils');
const { DEFAULT_TIMEOUT, PAIRING_TIMEOUT } = require('../../lib/constants');

/**
 * Driver for whatwatt Go devices.
 * Manages device lifecycle including discovery, pairing with conditional authentication, and repair operations.
 */
module.exports = class whatwattGoDriver extends Homey.Driver {

  /**
   * Called when Homey loads the driver. Registers discovery strategy and handlers.
   */
  async onInit() {
    this.log('whatwatt Go Driver has been initialized');
  }

  /**
   * Called when Homey unloads the driver. Cleans up resources.
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

    const devices = Object.values(discoveryResults).map((discoveryResult) => {
      return {
        name: formatDeviceName(discoveryResult),
        data: {
          id: discoveryResult.id,
        },
        store: {
          address: discoveryResult.address,
          port: discoveryResult.port || 80,
        },
        settings: {},
      };
    });

    this.log('Found whatwatt Go devices:', devices.map((device) => `${device.name} (${device.data.id})`));
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
        const connectionSuccess = await WhatwattAPI.testDeviceConnection(
          { host: selectedDevice.store.address, port: selectedDevice.store.port },
          cachedPassword,
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
          const connectionSuccess = await WhatwattAPI.testDeviceConnection(
            { host: selectedDevice.store.address, port: selectedDevice.store.port },
            '',
            PAIRING_TIMEOUT,
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

    session.setHandler('repair_device', async () => {
      this.log('Starting device repair process');
      try {
        const result = await this._runRepairSteps(device, cachedPassword);
        return result;
      } catch (error) {
        this.log('Device repair failed:', error.message);
        return { success: false, message: `Repair failed: ${error.message}` };
      }
    });
  }

  /**
   * Executes repair steps: IP refresh, password validation, capability init, event stream restart.
   * @private
   * @param {Homey.Device} device - Device to repair
   * @param {string} cachedPassword - Password from repair UI
   * @returns {Promise<{success: boolean, message?: string}>}
   */
  async _runRepairSteps(device, cachedPassword) {
    const settings = device.getSettings();
    const ipResult = await refreshDeviceIP(device, this);

    if (!ipResult.success) {
      this.log('IP discovery failed, using stored IP address');
    }

    const connectionSuccess = await WhatwattAPI.testDeviceConnection(
      { host: ipResult.connectionHost, port: ipResult.connectionPort },
      cachedPassword,
      settings.timeout || DEFAULT_TIMEOUT,
    );

    if (!connectionSuccess) {
      this.log('Password test failed during repair');
      return { success: false, message: 'Password is incorrect or connection failed' };
    }

    this.log('Password test successful during repair');

    if (device.eventStream) {
      this.log('Stopping current event stream for repair');
      device.eventStream.stop();
      device.eventStream = null;
    }

    const passwordKey = `password_${device.getData().id}`;
    if (cachedPassword !== undefined) {
      if (cachedPassword) {
        await this.homey.settings.set(passwordKey, cachedPassword);
        this.log('Updated device password in ManagerSettings during repair');
      } else {
        await this.homey.settings.unset(passwordKey);
        this.log('Removed device password from ManagerSettings during repair');
      }
    }

    this.log('Re-running capability setup during repair');
    await device._initCapabilities();

    this.log('Re-running meter information setup during repair');
    await device._initMeterInformation();

    this.log('Restarting event stream after repair');
    device._initializeEventStream();

    this.log('Device repair completed successfully');
    return { success: true, message: 'Device repaired successfully' };
  }

};
