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
   * Configures connection parameters and callback functions for event handling.
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
   */
  constructor(options) {
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
    this.logger = options.logger || (() => {}); // Default to no-op logger

    // Track connection state and reconnection attempts
    this.eventSource = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000; // Base delay of 5 seconds
    this.reconnectTimer = null;
  }

  /**
   * Establishes SSE connection to the whatwatt device.
   * Sets up event listeners and handles authentication.
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
      // whatwatt Go devices may only require password authentication
      if (this.password) {
        const username = this.username || ''; // Use empty string if no username provided
        const auth = Buffer.from(`${username}:${this.password}`).toString('base64');
        eventSourceOptions.headers['Authorization'] = `Basic ${auth}`;
      }

      this.logger(`Starting event stream from: ${streamUrl}`);

      // Create EventSource connection
      this.eventSource = new EventSource(streamUrl, eventSourceOptions);

      // Parse and forward incoming data events
      this.eventSource.addEventListener('live', (event) => {
        try {
          const data = JSON.parse(event.data);
          this.onData(data);
        } catch (error) {
          this.logger(`Failed to parse live data: ${error.message}`);
        }
      });

      // Handle successful connection
      this.eventSource.onopen = () => {
        this.logger('Event stream connected');
        this.isConnected = true;
        this.reconnectAttempts = 0; // Reset counter on successful connection
        this.onConnect();
      };

      // Handle connection errors and schedule reconnection
      this.eventSource.onerror = (error) => {
        this.logger(`Event stream error: ${error.type || 'Unknown error'}`);
        this.isConnected = false;

        // Detect authentication failures
        if (error.type === 'error' && this.eventSource && this.eventSource.readyState === EventSource.CONNECTING) {
          // This might be a 401 error - create a specific error object
          const unauthorizedError = new Error('Event stream authentication failed');
          unauthorizedError.isUnauthorized = true;
          unauthorizedError.statusCode = 401;
          
          if (this.onError) {
            this.onError(unauthorizedError);
          }
          
          // Don't schedule reconnection for authentication errors
          return;
        }

        if (this.onError) {
          this.onError(error);
        }

        // Schedule a reconnection attempt
        this._scheduleReconnect();
      };

    } catch (error) {
      this.logger(`Failed to start event stream: ${error.message}`);
      this.onError(error);
    }
  }

  /**
   * Terminates the SSE connection and cleans up resources.
   * Cancels pending reconnection attempts.
   */
  stop() {
    // Cancel any scheduled reconnection attempts
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Close the EventSource connection
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
   * Checks both internal state and EventSource readyState.
   * 
   * @returns {boolean} True if connected and ready
   */
  isStreamConnected() {
    return this.isConnected && this.eventSource && this.eventSource.readyState === EventSource.OPEN;
  }

  /**
   * Provides connection status information for debugging.
   * Returns details about current connection state.
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
   * Limits reconnection attempts to prevent infinite loops.
   */
  _scheduleReconnect() {
    // Stop attempting reconnection after maximum attempts to prevent infinite loops
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger(`Max reconnect attempts (${this.maxReconnectAttempts}) exceeded`);
      return;
    }

    // Prevent multiple simultaneous reconnection schedules
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 5); // Cap exponential backoff at 5x

    this.logger(`Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.logger(`Attempting to reconnect (attempt ${this.reconnectAttempts})`);
      this.start();
    }, delay);
  }

  /**
   * Resets the reconnection counter.
   * Called when connection settings change.
   */
  resetReconnectCounter() {
    this.reconnectAttempts = 0;
  }

  /**
   * Updates connection settings and restarts the stream when parameters change.
   * Only restarts when connection parameters actually change.
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
}

module.exports = whatwattEventStream;
