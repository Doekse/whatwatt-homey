'use strict';

/**
 * Utility methods for Homey device capability management and data conversion.
 * Provides helpers for dynamic capability handling and power/energy data formatting.
 */

/**
 * Updates device capabilities based on data availability.
 * Adds capabilities when data becomes available and skips updates during data loss.
 * Only updates when values change to reduce overhead.
 *
 * @param {Homey.Device} device   The Homey device instance.
 * @param {string}       capability The capability ID to update.
 * @param {*}            value      The value to set for the capability.
 */
async function updateCapability(device, capability, value) {
  // Validate inputs
  if (!device || typeof device !== 'object') {
    throw new Error('Invalid device parameter provided to updateCapability');
  }
  
  if (!capability || typeof capability !== 'string') {
    throw new Error('Invalid capability parameter provided to updateCapability');
  }

  // Prevent capability updates after device deletion to avoid errors
  if (device._isDeleted) {
    return;
  }

  try {
    // Skip updates for unavailable data to prevent capability flickering
    // during temporary data loss. Capability removal is handled separately
    // during device onboarding.
    if (value === null || value === undefined) {
      return;
    }

    // Add capability when data becomes available for the first time
    if (!device.hasCapability(capability)) {
      await device.addCapability(capability).catch(error => {
        device.error(`Failed to add capability ${capability}:`, error.message);
      });
      device.log(`Added capability: ${capability}`);
    }

    // Update only when value changes to minimize unnecessary capability operations
    const current = device.getCapabilityValue(capability);
    if (current !== value) {
      await device.setCapabilityValue(capability, value).catch(error => {
        device.error(`Failed to set capability value for ${capability}:`, error.message);
      });
    }
  } catch (error) {
    device.error(`Failed to update capability ${capability}:`, error.message);
  }
}

/**
 * Initializes device capabilities during onboarding.
 * Removes capabilities when no initial data is available.
 * Only displays capabilities that have data.
 *
 * @param {Homey.Device} device     The Homey device instance.
 * @param {string}       capability The capability ID to manage.
 * @param {*}            value      The initial value for the capability.
 */
async function setupCapability(device, capability, value) {
  // Validate inputs
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
        await device.removeCapability(capability).catch(error => {
          device.error(`Failed to remove capability ${capability}:`, error.message);
        });
        device.log(`Removed capability during setup: ${capability} (no initial data)`);
      }
      return;
    }

    // Add capability when initial data is available
    if (!device.hasCapability(capability)) {
      await device.addCapability(capability).catch(error => {
        device.error(`Failed to add capability ${capability}:`, error.message);
      });
      device.log(`Added capability during setup: ${capability}`);
    }

    // Initialize with provided value if different from current state
    const current = device.getCapabilityValue(capability);
    if (current !== value) {
      await device.setCapabilityValue(capability, value).catch(error => {
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
 * Returns null for invalid inputs.
 *
 * @param {number|null|undefined} value Power in kilowatts.
 * @returns {number|null} Power in watts or null if input is invalid.
 */
function convertPower(value) {
  // Handle null, undefined, or NaN values
  if (value === null || value === undefined || isNaN(value)) {
    return null;
  }

  // Ensure value is a number
  const numericValue = Number(value);
  if (isNaN(numericValue)) {
    return null;
  }

  // Convert from kW to W
  return numericValue * 1000;
}

/**
 * Normalizes REST API report data to match SSE format.
 * The REST API returns nested objects while SSE provides flat field names.
 * Allows both data sources to use the same capability update logic.
 *
 * @param {Object} reportData The report data from REST API.
 * @returns {Object} Data in SSE format with flat field names.
 */
function convertReport(reportData) {
  // Validate input
  if (!reportData || typeof reportData !== 'object') {
    return {};
  }

  if (!reportData.report || typeof reportData.report !== 'object') {
    return {};
  }

  const report = reportData.report;
  
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
    PF: report.power_factor
  };
}

/**
 * Validates that a value is a valid number and within expected range.
 * Checks for valid numeric values before processing.
 * 
 * @param {*} value - The value to validate
 * @param {number} [min] - Minimum allowed value
 * @param {number} [max] - Maximum allowed value
 * @returns {boolean} True if value is valid
 */
function isValidNumber(value, min = null, max = null) {
  if (value === null || value === undefined || isNaN(value)) {
    return false;
  }

  const numericValue = Number(value);
  if (isNaN(numericValue)) {
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
  if (value === null || value === undefined || isNaN(value)) {
    return fallback;
  }

  const numericValue = Number(value);
  return isNaN(numericValue) ? fallback : numericValue;
}

/**
 * Calculates combined power values (import - export) for total and per-phase measurements.
 * Returns positive values for power import (consumption) and negative values for power export (generation).
 *
 * @param {Object} data - Power data object with P_In, P_Out, and phase-specific fields
 * @returns {Object} Combined power values with total and per-phase measurements
 */
function calculatePower(data) {
  // Validate input
  if (!data || typeof data !== 'object') {
    return {
      total: null,
      phase1: null,
      phase2: null,
      phase3: null
    };
  }

  // Calculate total power (import - export)
  const totalIn = safeNumber(data.P_In, 0);
  const totalOut = safeNumber(data.P_Out, 0);
  const total = totalIn - totalOut;

  // Calculate per-phase power (import - export)
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
    phase3
  };
}

/**
 * Updates device and meter information in device settings.
 * Combines system information and optional report data.
 * 
 * @param {Homey.Device} device - The Homey device instance
 * @param {Object} systemInfo - System information from the whatwatt device
 * @param {Object|null} reportData - Optional report data containing meter information
 */
async function updateMeterInformation(device, systemInfo, reportData) {
  // Validate inputs
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
      meter_report_interval: meterInfo.report_interval ? `${String(meterInfo.report_interval)} second(s)` : 'Unknown'
    };

    // Update device settings with all information
    await device.setSettings(allSettings);
    
    device.log('Device and meter information updated in device settings:', {
      device: {
        id: allSettings.device_id,
        model: allSettings.device_model,
        firmware: allSettings.device_firmware
      },
      meter: {
        id: allSettings.meter_id,
        manufacturer: allSettings.meter_manufacturer,
        model: allSettings.meter_model,
        protocol: allSettings.meter_protocol
      }
    });
    
  } catch (error) {
    device.error('Failed to update device and meter information:', error.message);
    throw error;
  }
}

module.exports = {
  setupCapability,
  updateCapability,
  convertPower,
  convertReport,
  isValidNumber,
  safeNumber,
  calculatePower,
  updateMeterInformation,
};
