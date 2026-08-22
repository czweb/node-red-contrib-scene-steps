/**
 * actions/tcp_send.js
 *  通过 TCP 发送报文。支持：
 *   - host/port 必填
 *   - payload 格式：string / hex（如 "010203FF" / "01 02 03 FF"）/ base64 / auto（string，遇到非ASCII当UTF-8 buffer）
 *   - expectResponse：true 时收期望长度（readLen）或读到分隔符（readDelimiter，如 "\r\n" / "0D0A"），maxMs 超时
 *   - keepAlive：false（每次新开）/true（用连接池复用）
 */
'use strict';

const { defaultPool } = require('../nodes/lib/tcp_pool');
const { SceneError } = require('../nodes/lib/errors');

const FORMAT_HELP = '支持 string|hex|base64|auto；hex 允许形如 "01 02 03 FF" / "010203FF" 的十六进制串。';

function parsePayload(p, fmt) {
  if (p == null) p = '';
  const format = String(fmt || 'auto').toLowerCase();
  switch (format) {
    case 'string':
      return Buffer.from(String(p), 'utf8');
    case 'hex': {
      const s = String(p).replace(/[\s,;:]/g, '');
      if (s.length % 2 !== 0) throw SceneError.fromCode('BAD_CONFIG', `TCP HEX 长度非偶数: ${s}；${FORMAT_HELP}`);
      if (!/^[0-9a-fA-F]*$/.test(s)) throw SceneError.fromCode('BAD_CONFIG', `TCP HEX 非法字符: ${s}；${FORMAT_HELP}`);
      return Buffer.from(s, 'hex');
    }
    case 'base64':
      return Buffer.from(String(p), 'base64');
    case 'auto':
    default:
      if (Buffer.isBuffer(p)) return p;
      return Buffer.from(String(p), 'utf8');
  }
}

function formatResponse(buf, fmt) {
  if (!Buffer.isBuffer(buf)) return buf;
  const f = String(fmt || 'string').toLowerCase();
  if (f === 'hex') return buf.toString('hex').toUpperCase();
  if (f === 'base64') return buf.toString('base64');
  return buf.toString('utf8');
}

/**
 * 从 socket 里按 delimiter 或 length 读到期望数据（带超时）。
 * 返回 Promise<Buffer>。
 */
function readExpected(socket, { readLen, readDelimiter, bufferEncoding, maxMs, signal }) {
  return new Promise((resolve, reject) => {
    let done = false;
    let tid = null;
    const chunks = [];
    let acc = Buffer.alloc(0);
    const delimiterBuf = (() => {
      if (!readDelimiter) return null;
      if (Buffer.isBuffer(readDelimiter)) return readDelimiter;
      if (/^[0-9a-fA-F\s,;:]+$/.test(readDelimiter) && readDelimiter.trim().length > 0) {
        const s = String(readDelimiter).replace(/[\s,;:]/g, '');
        if (s.length % 2 === 0) return Buffer.from(s, 'hex');
      }
      return Buffer.from(String(readDelimiter), bufferEncoding || 'utf8');
    })();
    const wantLen = Number(readLen) > 0 ? Number(readLen) : 0;

    function finish(err, result) {
      if (done) return;
      done = true;
      clearTimeout(tid);
      socket.removeListener('data', onData);
      socket.removeListener('error', onErr);
      socket.removeListener('close', onClose);
      socket.removeListener('end', onEnd);
      if (signal) signal.offAbort && signal.offAbort(onAbort);
      if (err) return reject(err);
      resolve(result);
    }

    tid = setTimeout(() => {
      finish(Object.assign(new Error('TCP read timeout'), { code: 'TCP_READ_TIMEOUT' }));
    }, Math.max(10, Math.floor(maxMs || 5000)));

    function onAbort() {
      finish(SceneError.fromCode('CANCELLED'));
    }
    if (signal && typeof signal.once === 'function') signal.once('abort', onAbort);

    function onErr(e) { finish(e); }
    function onClose() { finish(SceneError.fromCode('NETWORK_ERROR', 'TCP socket closed before response')); }
    function onEnd() {
      // 若还没有收完，尝试把已收的交上去（按 wantLen=0 情况下是 OK 的）
      if (!wantLen && !delimiterBuf) { finish(null, Buffer.concat(chunks)); }
      else finish(SceneError.fromCode('NETWORK_ERROR', 'TCP socket ended before full response'));
    }
    function onData(chunk) {
      if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
      chunks.push(chunk);
      acc = Buffer.concat(chunks);
      if (wantLen > 0 && acc.length >= wantLen) {
        finish(null, acc.slice(0, wantLen));
        return;
      }
      if (delimiterBuf) {
        const idx = acc.indexOf(delimiterBuf);
        if (idx !== -1) {
          finish(null, acc.slice(0, idx + delimiterBuf.length));
          return;
        }
      }
      if (!wantLen && !delimiterBuf) {
        // 没有指定读多长或分隔符：单次 data 即结束（和 Node-RED tcp request 单包行为一致）
        finish(null, acc);
      }
    }
    socket.on('data', onData);
    socket.once('error', onErr);
    socket.once('close', onClose);
    socket.once('end', onEnd);
  });
}

