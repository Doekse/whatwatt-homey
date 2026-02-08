'use strict';

const { detectAuthScheme, createAuthenticatedFetch } = require('./authentication');
const { DEFAULT_TIMEOUT, HEARTBEAT_TIMEOUT } = require('./constants');
const { parseSSE, toAsyncIterable, refreshDeviceIP } = require('./utils');

/**
 * whatwatt Go Event Stream Manager
 *
 * Manages Server-Sent Events (SSE) connections to the whatwatt device using
 * fetch and manual SSE parsing. Supports both Digest (firmware 1.10+) and
 * Basic (older firmware) auth via probe-and-select. Node.js compatible.
 */
class WhatwattEventStream {
  constructor(options) {
    this.homey = options.homey;
    this.host = options.host;
    this.port = options.port || 80;
    this.https = options.https || false;
    this.username = options.username;
    this.password = options.password;
    this.authScheme = options.authScheme || 'auto';

    this.onData = options.onData;
    this.onConnect = options.onConnect;
    this.onError = options.onError;
    this.onDisconnect = options.onDisconnect;
    this.logger = options.logger || (() => {});
    this.device = options.device;
    this.driver = options.driver;

    this._abortController = null;
    this._readPromise = null;
    this._authenticatedFetch = null;
    this._authSchemeDetected = null;
    this._intentionallyStopped = false;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000;
    this.reconnectTimer = null;

    this.lastDataReceived = null;
    this.heartbeatTimeout = options.heartbeatTimeout ?? HEARTBEAT_TIMEOUT;
    this.heartbeatTimer = null;
    this.heartbeatCheckInterval = 60000;
  }

  /**
   * Establishes SSE connection to the device live endpoint.
   * Detects auth scheme if password is set. Reconnects automatically on failure.
   */
  async start() {
    if (this._abortController) {
      this.logger('Event stream already active, stopping existing connection first');
      this.stop();
    }

    this._intentionallyStopped = false;
    this._abortController = new AbortController();

    const protocol = this.https ? 'https' : 'http';
    const streamUrl = `${protocol}://${this.host}:${this.port}/api/v1/live`;

    try {
      let fetchFn = fetch;
      if (this.password) {
        if (!this._authenticatedFetch) {
          let scheme = this._authSchemeDetected;
          if (this.authScheme === 'auto' || !scheme) {
            scheme = await detectAuthScheme(this.host, this.port, this.https, DEFAULT_TIMEOUT);
            this._authSchemeDetected = scheme;
          } else {
            scheme = this.authScheme;
          }
          this._authenticatedFetch = createAuthenticatedFetch(this.username || '', this.password, scheme);
        }
        fetchFn = this._authenticatedFetch;
      }

      this.logger(`Starting event stream from: ${streamUrl}`);

      const response = await fetchFn(streamUrl, {
        method: 'GET',
        signal: this._abortController.signal,
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });

      if (response.status === 401) {
        const err = new Error('Event stream authentication failed');
        err.isUnauthorized = true;
        err.statusCode = 401;
        if (this.onError) this.onError(err);
        if (!this._intentionallyStopped) this._scheduleReconnect();
        return;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      this.logger('Event stream connected');
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this._startHeartbeat();
      if (this.onConnect) this.onConnect();

      const decoder = new TextDecoder();
      let buffer = '';

      this._readPromise = (async () => {
        try {
          const iterable = toAsyncIterable(response.body);
          for await (const chunk of iterable) {
            if (this._intentionallyStopped) break;
            const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
            buffer += text;
            const { events, remainder } = parseSSE(buffer);
            buffer = remainder;
            for (const ev of events) {
              if (ev.event === 'live' && ev.data) {
                try {
                  const data = JSON.parse(ev.data);
                  this._resetHeartbeat();
                  this.onData(data);
                } catch (err) {
                  this.logger(`Failed to parse live data: ${err.message}`);
                }
              }
            }
          }
        } catch (err) {
          if (!this._intentionallyStopped && err.name !== 'AbortError') {
            this.logger(`Event stream error: ${err.message}`);
            this.isConnected = false;
            if (this.onError) this.onError(err);
            this._scheduleReconnect();
          }
        } finally {
          this.isConnected = false;
          if (!this._intentionallyStopped && this.onDisconnect) {
            this.onDisconnect();
          }
        }
      })();

      await this._readPromise;
    } catch (error) {
      if (this._intentionallyStopped) return;
      this.logger(`Failed to start event stream: ${error.message}`);
      if (this.onError) this.onError(error);
      this._scheduleReconnect();
    }
  }

  /**
   * Stops the SSE stream, clears reconnect timer, and invokes onDisconnect.
   */
  stop() {
    if (this.reconnectTimer) {
      this.homey.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this._stopHeartbeat();
    this._intentionallyStopped = true;

    if (this._abortController) {
      this.logger('Stopping event stream');
      this._abortController.abort();
      this._abortController = null;
    }

    this._readPromise = null;
    this.isConnected = false;

    if (this.onDisconnect) {
      this.onDisconnect();
    }
  }

  /**
   * Returns whether the SSE stream is currently connected.
   * @returns {boolean}
   */
  isStreamConnected() {
    return this.isConnected;
  }

  /**
   * Returns connection status for debugging or UI display.
   * @returns {{ connected: boolean, readyState: number, reconnectAttempts: number, url: string }}
   */
  getStatus() {
    return {
      connected: this.isConnected,
      readyState: this.isConnected ? 1 : 0,
      reconnectAttempts: this.reconnectAttempts,
      url: `${this.https ? 'https' : 'http'}://${this.host}:${this.port}/api/v1/live`,
    };
  }

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

      if (this.device && this.driver) {
        try {
          this.logger(`Refreshing device IP address before reconnection attempt ${this.reconnectAttempts}`);
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

      this.start().catch((err) => this.logger(`Reconnect failed: ${err.message}`));
    }, delay);
  }

  /**
   * Resets reconnect attempt counter. Used when connection succeeds or settings change.
   */
  resetReconnectCounter() {
    this.reconnectAttempts = 0;
  }

  /**
   * Updates connection settings. Restarts the stream if host, port, or credentials
   * change. Reconnection runs asynchronously (start is not awaited).
   *
   * @param {Object} newOptions - New host, port, https, username, password
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
      this._authenticatedFetch = null;
      this._authSchemeDetected = null;

      this.logger('Connection settings changed, restarting stream');
      this.resetReconnectCounter();
      this.stop();
      this.start().catch((err) => this.logger(`Restart failed: ${err.message}`));
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.lastDataReceived = Date.now();
    this.logger(`Starting heartbeat monitoring (timeout: ${this.heartbeatTimeout}ms)`);
    this.heartbeatTimer = this.homey.setInterval(() => {
      this._checkHeartbeat();
    }, this.heartbeatCheckInterval);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      this.homey.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.logger('Stopped heartbeat monitoring');
    }
  }

  _resetHeartbeat() {
    this.lastDataReceived = Date.now();
  }

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

module.exports = WhatwattEventStream;
