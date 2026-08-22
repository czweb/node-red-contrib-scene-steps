/**
 * actions/udp_send.js
 *  通过 UDP (dgram) 发送报文。支持单播/广播；可选 bindLocalAddr/bindLocalPort/broadcast=true/multicastTTL/multicastInterface
 */
'use strict';

const dgram = require('dgram');
const { SceneError } = require('../nodes/lib/errors');

function parsePayload(p, fmt) {
  if (p == null) p = '';
  const format = String(fmt || 'auto').toLowerCase();
  switch (format) {
    case 'string':
      return Buffer.from(String(p), 'utf8');
    case 'hex': {
      const s = String(p).replace(/[\s,;:]/g, '');
      if (s.length % 2 !== 0) throw SceneError.fromCode('BAD_CONFIG', `UDP HEX 长度非偶数`);
      if (!/^[0-9a-fA-F]*$/.test(s)) throw SceneError.fromCode('BAD_CONFIG', `UDP HEX 非法字符`);
      return Buffer.from(s, 'hex');
    }
    case 'base64':
      return Buffer.from(String(p), 'base64');
    default:
      if (Buffer.isBuffer(p)) return p;
      return Buffer.from(String(p), 'utf8');
  }
}

module.exports = {
  type: 'udp_send',
  category: 'network',
  icon: 'fa-paper-plane',
  label: 'UDP 发送',
  configSchema: {
    host: { type: 'string', template: true, required: true, label: '目标主机' },
    port: { type: 'number', min: 1, max: 65535, required: true, label: '目标端口' },
    payload: { type: 'string', template: true, required: true, label: '数据', format: 'textarea' },
    format: { type: 'string', enum: ['auto','string','hex','base64'], default: 'auto', label: '输入格式' },
    bindLocalAddr: { type: 'string', default: '', label: '绑定本地 IP（可选）' },
    bindLocalPort: { type: 'number', min: 0, max: 65535, default: 0, label: '绑定本地端口（0=随机）' },
    broadcast: { type: 'boolean', default: false, label: '启用 SO_BROADCAST' },
    multicastTTL: { type: 'number', min: 0, max: 255, default: 1, label: '组播 TTL（仅用于多播）' },
    multicastInterface: { type: 'string', default: '', label: '组播接口 IP（可选）' },
    waitAck: { type: 'boolean', default: false, label: '等待 ack(回包)' },
    ackTimeoutMs: { type: 'number', min: 10, default: 2000, label: 'ack 等待(ms)' }
  },
  defaults: { host: '', port: 0, payload: '', format: 'auto', bindLocalAddr: '', bindLocalPort: 0, broadcast: false, multicastTTL: 1, multicastInterface: '', waitAck: false, ackTimeoutMs: 2000 },
  validate(config) {
    if (!config.host) throw SceneError.fromCode('BAD_CONFIG', 'udp_send: host 不能为空');
    if (!(Number(config.port) >= 1 && Number(config.port) <= 65535)) throw SceneError.fromCode('BAD_CONFIG', 'udp_send: port 必须 1-65535');
    parsePayload(config.payload, config.format);
  },
  async execute(ctx) {
    const c = ctx.config;
    const host = String(c.host);
    const port = Number(c.port);
    const buf = parsePayload(c.payload, c.format);
    const isV6 = host.includes(':') || String(c.bindLocalAddr).includes(':');
    const sock = dgram.createSocket(isV6 ? 'udp6' : 'udp4');
    let done = false;
    try {
      if (c.broadcast) {
        try { sock.setBroadcast(true); } catch (e) {}
      }
      if (Number(c.multicastTTL) > 0) {
        try { sock.setMulticastTTL(Math.max(0, Math.min(255, Number(c.multicastTTL)))); } catch (e) {}
      }
      if (c.multicastInterface) {
        try { sock.setMulticastInterface(c.multicastInterface); } catch (e) {}
      }
      // bind（若指定）
      await new Promise((resolve, reject) => {
        const localPort = Number(c.bindLocalPort) || 0;
        const localAddr = c.bindLocalAddr || '';
        let tid;
        let ok = false;
        sock.once('listening', () => { if (!ok) { ok = true; clearTimeout(tid); resolve(); } });
        sock.once('error', (e) => { if (!ok) { ok = true; clearTimeout(tid); reject(e); } });
        try { sock.bind(localPort, localAddr || undefined); } catch (e) { reject(e); return; }
        tid = setTimeout(() => { if (!ok) { ok = true; resolve(); } }, 120);
      });

      let ack = null;
      await new Promise((resolve, reject) => {
        let tid;
        sock.once('error', (e) => { if (!done) { done = true; clearTimeout(tid); reject(e); } });
        if (c.waitAck) {
          sock.once('message', (msg, rinfo) => {
            if (!done) { done = true; clearTimeout(tid); ack = { data: msg, rinfo }; resolve(); }
          });
          tid = setTimeout(() => {
            if (!done) { done = true; reject(Object.assign(new Error('UDP ack timeout'), { code: 'UDP_ACK_TIMEOUT' })); }
          }, Math.max(10, Number(c.ackTimeoutMs) || 2000));
        }
        sock.send(buf, port, host, (e) => {
          if (e && !done) { done = true; if (c.waitAck) clearTimeout(tid); reject(e); return; }
          if (!c.waitAck && !done) { done = true; resolve(); }
        });
        if (ctx.signal && typeof ctx.signal.once === 'function') {
          ctx.signal.once('abort', function onAbort() {
            if (!done) { done = true; if (c.waitAck) clearTimeout(tid); reject(SceneError.fromCode('CANCELLED')); }
          });
        }
      });

      return {
        output: {
          host, port,
          sentBytes: buf.length,
          sentHex: buf.toString('hex').toUpperCase(),
          ack: ack ? { hex: ack.data.toString('hex').toUpperCase(), len: ack.data.length, from: ack.rinfo && ack.rinfo.address } : null
        }
      };
    } finally {
      try { sock.close(); } catch (e) {}
    }
  }
};
