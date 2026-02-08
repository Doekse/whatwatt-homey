'use strict';

const { Readable } = require('stream');

/**
 * Utility methods for Homey device capability management and data conversion.
 * Handles dynamic capability updates and power/energy data formatting for whatwatt devices.
 * Includes SSE/stream parsing helpers and discovery name formatting.
 */

/**
 * Updates device capabilities dynamically based on data availability.
 * Prevents capability flickering during temporary data loss and reduces overhead by only updating changed values.
 *
 * @param {Homey.Device} device   The Homey device instance.
 * @param {string}       capability The capability ID to update.
 * @param {*}            value      The value to set for the capability.
 */
async function updateCapability(device, capability, value) {
  // Ensure valid parameters to prevent runtime errors
  if (!device || typeof device !== 'object') {
    throw new Error('Invalid device parameter provided to updateCapability');
  }

  if (!capability || typeof capability !== 'string') {
    throw new Error('Invalid capability parameter provided to updateCapability');
  }

  // Skip updates for deleted devices to prevent errors
  if (device._isDeleted) {
    return;
  }

  try {
    // Skip updates for unavailable data to prevent capability flickering during temporary data loss
    if (value === null || value === undefined) {
      return;
    }

    // Add capability when data becomes available for the first time
    if (!device.hasCapability(capability)) {
      await device.addCapability(capability).catch((error) => {
        device.error(`Failed to add capability ${capability}:`, error.message);
      });
      device.log(`Added capability: ${capability}`);
    }

    // Update only when value changes to minimize unnecessary capability operations
    const current = device.getCapabilityValue(capability);
    if (current !== value) {
      await device.setCapabilityValue(capability, value).catch((error) => {
        device.error(`Failed to set capability value for ${capability}:`, error.message);
      });
    }
  } catch (error) {
    device.error(`Failed to update capability ${capability}:`, error.message);
  }
}

/**
 * Initializes device capabilities during onboarding.
 * Removes capabilities without data to keep the interface clean and only show relevant capabilities.
 *
 * @param {Homey.Device} device     The Homey device instance.
 * @param {string}       capability The capability ID to manage.
 * @param {*}            value      The initial value for the capability.
 */
async function setupCapability(device, capability, value) {
  // Ensure valid parameters to prevent runtime errors
  if (!device || typeof device !== 'object') {
    throw new Error('Invalid device parameter provided to setupCapability');
  }

  if (!capability || typeof capability !== 'string') {
    throw new Error('Invalid capability parameter provided to setupCapability');
  }

  try {
    // Remove capability when no initial data exists to keep interface clean
    if (value === null || value === undefined) {
      if (device.hasCapability(capability)) {
        await device.removeCapability(capability).catch((error) => {
          device.error(`Failed to remove capability ${capability}:`, error.message);
        });
        device.log(`Removed capability during setup: ${capability} (no initial data)`);
      }
      return;
    }

    // Add capability when initial data is available
    if (!device.hasCapability(capability)) {
      await device.addCapability(capability).catch((error) => {
        device.error(`Failed to add capability ${capability}:`, error.message);
      });
      device.log(`Added capability during setup: ${capability}`);
    }

    // Initialize with provided value if different from current state
    const current = device.getCapabilityValue(capability);
    if (current !== value) {
      await device.setCapabilityValue(capability, value).catch((error) => {
        device.error(`Failed to set capability value for ${capability}:`, error.message);
      });
    }
  } catch (error) {
    device.error(`Failed to setup capability ${capability}:`, error.message);
  }
}

/**
 * Converts power values from kilowatts to watts.
 * whatwatt meters provide power data in kW, but Homey capabilities expect W.
 *
 * @param {number|null|undefined} value Power in kilowatts.
 * @returns {number|null} Power in watts or null if input is invalid.
 */
function convertPower(value) {
  // Handle invalid input values gracefully
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return null;
  }

  // Convert to number and validate
  const numericValue = Number(value);
  if (Number.isNaN(numericValue)) {
    return null;
  }

  // Convert from kW to W
  return numericValue * 1000;
}