module.exports = {
  type: 'tcp_send',
  category: 'network',
  icon: 'fa-plug',
  label: 'TCP 发送',
  configSchema: {
    host: { type: 'string', template: true, required: true, label: '主机' },
    port: { type: 'number', min: 1, max: 65535, required: true, label: '端口' },
    payload: { type: 'string', template: true, required: true, label: '数据', format: 'textarea' },
    format: { type: 'string', enum: ['auto','string','hex','base64'], default: 'auto', label: '输入格式' },
    responseFormat: { type: 'string', enum: ['string','hex','base64'], default: 'string', label: '响应格式' },
    expectResponse: { type: 'boolean', default: false, label: '等待响应' },
    readLen: { type: 'number', min: 0, default: 0, label: '读字节数(0=分隔符/单次)' },
    readDelimiter: { type: 'string', default: '', label: '分隔符（字符串或 HEX，如 0D0A 或 \\r\\n）' },
    readTimeoutMs: { type: 'number', min: 10, default: 5000, label: '读超时(ms)' },
    keepAlive: { type: 'boolean', default: true, label: '保持连接/复用连接池' },
    connectTimeoutMs: { type: 'number', min: 50, default: 10000, label: '连接超时(ms)' }
  },
  defaults: { host: '', port: 0, payload: '', format: 'auto', responseFormat: 'string', expectResponse: false, readLen: 0, readDelimiter: '', readTimeoutMs: 5000, keepAlive: true, connectTimeoutMs: 10000 },
  validate(config) {
    if (!config.host) throw SceneError.fromCode('BAD_CONFIG', 'tcp_send: host 不能为空');
    if (!(Number(config.port) >= 1 && Number(config.port) <= 65535)) throw SceneError.fromCode('BAD_CONFIG', 'tcp_send: port 必须 1-65535');
    parsePayload(config.payload, config.format); // 预验证
  },
  async execute(ctx) {
    const config = ctx.config;
    const host = String(config.host);
    const port = Number(config.port);
    const buf = parsePayload(config.payload, config.format);

    const socket = await defaultPool.acquire(host, port, { connectTimeoutMs: Number(config.connectTimeoutMs) || 10000 });
    let response = null;
    try {
      // 写入
      await new Promise((resolve, reject) => {
        let done = false;
        socket.once('error', function onErr(e) { if (!done) { done = true; reject(e); } });
        socket.write(buf, () => { if (!done) { done = true; resolve(); } });
      });
      if (config.expectResponse) {
        const rb = await readExpected(socket, {
          readLen: Number(config.readLen) || 0,
          readDelimiter: String(config.readDelimiter || ''),
          bufferEncoding: 'utf8',
          maxMs: Number(config.readTimeoutMs) || 5000,
          signal: ctx.signal
        });
        response = {
          rawHex: rb.toString('hex').toUpperCase(),
          data: formatResponse(rb, config.responseFormat),
          length: rb.length
        };
      }
    } finally {
      if (config.keepAlive) defaultPool.release(socket);
      else defaultPool.destroy(socket);
    }
    return {
      output: {
        host, port,
        sentBytes: buf.length,
        sentHex: buf.toString('hex').toUpperCase(),
        response
      }
    };
  }
};
