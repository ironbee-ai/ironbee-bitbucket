#!/usr/bin/env node

// Bridges 127.0.0.1:<port> to <host>:<port>.
//
// A pipe is a container on the step's Docker service, so an application it
// starts with `docker compose` publishes its ports on that service — reached
// from the pipe as `host.docker.internal` — not on the pipe's own loopback,
// while the CLI's `--port` tunnel dials 127.0.0.1. This puts the port where the
// tunnel looks for it.
//
// It listens only once the upstream accepts a connection. A listener that
// accepted before the application is up would tell the CLI's own wait
// (`--app-wait`) that the application is ready when it is not.
//
//   node forward-port.js --listen <port> --to <host>:<port> --wait <seconds>

'use strict';

const net = require('net');

function flag(argv, name) {
  const at = argv.indexOf(name);
  return at === -1 || at === argv.length - 1 ? '' : argv[at + 1];
}

/** `host:port`, with an IPv6 host in brackets or bare. */
function parseHostPort(value) {
  const text = String(value || '').trim();
  const at = text.lastIndexOf(':');
  if (at <= 0) {
    return null;
  }
  const host = text.slice(0, at).replace(/^\[|\]$/g, '');
  const port = Number(text.slice(at + 1));
  if (host === '' || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }
  return { host, port };
}

function canConnect({ host, port, timeoutMs }) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Polls until a TCP connect to the upstream succeeds; false once `waitSeconds` pass. */
async function waitForUpstream({ host, port, waitSeconds, intervalMs }) {
  const interval = intervalMs === undefined ? 1000 : intervalMs;
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    if (await canConnect({ host, port, timeoutMs: Math.max(interval, 1000) })) {
      return true;
    }
    if (Date.now() + interval > deadline) {
      return false;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, interval);
    });
  }
}

/** Listens on `listenHost:listenPort` and pipes each connection to the upstream. */
function startForwarder({ listenHost, listenPort, host, port }) {
  const server = net.createServer((client) => {
    const upstream = net.connect({ host, port });
    const destroy = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', destroy);
    upstream.on('error', destroy);
    // A close ends the other side rather than destroying it, so what is still
    // queued for a slow reader is delivered first.
    client.on('close', () => upstream.end());
    upstream.on('close', () => client.end());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost === undefined ? '127.0.0.1' : listenHost, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const listenPort = Number(flag(argv, '--listen'));
  const upstream = parseHostPort(flag(argv, '--to'));
  // The CLI's own default when APP_WAIT_SECONDS is unset or not a number.
  const requested = Number(flag(argv, '--wait'));
  const waitSeconds = Number.isFinite(requested) && requested > 0 ? requested : 60;
  if (!Number.isInteger(listenPort) || listenPort <= 0 || upstream === null) {
    throw new Error('usage: forward-port.js --listen <port> --to <host>:<port> --wait <seconds>');
  }

  const target = `${upstream.host}:${String(upstream.port)}`;
  console.log(`waiting up to ${String(waitSeconds)}s for ${target} to accept connections`);
  if (!(await waitForUpstream({ ...upstream, waitSeconds }))) {
    throw new Error(`${target} did not accept a connection within ${String(waitSeconds)}s; nothing is forwarded`);
  }
  const server = await startForwarder({ listenPort, ...upstream });
  // A listener that fails later forwards nothing more; said, and red.
  server.on('error', (error) => {
    console.error(`forwarding 127.0.0.1:${String(listenPort)} stopped: ${error.message}`);
    process.exit(1);
  });
  console.log(`forwarding 127.0.0.1:${String(listenPort)} to ${target}`);
}

module.exports = { parseHostPort, canConnect, waitForUpstream, startForwarder };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