/**
 * Normalizes REST API report data to match SSE format.
 * Converts nested REST API structure to flat field names for consistent data processing.
 *
 * @param {Object} reportData The report data from REST API.
 * @returns {Object} Data in SSE format with flat field names.
 */
function convertReport(reportData) {
  // Ensure valid input data
  if (!reportData || typeof reportData !== 'object') {
    return {};
  }

  if (!reportData.report || typeof reportData.report !== 'object') {
    return {};
  }

  const { report } = reportData;

  return {
    // Power consumption and export (converted from kW to W)
    P_In: convertPower(report.instantaneous_power?.active?.positive?.total),
    P_Out: convertPower(report.instantaneous_power?.active?.negative?.total),

    // Phase-specific power consumption
    P_P1_In: convertPower(report.instantaneous_power?.active?.positive?.l1),
    P_P2_In: convertPower(report.instantaneous_power?.active?.positive?.l2),
    P_P3_In: convertPower(report.instantaneous_power?.active?.positive?.l3),

    // Phase-specific power export
    P_P1_Out: convertPower(report.instantaneous_power?.active?.negative?.l1),
    P_P2_Out: convertPower(report.instantaneous_power?.active?.negative?.l2),
    P_P3_Out: convertPower(report.instantaneous_power?.active?.negative?.l3),

    // Voltage measurements per phase
    V_P1: report.voltage?.l1,
    V_P2: report.voltage?.l2,
    V_P3: report.voltage?.l3,

    // Current measurements per phase
    I_P1: report.current?.l1,
    I_P2: report.current?.l2,
    I_P3: report.current?.l3,

    // Total energy consumption and export (kWh)
    E_In: report.energy?.active?.positive?.total,
    E_Out: report.energy?.active?.negative?.total,

    // Tariff-based energy measurements
    E_In_T1: report.energy?.active?.positive?.t1,
    E_In_T2: report.energy?.active?.positive?.t2,
    E_Out_T1: report.energy?.active?.negative?.t1,
    E_Out_T2: report.energy?.active?.negative?.t2,

    // Reactive power (converted from kvar to var)
    rP_In: convertPower(report.instantaneous_power?.reactive?.positive?.total),
    rP_Out: convertPower(report.instantaneous_power?.reactive?.negative?.total),

    // Power factor
    PF: report.power_factor,
  };
}

/**
 * Validates that a value is a valid number and within expected range.
 * Ensures data integrity before processing numeric values.
 *
 * @param {*} value - The value to validate
 * @param {number} [min] - Minimum allowed value
 * @param {number} [max] - Maximum allowed value
 * @returns {boolean} True if value is valid
 */
function isValidNumber(value, min = null, max = null) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return false;
  }

  const numericValue = Number(value);
  if (Number.isNaN(numericValue)) {
    return false;
  }

  if (min !== null && numericValue < min) {
    return false;
  }

  if (max !== null && numericValue > max) {
    return false;
  }

  return true;
}

/**
 * Safely converts a value to a number with fallback.
 * Prevents crashes when dealing with invalid numeric data.
 *
 * @param {*} value - The value to convert
 * @param {number} fallback - Fallback value if conversion fails
 * @returns {number} Converted number or fallback
 */
function safeNumber(value, fallback = 0) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return fallback;
  }

  const numericValue = Number(value);
  return Number.isNaN(numericValue) ? fallback : numericValue;
}

/**
 * Calculates net power values (import - export) for total and per-phase measurements.
 * Provides unified power values where positive indicates consumption and negative indicates generation.
 *
 * @param {Object} data - Power data object with P_In, P_Out, and phase-specific fields
 * @returns {Object} Combined power values with total and per-phase measurements
 */
