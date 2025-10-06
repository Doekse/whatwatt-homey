'use strict';

const EventSource = require('eventsource');

/**
 * whatwatt Go Event Stream Manager
 * 
 * Manages Server-Sent Events (SSE) connections to the whatwatt device.
 * Handles authentication, automatic reconnection, and data parsing.
 */
class whatwattEventStream {
  /**
   * Creates a new event stream manager.
   * 
   * Initializes connection parameters and callback functions for handling SSE events.
   * Sets up reconnection logic and heartbeat monitoring to maintain reliable connections.
   * 
   * @param {Object} options - Configuration options
   * @param {string} options.host - Device IP address
   * @param {number} [options.port=80] - Device port
   * @param {boolean} [options.https=false] - Use HTTPS
   * @param {string} [options.username] - Basic auth username
   * @param {string} [options.password] - Basic auth password
   * @param {Function} options.onData - Callback for live data events
   * @param {Function} options.onConnect - Callback for connection events
   * @param {Function} options.onError - Callback for error events
   * @param {Function} options.onDisconnect - Callback for disconnect events
   * @param {Function} [options.logger] - Logger function (optional)
   * @param {Object} [options.device] - Homey device instance for IP refresh (optional)
   * @param {Object} [options.driver] - Homey driver instance for IP refresh (optional)
   */
  constructor(options) {
    this.homey = options.homey;
    this.host = options.host;
    this.port = options.port || 80;
    this.https = options.https || false;
    this.username = options.username;
    this.password = options.password;

    // Store callback functions for event handling
    this.onData = options.onData;
    this.onConnect = options.onConnect;
    this.onError = options.onError;
    this.onDisconnect = options.onDisconnect;
    this.logger = options.logger || (() => {});

    // Store device and driver references for IP refresh functionality
    this.device = options.device;
    this.driver = options.driver;

    // Track connection state and reconnection attempts
    this.eventSource = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000;
    this.reconnectTimer = null;

    // Heartbeat tracking to detect connection drops
    this.lastDataReceived = null;
    this.heartbeatTimeout = 300000;
    this.heartbeatTimer = null;
    this.heartbeatCheckInterval = 60000;
  }

  /**
   * Establishes SSE connection to the whatwatt device.
   * 
   * Creates EventSource connection with proper headers and authentication.
   * Sets up event listeners for data, connection, and error handling.
   */
  start() {
    if (this.eventSource) {
      this.logger('Event stream already active, stopping existing connection first');
      this.stop();
    }

    try {
      const protocol = this.https ? 'https' : 'http';
      const streamUrl = `${protocol}://${this.host}:${this.port}/api/v1/live`;

      // Configure EventSource headers for SSE protocol
      const eventSourceOptions = {
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      };

      // Add basic authentication headers if password is provided
      if (this.password) {
        const username = this.username || '';
        const auth = Buffer.from(`${username}:${this.password}`).toString('base64');
        eventSourceOptions.headers['Authorization'] = `Basic ${auth}`;
      }

      this.logger(`Starting event stream from: ${streamUrl}`);

      this.eventSource = new EventSource(streamUrl, eventSourceOptions);

      // Parse and forward incoming data events
      this.eventSource.addEventListener('live', (event) => {
        try {
          const data = JSON.parse(event.data);
          this._resetHeartbeat(); 
          this.onData(data);
        } catch (error) {
          this.logger(`Failed to parse live data: ${error.message}`);
        }
      });

      // Handle successful connection
      this.eventSource.onopen = () => {
        this.logger('Event stream connected');
        this.isConnected = true;
        this.reconnectAttempts = 0; 
        this._startHeartbeat();
        this.onConnect();
      };

      // Handle connection errors and schedule reconnection
      this.eventSource.onerror = (error) => {
        this.logger(`Event stream error: ${error.type || 'Unknown error'}`);
        this.isConnected = false;

        // Detect authentication failures to prevent unnecessary reconnection attempts
        if (error.type === 'error' && this.eventSource && this.eventSource.readyState === EventSource.CONNECTING) {
          const unauthorizedError = new Error('Event stream authentication failed');
          unauthorizedError.isUnauthorized = true;
          unauthorizedError.statusCode = 401;
          
          if (this.onError) {
            this.onError(unauthorizedError);
          }
          
          return;
        }

        if (this.onError) {
          this.onError(error);
        }

        this._scheduleReconnect();
      };

    } catch (error) {
      this.logger(`Failed to start event stream: ${error.message}`);
      this.onError(error);
    }
  }

