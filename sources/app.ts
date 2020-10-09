/*
 * Copyright 2015 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License. You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under the License
 * is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express
 * or implied. See the License for the specific language governing permissions and limitations under
 * the License.
 */

import * as fs from 'fs';
import * as path from 'path';

import {AppSettings} from './appSettings';
import * as logging from './logging';
import * as server from './server';

/**
 * Loads the configuration settings for the application to use.
 * On first run, this generates any dynamic settings and merges them into the
 * settings result.
 * @returns the settings object for the application to use.
 */
function loadAppSettings(): AppSettings {
  const settingsPath = path.join(__dirname, 'config', 'settings.json');

  if (!fs.existsSync(settingsPath)) {
    const msg = `App settings file "${settingsPath}" not found.`;
    console.error(msg);
    throw new Error(msg);
  }

  try {
    const settings =
        JSON.parse(fs.readFileSync(settingsPath, 'utf8') || '{}') as
        AppSettings;
    const settingsOverrides = process.env['DATALAB_SETTINGS_OVERRIDES'];
    if (settingsOverrides) {
      // Allow overriding individual settings via JSON provided as an environment variable.
      const overrides = JSON.parse(settingsOverrides) as unknown;
      Object.assign(settings, overrides);
    }
    return settings;
  } catch (e) {
    console.error(e);
    throw new Error(`Error parsing settings overrides: ${e}`);
  }
}

/**
 * Load the configuration settings, and then start the server, which
 * runs indefinitely, listening to and processing incoming HTTP requests.
 */
const appSettings = loadAppSettings();
if (appSettings != null) {
  logging.initializeLoggers(appSettings);
  server.run(appSettings);
}


/**
 * Handle shutdown of this process, to also stop the server, which will in turn stop the
 * associated Jupyter server process.
 */
function exit() {
  logging.getLogger().info('app: exit');
  server.stop();
  logging.getLogger().info('app: exit: stopped');
  process.exit(0);
}

/**
 * Handle uncaught exceptions to log them.
 */
function errorHandler(e: Error): void {
  console.error(e.stack);

  logging.getLogger().error(e, 'Unhandled exception');
  process.exit(1);
}

process.on('uncaughtException', errorHandler);
process.on('exit', exit);
process.on('SIGINT', exit);
process.on('SIGTERM', exit);
