/*
 * Copyright 2018 Google Inc. All rights reserved.
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


/** Configuration values shared across the whole app. */
export declare interface AppSettings {
  /**
   * The port that the server should listen to.
   */
  serverPort: number;

  /**
   * The list of static arguments to be used when launching `jupyter notebook`.
   */
  jupyterArgs: string[];

  /**
   * If provided, use this as a prefix to all file paths opened on the
   * server side. Useful for testing outside a Docker container.
   */
  datalabRoot: string;

  /**
   * Initial port to use when searching for a free Jupyter port.
   */
  nextJupyterPort: number;

  /**
   * The port to use for socketio proxying.
   */
  socketioPort: number;

  /**
   * Local directory where kernels are started.
   */
  contentDir: string;

  /**
   * The port to use to proxy kernel manager websocket requests. A value of 0
   * disables proxying.
   */
  kernelManagerProxyPort: number;

  /**
   * The hostname (or IP) to use to proxy kernel manager websocket requests.
   * An empty value uses localhost.
   */
  kernelManagerProxyHost: string;

  /**
   * If true, also tee jupyter logs to disk.
   *
   * TODO(b/33253129): Remove this flag.
   */
  jupyterDiskLogs: boolean;
}