  /**
   * Terminates the SSE connection and cleans up resources.
   * 
   * Stops the EventSource connection and cancels any pending reconnection attempts.
   * Cleans up heartbeat monitoring and notifies disconnect callback.
   */
  stop() {
    if (this.reconnectTimer) {
      this.homey.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this._stopHeartbeat();

    if (this.eventSource) {
      this.logger('Stopping event stream');
      this.eventSource.close();
      this.eventSource = null;
      this.isConnected = false;

      if (this.onDisconnect) {
        this.onDisconnect();
      }
    }
  }

  /**
   * Verifies if the stream is currently connected.
   * 
   * Checks both internal state and EventSource readyState to ensure
   * the connection is active and ready to receive data.
   * 
   * @returns {boolean} True if connected and ready
   */
  isStreamConnected() {
    return this.isConnected && this.eventSource && this.eventSource.readyState === EventSource.OPEN;
  }

  /**
   * Provides connection status information for debugging.
   * 
   * Returns comprehensive details about the current connection state,
   * including reconnection attempts and connection URL.
   * 
   * @returns {Object} Current connection status details
   */
  getStatus() {
    return {
      connected: this.isConnected,
      readyState: this.eventSource ? this.eventSource.readyState : null,
      reconnectAttempts: this.reconnectAttempts,
      url: this.eventSource ? this.eventSource.url : null,
    };
  }

  /**
   * Schedules reconnection attempts with exponential backoff.
   * 
   * Implements intelligent reconnection with IP refresh to handle dynamic
   * IP changes. Limits attempts to prevent infinite reconnection loops.
   */
  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger(`Max reconnect attempts (${this.maxReconnectAttempts}) exceeded`);
      return;
    }

    if (this.reconnectTimer) {
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 5);

    this.logger(`Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);

    this.reconnectTimer = this.homey.setTimeout(async () => {
      this.reconnectTimer = null;
      this.logger(`Attempting to reconnect (attempt ${this.reconnectAttempts})`);
      
      // Refresh device IP address to handle dynamic IP changes
      if (this.device && this.driver) {
        try {
          this.logger(`Refreshing device IP address before reconnection attempt ${this.reconnectAttempts}`);
          const { refreshDeviceIP } = require('./utils');
          const ipResult = await refreshDeviceIP(this.device, this.driver);
          
          if (ipResult.success && ipResult.ipUpdated) {
            this.logger(`Device IP updated from ${this.host}:${this.port} to ${ipResult.connectionHost}:${ipResult.connectionPort}`);
            this.host = ipResult.connectionHost;
            this.port = ipResult.connectionPort;
          } else if (ipResult.success) {
            this.logger(`Device IP address unchanged (${this.host}:${this.port})`);
          } else {
            this.logger(`IP refresh failed: ${ipResult.error || 'Unknown error'}`);
          }
        } catch (error) {
          this.logger(`IP refresh error during reconnection: ${error.message}`);
        }
      } else {
        this.logger('Device or driver reference not available for IP refresh');
      }
      
      this.start();
    }, delay);
  }

  /**
   * Resets the reconnection counter.
   * 
   * Clears the reconnection attempt counter when connection settings
   * change to allow fresh reconnection attempts.
   */
  resetReconnectCounter() {
    this.reconnectAttempts = 0;
  }

  /**
   * Updates connection settings and restarts the stream when parameters change.
   * 
   * Compares new settings with current ones and only restarts the connection
   * when actual changes are detected to avoid unnecessary reconnections.
   * 
   * @param {Object} newOptions - New connection configuration
   */
  updateSettings(newOptions) {
    const needsRestart = newOptions.host !== this.host
      || newOptions.port !== this.port
      || newOptions.https !== this.https
      || newOptions.username !== this.username
      || newOptions.password !== this.password;


    if (needsRestart) {
      this.host = newOptions.host || this.host;
      this.port = newOptions.port || this.port;
      this.https = newOptions.https || this.https;
      this.username = newOptions.username;
      this.password = newOptions.password;

      this.logger('Connection settings changed, restarting stream');
      this.resetReconnectCounter();
      this.stop();
      this.start();
    }
  }

  /**
   * Starts heartbeat monitoring to detect connection drops.
   * 
   * Monitors data reception to detect silent connection failures.
   * Triggers reconnection when no data is received within the timeout period.
   */
  _startHeartbeat() {
    this._stopHeartbeat();
    
    this.lastDataReceived = Date.now();
    this.logger(`Starting heartbeat monitoring (timeout: ${this.heartbeatTimeout}ms)`);
    
    this.heartbeatTimer = this.homey.setInterval(() => {
      this._checkHeartbeat();
    }, this.heartbeatCheckInterval);
  }

  /**
   * Stops heartbeat monitoring and cleans up the timer.
   * 
   * Cancels the heartbeat check interval and cleans up resources.
   */
  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      this.homey.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.logger('Stopped heartbeat monitoring');
    }
  }

  /**
   * Resets the heartbeat timer when data is received.
   * 
   * Updates the last data received timestamp to prevent false
   * timeout detection during active data flow.
   */
  _resetHeartbeat() {
    this.lastDataReceived = Date.now();
  }

  /**
   * Checks if the heartbeat has timed out and triggers reconnection if needed.
   * 
   * Compares time since last data reception against the timeout threshold.
   * Triggers reconnection using existing logic with IP refresh capabilities.
   */
  _checkHeartbeat() {
    if (!this.isConnected || !this.lastDataReceived) {
      return;
    }

    const timeSinceLastData = Date.now() - this.lastDataReceived;
    
    if (timeSinceLastData > this.heartbeatTimeout) {
      this.logger(`Heartbeat timeout detected (${Math.round(timeSinceLastData / 1000)}s since last data), triggering reconnection`);
      
      this.stop();
      this._scheduleReconnect();
    }
  }
}

module.exports = whatwattEventStream;
