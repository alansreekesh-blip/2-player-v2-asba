const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const GAME_FILE = path.join(__dirname, 'ASBA V7.1.html');
const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const rooms = new Map();

function roomCode() {
  let c;
  do c = String(Math.floor(1000 + Math.random() * 9000));
  while (rooms.has(c));
  return c;
}

function wsSend(sock, obj) {
  if (!sock || sock.destroyed) return;
  const payload = Buffer.from(JSON.stringify(obj));
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  sock.write(Buffer.concat([header, payload]));
}

function decodeFrames(sock, chunk) {
  sock.buf = sock.buf ? Buffer.concat([sock.buf, chunk]) : chunk;
  const messages = [];
  while (sock.buf.length >= 2) {
    const b0 = sock.buf[0], b1 = sock.buf[1];
    const op = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, off = 2;
    if (len === 126) {
      if (sock.buf.length < 4) break;
      len = sock.buf.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (sock.buf.length < 10) break;
      len = Number(sock.buf.readBigUInt64BE(2)); off = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (sock.buf.length < off + maskLen + len) break;
    if (op === 8) { sock.end(); return messages; }
    let payload = sock.buf.subarray(off + maskLen, off + maskLen + len);
    if (masked) {
      const mask = sock.buf.subarray(off, off + 4);
      payload = Buffer.from(payload.map((v, i) => v ^ mask[i % 4]));
    }
    messages.push(payload.toString('utf8'));
    sock.buf = sock.buf.subarray(off + maskLen + len);
  }
  return messages;
}

function other(sock) {
  const r = rooms.get(sock.roomCode);
  if (!r) return null;
  return sock.role === 'host' ? r.guest : r.host;
}

function handle(sock, msg) {
  if (msg.type === 'create') {
    if (sock.roomCode && rooms.has(sock.roomCode)) {
      const old = rooms.get(sock.roomCode);
      if (old.host === sock) {
        wsSend(old.guest, { type: 'hostLeft' });
        if (old.guest) { old.guest.roomCode = null; old.guest.role = null; }
        rooms.delete(sock.roomCode);
      } else if (old.guest === sock) {
        old.guest = null;
        wsSend(old.host, { type: 'peerLeft' });
      }
    }
    const c = roomCode();
    rooms.set(c, { host: sock, guest: null });
    sock.roomCode = c; sock.role = 'host';
    wsSend(sock, { type: 'roomCreated', code: c });
  } else if (msg.type === 'join') {
    if (sock.roomCode && rooms.has(sock.roomCode)) {
      const old = rooms.get(sock.roomCode);
      if (old.guest === sock) {
        old.guest = null;
        wsSend(old.host, { type: 'peerLeft' });
      } else if (old.host === sock) {
        wsSend(old.guest, { type: 'hostLeft' });
        rooms.delete(sock.roomCode);
      }
    }
    const c = String(msg.code || '').toUpperCase();
    const r = rooms.get(c);
    if (!r) return wsSend(sock, { type: 'error', message: 'Room not found.' });
    if (r.guest) return wsSend(sock, { type: 'error', message: 'Room is full.' });
    r.guest = sock; sock.roomCode = c; sock.role = 'guest';
    wsSend(sock, { type: 'joined', code: c });
    wsSend(r.host, { type: 'peerJoined' });
  } else if (msg.type === 'start') {
    if (sock.role !== 'host') return;
    wsSend(other(sock), { type: 'start', difficulty: msg.difficulty, role: 'guest' });
  } else if (msg.type === 'chat') {
    wsSend(other(sock), { type: 'chat', from: sock.role === 'host' ? 'P1' : 'P2', text: String(msg.text || '').slice(0, 120) });
  } else {
    wsSend(other(sock), Object.assign({}, msg, { from: sock.role === 'host' ? 'P1' : 'P2' }));
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/ASBA%20V7.1.html' || req.url === '/ASBA V7.1.html') {
    fs.readFile(GAME_FILE, 'utf8', (err, html) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Could not load ASBA V7.1.html\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found\n');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + MAGIC).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.on('data', chunk => {
    for (const raw of decodeFrames(socket, chunk)) {
      try { handle(socket, JSON.parse(raw)); } catch {}
    }
  });
  socket.on('close', () => {
    const r = rooms.get(socket.roomCode);
    if (!r) return;
    if (socket.role === 'host') {
      wsSend(r.guest, { type: 'hostLeft' });
      rooms.delete(socket.roomCode);
    } else {
      r.guest = null;
      wsSend(r.host, { type: 'peerLeft' });
    }
  });
});

server.listen(PORT, () => {
  console.log('ASBA multiplayer server running on port ' + PORT);
  console.log('Open http://YOUR-COMPUTER-IP:' + PORT + ' on both iPads.');
});
