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

import * as childProcess from 'child_process';
import * as http from 'http';
import * as httpProxy from 'http-proxy';
import * as net from 'net';
import * as path from 'path';
import * as tcp from 'tcp-port-used';

import {AppSettings} from './appSettings';
import * as logging from './logging';
import * as util from './util';

interface JupyterServer {
  port: number;
  childProcess?: childProcess.ChildProcess;
  proxy?: httpProxy.ProxyServer;
}

/**
 * Jupyter servers key'd by user id (each server is associated with a single user)
 */
let jupyterServer: JupyterServer = null;

/**
 * The application settings instance.
 */
let appSettings: AppSettings;

/*
 * This list of levels should match the ones used by Python:
 *   https://docs.python.org/3/library/logging.html#logging-levels
 */
const enum LogLevels {
  Critical = 'CRITICAL',
  Error = 'ERROR',
  Warning = 'WARNING',
  Info = 'INFO',
  Debug = 'DEBUG',
  NotSet = 'NOTSET',
}

function pipeOutput(stream: NodeJS.ReadableStream) {
  stream.setEncoding('utf8');

  // The format we parse here corresponds to the log format we set in our
  // jupyter configuration.
  const logger = logging.getJupyterLogger();
  stream.on('data', (data: string) => {
    for (const line of data.split('\n')) {
      if (line.trim().length === 0) {
        continue;
      }
      const parts = line.split('|', 3);
      if (parts.length !== 3) {
        // Non-logging messages (eg tracebacks) get logged as warnings.
        logger.warn(line);
        continue;
      }
      const level = parts[1];
      const message = parts[2];
      // We need to map Python's log levels to those used by bunyan.
      if (level === LogLevels.Critical || level === LogLevels.Error) {
        logger.error(message);
      } else if (level === LogLevels.Warning) {
        logger.warn(message);
      } else if (level === LogLevels.Info) {
        logger.info(message);
      } else {
        // We map DEBUG, NOTSET, and any unknown log levels to debug.
        logger.debug(message);
      }
    }
  });
}

function createJupyterServer() {
  const server: JupyterServer = {port: appSettings.nextJupyterPort};
  logging.getLogger().info('Launching Jupyter server at %d', server.port);

  function exitHandler(code: number, signal: string): void {
    logging.getLogger().error('Jupyter process %d exited due to signal: %s',
                              server.childProcess.pid, signal);
    jupyterServer = null;
  }

  const contentDir = path.join(appSettings.datalabRoot, appSettings.contentDir);
  const processArgs = ['notebook'].concat(appSettings.jupyterArgs).concat([
    `--port=${server.port}`,
    `--FileContentsManager.root_dir="${appSettings.datalabRoot}/"`,
    `--MappingKernelManager.root_dir="${contentDir}"`,
  ]);

  let jupyterServerAddr = 'localhost';
  for (const flag of appSettings.jupyterArgs) {
    // Extracts a string like '1.2.3.4' from the string '--ip="1.2.3.4"'
    const match = flag.match(/--ip="([^"]+)"/);
    if (match) {
      jupyterServerAddr = match[1];
      break;
    }
  }
  logging.getLogger().info(
      'Using jupyter server address %s', jupyterServerAddr);

  const notebookEnv = process.env;
  const processOptions = {
    detached: false,
    env: notebookEnv
  };

  server.childProcess = childProcess.spawn('jupyter', processArgs, processOptions);
  server.childProcess.on('exit', exitHandler);
  logging.getLogger().info('Jupyter process started with pid %d and args %j',
                           server.childProcess.pid, processArgs);

  // Capture the output, so it can be piped for logging.
  pipeOutput(server.childProcess.stdout);
  pipeOutput(server.childProcess.stderr);

  // Create the proxy.
  let proxyTargetHost = jupyterServerAddr;
  let proxyTargetPort = server.port;
  if (appSettings.kernelManagerProxyHost) {
    proxyTargetHost = appSettings.kernelManagerProxyHost;
  }
  if (appSettings.kernelManagerProxyPort) {
    proxyTargetPort = appSettings.kernelManagerProxyPort;
  }

  const proxyOptions: httpProxy.ProxyServerOptions = {
    target: `http://${proxyTargetHost}:${proxyTargetPort}`
  };

  server.proxy = httpProxy.createProxyServer(proxyOptions);
  server.proxy.on('proxyRes', responseHandler);
  server.proxy.on('error', errorHandler);

  tcp.waitUntilUsedOnHost(server.port, jupyterServerAddr, 100, 15000)
      .then(
          () => {
            jupyterServer = server;
            logging.getLogger().info('Jupyter server started.');
          },
          (e) => {
            logging.getLogger().error(e, 'Failed to start Jupyter server.');
          });
}

/**
 * Initializes the Jupyter server manager.
 */
export function init(settings: AppSettings): void {
  appSettings = settings;
  createJupyterServer();
}

/**
 * Closes the Jupyter server manager.
 */
export function close(): void {
  const jupyterProcess = jupyterServer.childProcess;

  try {
    jupyterProcess.kill('SIGHUP');
  } catch (e) {
  }

  jupyterServer = null;
}

/** Proxy this socket request to jupyter. */
export function handleSocket(request: http.ServerRequest, socket: net.Socket, head: Buffer) {
  if (!jupyterServer) {
    logging.getLogger().error('Jupyter server is not running.');
    return;
  }
  jupyterServer.proxy.ws(request, socket, head);
}

/** Proxy this HTTP request to jupyter. */
export function handleRequest(request: http.ServerRequest, response: http.ServerResponse) {
  if (!jupyterServer) {
    response.statusCode = 500;
    response.end();
    return;
  }

  jupyterServer.proxy.web(request, response, null);
}

function responseHandler(proxyResponse: http.ClientResponse,
                         request: http.ServerRequest, response: http.ServerResponse) {
  if (proxyResponse.headers['access-control-allow-origin'] !== undefined) {
    // Delete the allow-origin = * header that is sent (likely as a result of a workaround
    // notebook configuration to allow server-side websocket connections that are
    // interpreted by Jupyter as cross-domain).
    delete proxyResponse.headers['access-control-allow-origin'];
  }
  if (proxyResponse.statusCode !== 200) {
    return;
  }
}

function errorHandler(error: Error, request: http.ServerRequest, response: http.ServerResponse) {
  logging.getLogger().error(error, 'Jupyter server returned error.');

  response.writeHead(500, 'Internal Server Error');
  response.end();
}
