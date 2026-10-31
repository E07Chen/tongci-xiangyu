// 极简 WebSocket 服务端（零依赖），只实现本游戏需要的部分：
// 握手、文本帧收发、ping/pong、关闭帧、分片帧。
const crypto = require('crypto');
const EventEmitter = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

class Socket extends EventEmitter {
  constructor(sock) {
    super();
    this.sock = sock;
    this.readyState = 1; // 1 = OPEN
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragOpcode = 0;

    sock.on('data', (d) => this._onData(d));
    sock.on('close', () => this._closed());
    sock.on('error', () => this._closed());
    sock.setNoDelay(true);
  }

  _closed() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > 1024 * 1024) return this.terminate(); // 防滥用
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2));
        off = 10;
      }
      if (!masked) return this.terminate(); // 客户端帧必须带掩码
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const data = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      this._onFrame(fin, opcode, data);
    }
  }

  _onFrame(fin, opcode, data) {
    if (opcode === 0x8) { // close
      try { this.sock.write(frame(0x8, data.subarray(0, 2))); } catch (e) {}
      this.sock.end();
      return this._closed();
    }
    if (opcode === 0x9) { // ping -> pong
      try { this.sock.write(frame(0xa, data)); } catch (e) {}
      return;
    }
    if (opcode === 0xa) return this.emit('pong');
    if (opcode === 0x1 || opcode === 0x2) {
      this.fragOpcode = opcode;
      this.fragments = [data];
    } else if (opcode === 0x0) {
      this.fragments.push(data);
    } else return;
    if (fin) {
      const msg = Buffer.concat(this.fragments);
      this.fragments = [];
      this.emit('message', this.fragOpcode === 0x1 ? msg.toString('utf8') : msg);
    }
  }

  send(str) {
    if (this.readyState !== 1) return;
    try { this.sock.write(frame(0x1, Buffer.from(String(str), 'utf8'))); } catch (e) {}
  }
  ping() {
    if (this.readyState !== 1) return;
    try { this.sock.write(frame(0x9, Buffer.alloc(0))); } catch (e) {}
  }
  close() {
    if (this.readyState !== 1) return;
    try { this.sock.write(frame(0x8, Buffer.alloc(0))); this.sock.end(); } catch (e) {}
  }
  terminate() {
    try { this.sock.destroy(); } catch (e) {}
    this._closed();
  }
}

class WebSocketServer extends EventEmitter {
  constructor({ server }) {
    super();
    this.clients = new Set();
    server.on('upgrade', (req, sock) => {
      const key = req.headers['sec-websocket-key'];
      if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
        return sock.destroy();
      }
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      sock.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
      );
      const ws = new Socket(sock);
      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));
      this.emit('connection', ws);
    });
  }
}

module.exports = { WebSocketServer };