function calculatePower(data) {
  // Ensure valid input data
  if (!data || typeof data !== 'object') {
    return {
      total: null,
      phase1: null,
      phase2: null,
      phase3: null,
    };
  }

  // Calculate total net power (import - export)
  const totalIn = safeNumber(data.P_In, 0);
  const totalOut = safeNumber(data.P_Out, 0);
  const total = totalIn - totalOut;

  // Calculate per-phase net power (import - export)
  const phase1In = safeNumber(data.P_P1_In, 0);
  const phase1Out = safeNumber(data.P_P1_Out, 0);
  const phase1 = phase1In - phase1Out;

  const phase2In = safeNumber(data.P_P2_In, 0);
  const phase2Out = safeNumber(data.P_P2_Out, 0);
  const phase2 = phase2In - phase2Out;

  const phase3In = safeNumber(data.P_P3_In, 0);
  const phase3Out = safeNumber(data.P_P3_Out, 0);
  const phase3 = phase3In - phase3Out;

  return {
    total,
    phase1,
    phase2,
    phase3,
  };
}

/**
 * Discovers and updates device IP address using mDNS discovery.
 * Handles dynamic IP changes during device repair and reconnection.
 *
 * @param {Homey.Device} device - The Homey device instance
 * @param {Homey.Driver} driver - The Homey driver instance (for discovery access)
 * @returns {Promise<Object>} Object with success status and connection details
 */
async function refreshDeviceIP(device, driver) {
  // Ensure valid parameters to prevent runtime errors
  if (!device || typeof device !== 'object') {
    throw new Error('Invalid device parameter provided to refreshDeviceIP');
  }

  if (!driver || typeof driver !== 'object') {
    throw new Error('Invalid driver parameter provided to refreshDeviceIP');
  }

  try {
    const store = device.getStore();
    const deviceId = device.getData().id;

    device.log('Attempting to discover device current IP address via mDNS');

    // Get discovery strategy and results
    const discoveryStrategy = driver.getDiscoveryStrategy();
    const discoveryResults = discoveryStrategy.getDiscoveryResults();

    // Look for our specific device in the discovery results
    let currentDiscoveryResult = null;
    for (const result of Object.values(discoveryResults)) {
      if (result.id === deviceId) {
        currentDiscoveryResult = result;
        break;
      }
    }

    let connectionHost = store.address;
    let connectionPort = store.port || 80;
    let ipUpdated = false;

    if (currentDiscoveryResult) {
      // Device found via mDNS, check if IP address changed
      const newAddress = currentDiscoveryResult.address;
      const newPort = currentDiscoveryResult.port || 80;

      if (newAddress !== store.address || newPort !== (store.port || 80)) {
        device.log(`Device IP address changed from ${store.address}:${store.port || 80} to ${newAddress}:${newPort}`);

        const { driver } = device;
        if (driver && driver.updateDeviceStore) {
          await driver.updateDeviceStore(device, {
            address: newAddress,
            port: newPort,
          });
        } else {
          // Fallback: log the change but can't persist it
          device.log('Warning: Cannot persist IP address change - driver method not available');
        }

        connectionHost = newAddress;
        connectionPort = newPort;
        ipUpdated = true;
        device.log('Updated device IP address in store');
      } else {
        device.log('Device IP address unchanged');
      }
    } else {
      device.log('Device not found via mDNS discovery, using stored IP address');
    }

    return {
      success: true,
      ipUpdated,
      connectionHost,
      connectionPort,
      found: currentDiscoveryResult !== null,
    };

  } catch (error) {
    device.error('Failed to refresh device IP address:', error.message);
    return {
      success: false,
      error: error.message,
      connectionHost: device.getStore().address,
      connectionPort: device.getStore().port || 80,
      found: false,
    };
  }
}

/**
 * Updates device and meter information in device settings.
 * Consolidates system and meter information for user visibility in device settings.
 *
 * @param {Homey.Device} device - The Homey device instance
 * @param {Object} systemInfo - System information from the whatwatt device
 * @param {Object|null} reportData - Optional report data containing meter information
 */
