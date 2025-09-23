'use strict';

const Homey = require('homey');

module.exports = class whatwattApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('whatwatt App has been initialized');
  }

  /**
   * onUninit is called when the app is destroyed.
   */
  async onUninit() {
    this.log('whatwatt App has been destroyed');
  }

};
