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

import * as http from 'http';
import * as net from 'net';
import * as url from 'url';

import {AppSettings} from './appSettings';
import * as jupyter from './jupyter';
import * as logging from './logging';
import * as reverseProxy from './reverseProxy';
import * as sockets from './sockets';
import {SocketIoToPty} from './socketio_to_pty';

let server: http.Server;

/**
 * Handles all requests.
 * @param request the incoming HTTP request.
 * @param response the out-going HTTP response.
 * @path the parsed path in the request.
 */
function handleRequest(request: http.IncomingMessage,
                       response: http.ServerResponse,
                       requestPath: string) {

  // Requests proxied to Jupyter
  // TODO(b/109975537): Forward paths directly from the TBE -> Jupyter and drop
  // here.
  if ((requestPath.indexOf('/api') === 0) ||
      (requestPath.indexOf('/nbextensions') === 0) ||
      (requestPath.indexOf('/files') === 0) ||
      (requestPath.indexOf('/static') === 0))  {
    jupyter.handleRequest(request, response);
    return;
  }

  // Not Found
  response.statusCode = 404;
  response.end();
}

/**
 * Base logic for handling all requests sent to the proxy web server. Some
 * requests are handled within the server, while some are proxied to the
 * Jupyter notebook server.
 *
 * Error handling is left to the caller.
 *
 * @param request the incoming HTTP request.
 * @param response the out-going HTTP response.
 */
function uncheckedRequestHandler(request: http.IncomingMessage, response: http.ServerResponse) {
  const parsedUrl = url.parse(request.url || '', true);
  const urlpath = parsedUrl.pathname || '';

  logging.logRequest(request, response);

  for (const handler of socketIoHandlers) {
    if (handler.isPathProxied(urlpath)) {
      // Will automatically be handled by socket.io.
      return;
    }
  }

  const proxyPort = reverseProxy.getRequestPort(urlpath);
  if (sockets.isSocketIoPath(urlpath)) {
    // Will automatically be handled by socket.io.
  } else if (proxyPort && proxyPort !== request.socket.localPort) {
    // Do not allow proxying to this same port, as that can be used to mask the
    // target path.
    reverseProxy.handleRequest(request, response, proxyPort);
  } else {
    handleRequest(request, response, urlpath);
  }
}

function socketHandler(request: http.IncomingMessage, socket: net.Socket, head: Buffer) {
  jupyter.handleSocket(request, socket, head);
}

/**
 * Handles all requests sent to the proxy web server. Some requests are handled within
 * the server, while some are proxied to the Jupyter notebook server.
 * @param request the incoming HTTP request.
 * @param response the out-going HTTP response.
 */
function requestHandler(request: http.IncomingMessage, response: http.ServerResponse) {
  try {
    uncheckedRequestHandler(request, response);
  } catch (e) {
    logging.getLogger().error(
        `Uncaught error handling a request to "${request.url}": ${e}`);
  }
}

const socketIoHandlers: SocketIoToPty[] = [];

/**
 * Runs the proxy web server.
 * @param settings the configuration settings to use.
 */
export function run(settings: AppSettings): void {
  jupyter.init(settings);
  reverseProxy.init(settings);

  server = http.createServer(requestHandler);
  // Disable HTTP keep-alive connection timeouts in order to avoid connection
  // flakes. Details: b/112151064
  server.keepAliveTimeout = 0;
  server.on('upgrade', socketHandler);

  sockets.init(server, settings);

  if (settings.terminal) {
    socketIoHandlers.push(new SocketIoToPty('/tty', server));
  }

  logging.getLogger().info('Starting server at http://localhost:%d',
                           settings.serverPort);
  process.on('SIGINT', () => process.exit());

  server.listen(settings.serverPort);
}

/**
 * Stops the server and associated Jupyter server.
 */
export function stop(): void {
  jupyter.close();
}
