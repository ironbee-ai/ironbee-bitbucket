'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { parseHostPort, canConnect, waitForUpstream, startForwarder } = require('../scripts/forward-port.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'forward-port.js');

function echoServer(port) {
  const server = net.createServer((socket) => {
    socket.pipe(socket);
  });
  return new Promise((resolve) => {
    server.listen(port || 0, '127.0.0.1', () => resolve(server));
  });
}

/** A port nothing listens on: taken from the OS, then released. */
async function freePort() {
  const server = await echoServer(0);
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function roundTrip(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString();
      if (received.length >= text.length) {
        socket.end();
        resolve(received);
      }
    });
    socket.on('error', reject);
    socket.write(text);
  });
}

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

test('forward-port: host:port parses, an IPv6 host with or without brackets', () => {
  assert.deepEqual(parseHostPort('host.docker.internal:4000'), { host: 'host.docker.internal', port: 4000 });
  assert.deepEqual(parseHostPort('docker:4000'), { host: 'docker', port: 4000 });
  assert.deepEqual(parseHostPort('[fd00::5]:4000'), { host: 'fd00::5', port: 4000 });
  assert.deepEqual(parseHostPort('fd00::5:4000'), { host: 'fd00::5', port: 4000 });
  assert.equal(parseHostPort('docker'), null);
  assert.equal(parseHostPort(':4000'), null);
  assert.equal(parseHostPort('docker:http'), null);
});

test('forward-port: an upstream that is up is reached at once', async () => {
  const upstream = await echoServer();
  try {
    const { port } = upstream.address();
    assert.equal(await canConnect({ host: '127.0.0.1', port, timeoutMs: 1000 }), true);
    assert.equal(await waitForUpstream({ host: '127.0.0.1', port, waitSeconds: 1, intervalMs: 50 }), true);
  } finally {
    upstream.close();
  }
});

test('forward-port: an upstream that never comes up gives up after the wait', async () => {
  const port = await freePort();
  const started = Date.now();
  assert.equal(await waitForUpstream({ host: '127.0.0.1', port, waitSeconds: 0.5, intervalMs: 50 }), false);
  assert.ok(Date.now() - started < 3000);
});

test('forward-port: an upstream that comes up late is waited for', async () => {
  const port = await freePort();
  let upstream = null;
  const late = sleep(300).then(async () => {
    upstream = await echoServer(port);
  });
  try {
    assert.equal(await waitForUpstream({ host: '127.0.0.1', port, waitSeconds: 5, intervalMs: 50 }), true);
  } finally {
    await late;
    upstream.close();
  }
});

test('forward-port: each connection is piped to the upstream and back', async () => {
  const upstream = await echoServer();
  const forwarder = await startForwarder({ listenPort: 0, host: '127.0.0.1', port: upstream.address().port });
  try {
    assert.equal(await roundTrip(forwarder.address().port, 'hello'), 'hello');
    assert.equal(await roundTrip(forwarder.address().port, 'again'), 'again');
  } finally {
    forwarder.close();
    upstream.close();
  }
});

// An HTTP/1.0 or `Connection: close` server writes its answer and hangs up. What
// the forwarder still holds for a reader that has not caught up must arrive.
test('forward-port: an upstream that ends after writing still delivers every byte', async () => {
  let accepted = null;
  const upstreamSide = new Promise((resolve) => {
    accepted = resolve;
  });
  const upstream = net.createServer((socket) => accepted(socket));
  await new Promise((resolve) => {
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const forwarder = await startForwarder({ listenPort: 0, host: '127.0.0.1', port: upstream.address().port });
  let forwarded = null;
  forwarder.on('connection', (socket) => {
    forwarded = socket;
  });
  const client = net.connect({ host: '127.0.0.1', port: forwarder.address().port });
  client.pause();
  try {
    const source = await upstreamSide;
    // Written piece by piece while the reader reads nothing, until the socket
    // buffers between them are full and the forwarder is left holding bytes.
    const piece = Buffer.alloc(8 * 1024, 'x');
    const deadline = Date.now() + 20000;
    let sent = 0;
    for (;;) {
      source.write(piece);
      sent += piece.length;
      while (forwarded === null || !(forwarded.bytesWritten >= sent)) {
        assert.ok(Date.now() < deadline, 'the forwarder stopped reading the upstream');
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
      }
      if (forwarded.writableLength > 0) {
        // Held, not just in flight: the reader's side has stopped taking any.
        await sleep(50);
        if (forwarded.writableLength > 0) {
          break;
        }
      }
    }
    const hungUp = new Promise((resolve) => {
      source.once('close', resolve);
    });
    source.end();
    await hungUp;
    await sleep(200);

    const received = await new Promise((resolve, reject) => {
      let total = 0;
      client.on('data', (chunk) => {
        total += chunk.length;
      });
      client.on('end', () => resolve(total));
      client.on('error', reject);
      client.resume();
    });
    assert.equal(received, sent);
  } finally {
    client.destroy();
    forwarder.close();
    upstream.close();
  }
});

// The point of waiting: a listener that accepted before the application was up
// would tell the CLI's own wait that it is ready when it is not.
test('forward-port: the script listens only once the upstream answers', async () => {
  const listenPort = await freePort();
  const upstreamPort = await freePort();
  const child = spawn(process.execPath, [
    SCRIPT, '--listen', String(listenPort), '--to', `127.0.0.1:${String(upstreamPort)}`, '--wait', '10',
  ], { stdio: 'ignore' });
  let upstream = null;
  try {
    await sleep(500);
    assert.equal(await canConnect({ host: '127.0.0.1', port: listenPort, timeoutMs: 500 }), false);

    upstream = await echoServer(upstreamPort);
    let listening = false;
    for (let i = 0; i < 50 && !listening; i += 1) {
      await sleep(100);
      listening = await canConnect({ host: '127.0.0.1', port: listenPort, timeoutMs: 500 });
    }
    assert.equal(listening, true);
    assert.equal(await roundTrip(listenPort, 'through'), 'through');
  } finally {
    child.kill();
    if (upstream !== null) {
      upstream.close();
    }
  }
});

test('forward-port: the script exits non-zero when the upstream never answers', async () => {
  const upstreamPort = await freePort();
  const listenPort = await freePort();
  const child = spawn(process.execPath, [
    SCRIPT, '--listen', String(listenPort), '--to', `127.0.0.1:${String(upstreamPort)}`, '--wait', '1',
  ], { stdio: 'ignore' });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 1);
});