async function updateMeterInformation(device, systemInfo, reportData) {
  // Ensure valid parameters to prevent runtime errors
  if (!device || typeof device !== 'object') {
    throw new Error('Invalid device parameter provided to updateMeterInformation');
  }

  if (!systemInfo || typeof systemInfo !== 'object') {
    throw new Error('Invalid systemInfo parameter provided to updateMeterInformation');
  }

  try {
    const deviceInfo = systemInfo.device || {};
    const meterInfo = systemInfo.meter || {};
    const reportMeter = reportData?.meter || {};

    // Combine device and meter information
    const allSettings = {
      // Device information
      device_id: deviceInfo.id || 'Unknown',
      device_model: deviceInfo.model || 'Unknown',
      device_firmware: deviceInfo.firmware || 'Unknown',

      // Meter information
      meter_interface: meterInfo.interface || reportMeter.interface || 'Unknown',
      meter_id: meterInfo.id || reportMeter.id || 'Unknown',
      meter_manufacturer: meterInfo.manufacturer || reportMeter.vendor || 'Unknown',
      meter_type: meterInfo.type || reportMeter.type || 'Unknown',
      meter_model: meterInfo.model || reportMeter.model || 'Unknown',
      meter_protocol: meterInfo.protocol || reportMeter.protocol || 'Unknown',
      meter_protocol_version: meterInfo.protocol_version || reportMeter.protocol_version || 'Unknown',
      meter_report_interval: meterInfo.report_interval ? `${String(meterInfo.report_interval)} second(s)` : 'Unknown',
    };

    // Update device settings with all information
    await device.setSettings(allSettings);

    device.log('Device and meter information updated in device settings:', {
      device: {
        id: allSettings.device_id,
        model: allSettings.device_model,
        firmware: allSettings.device_firmware,
      },
      meter: {
        id: allSettings.meter_id,
        manufacturer: allSettings.meter_manufacturer,
        model: allSettings.meter_model,
        protocol: allSettings.meter_protocol,
      },
    });

  } catch (error) {
    device.error('Failed to update device and meter information:', error.message);
    throw error;
  }
}

/**
 * Formats device name for display during pairing and discovery.
 * Removes WebUI suffix and provides fallback when name is missing.
 *
 * @param {Object} discoveryResult - mDNS discovery result with id and optional name
 * @returns {string} Sanitized display name
 */
function formatDeviceName(discoveryResult) {
  if (!discoveryResult || typeof discoveryResult !== 'object') {
    return 'whatwatt Go';
  }
  const fallback = `whatwatt Go ${(discoveryResult.id || '').slice(-6)}`;
  const name = (discoveryResult.name || fallback).replace(/\s+WebUI\s*$/i, '');
  return name || fallback;
}

/**
 * Parses SSE format from a text buffer.
 * Chunks may split events across boundaries; remainder holds the incomplete tail
 * for prepending to the next chunk.
 *
 * @param {string} buffer - Accumulated text
 * @returns {{ events: Array<{event: string, data: string}>, remainder: string }}
 */
function parseSSE(buffer) {
  const events = [];
  const blocks = buffer.split(/\n\n+/);
  const remainder = blocks.pop() || '';

  for (const block of blocks) {
    let eventType = 'message';
    let data = '';
    for (const line of block.split(/\r\n|\n/)) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data = (data ? `${data}\n` : '') + line.slice(5).trim();
      }
    }
    if (eventType || data) {
      events.push({ event: eventType, data });
    }
  }

  return { events, remainder };
}

/**
 * Normalizes response body to an async iterable for unified chunk consumption.
 * Supports Web ReadableStream and Node Readable; required for SSE parsing.
 *
 * @param {ReadableStream|import('stream').Readable} body - Response body
 * @returns {AsyncIterable<Uint8Array|Buffer>}
 */
function toAsyncIterable(body) {
  if (!body) {
    throw new Error('Response body is empty');
  }
  if (typeof body.getReader === 'function') {
    return (async function* webStream() {
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    }());
  }
  if (typeof body[Symbol.asyncIterator] === 'function') {
    return body;
  }
  if (body instanceof Readable || (body.pipe && typeof body.on === 'function')) {
    return (async function* nodeStream() {
      for await (const chunk of body) {
        yield chunk;
      }
    }());
  }
  throw new Error('Unsupported stream type: body.getReader is not a function');
}

module.exports = {
  setupCapability,
  updateCapability,
  convertPower,
  convertReport,
  isValidNumber,
  safeNumber,
  calculatePower,
  refreshDeviceIP,
  updateMeterInformation,
  formatDeviceName,
  parseSSE,
  toAsyncIterable,
};
