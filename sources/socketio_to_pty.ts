/*
 * Copyright 2020 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License.
 */

import * as http from 'http';
import * as logging from './logging';
import * as socketio from 'socket.io';
import * as nodePty from 'node-pty';

interface DataMessage {
  channel: string;
  data: string;
}

// Pause and resume are missing from the typings.
interface Pty {
  pause(): void;
  resume(): void;
}

let sessionCounter = 0;

// These are wild guesses, intended to allow some bursts of output before
// the process gets blocked waiting on the terminal to update.
const UNACKED_HIGH_WATER = 20;
const UNACKED_LOW_WATER = 2;

/** Socket.io<->terminal adapter. */
class Session {
  private readonly id: number;
  private readonly pty: nodePty.IPty;
  private unackedCount = 0;

  constructor(private readonly socket: SocketIO.Socket, useBash: boolean) {
    this.id = sessionCounter++;

    this.socket.on('disconnect', () => {
      logging.getLogger().debug('Socket disconnected for session %d', this.id);

      // Handle client disconnects to close sockets, so as to free up resources.
      this.close();
    });

    this.socket.on('data', (event: DataMessage) => {
      // The client sends this message per data message to a particular channel.
      // Propagate the message over to the Socket associated with the
      // specified channel.

      logging.getLogger().debug('Send data in session %d\n%s', this.id,
      event.data);
      const message = JSON.parse(event.data) as PtyMessage;
      if (message.data) {
        this.pty.write(message.data);
      }
      if (message.cols && message.rows) {
        this.pty.resize(message.cols, message.rows);
      }
    });

    let spawnProcess = 'tmux';
    let processArgs = ['new-session', '-A', '-D', '-s', '0'];
    if (useBash) {
      spawnProcess = 'bash';
      processArgs = [];
    }
    this.pty = nodePty.spawn(spawnProcess, processArgs, {
      name: "xterm-color",
      cwd: './content', // Which path should terminal start
      // Pass environment variables
      env: process.env as { [key: string]: string; },
    });

    this.pty.onData((data: string) => {
      ++this.unackedCount;
      if (this.unackedCount > UNACKED_HIGH_WATER) {
        (this.pty as unknown as Pty).pause();
      }
      this.socket.emit('data', {data, pause: true}, () => {
        this.unackedCount = Math.max(0, --this.unackedCount);
        if (this.unackedCount < UNACKED_LOW_WATER) {
          (this.pty as unknown as Pty).resume();
        }
      });
    });

    this.pty.onExit(({exitCode, signal}: {exitCode: number, signal?: number}) => {
      this.socket.emit('exit', {exitCode, signal});
      this.socket.disconnect(true);
    });
  }

  private close() {
    this.socket.disconnect(true);
    this.pty.kill();
  }
}

/** SocketIO to node-pty adapter. */
export class SocketIoToPty {
  constructor(private readonly path: string, server: http.Server, useBash: boolean) {
    const io = socketio(server, {
      path: '/tty',
      transports: ['polling'],
      allowUpgrades: false,
      // v2.10 changed default from 60s to 5s, prefer the longer timeout to
      // avoid errant disconnects.
      pingTimeout: 60000,
    });

    io.of('/').on('connection', (socket: SocketIO.Socket) => {
      // Session manages its own lifetime.
      // tslint:disable-next-line:no-unused-expression
      new Session(socket, useBash);
    });
  }

  /** Return true iff path is handled by socket.io. */
  isPathProxied(path: string): boolean {
    return path.indexOf(this.path + '/') === 0;
  }
}

declare interface PtyMessage {
  readonly data?: string;
  readonly cols?: number;
  readonly rows?: number;
}
