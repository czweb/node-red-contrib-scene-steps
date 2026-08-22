/**
 * actions/mqtt_publish.js
 *  零依赖的最小 MQTT 3.1.1 PUBLISH 客户端（QoS0，无遗嘱，无保留）：
 *   1. TCP 连接 broker host:port
 *   2. 发 CONNECT(proto=MQTT, version=4, cleanSession=1, clientId)
 *   3. 等 CONNACK 2 bytes (0x20 0x02 + code=0)；若 broker 返回非 0 = 失败
 *   4. 发 PUBLISH(qos0) topic + payload
 *   5. 可选发 DISCONNECT，或直接 close；用连接池 keepAlive 则保持连接复用
 *
 *  TLS(mqtts) MVP 不支持（需要 tls 模块 + 证书处理）；需要时后续再扩展。
 */
'use strict';

const net = require('net');
const { defaultPool } = require('../nodes/lib/tcp_pool');
const { SceneError } = require('../nodes/lib/errors');

/** 编码 MQTT 可变字节整数 */
function encodeVarInt(n) {
  if (n < 0 || n >= 0x8000000) throw SceneError.fromCode('BAD_CONFIG', 'MQTT: 报文大小溢出');
  const out = [];
  do {
    let b = n % 128; n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}
function encodeLenPrefixed(s) {
  const buf = Buffer.from(String(s), 'utf8');
  const h = Buffer.alloc(2); h.writeUInt16BE(buf.length, 0);
  return Buffer.concat([h, buf]);
}

/** 解码可变字节：从 position 开始，返回 {value, bytes} */
function readVarInt(buf, start) {
  let multiplier = 1, value = 0, pos = start;
  let byte = 0;
  do {
    if (pos >= buf.length) throw SceneError.fromCode('NETWORK_ERROR', 'MQTT 响应包截断');
    byte = buf[pos++];
    value += (byte & 0x7F) * multiplier;
    multiplier *= 0x80;
    if (multiplier > 0x80 * 0x80 * 0x80 * 0x80) throw SceneError.fromCode('NETWORK_ERROR', 'MQTT 响应包非法');
  } while ((byte & 0x80) !== 0);
  return { value, bytes: pos - start };
}

function readExactly(sock, n, maxMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let tid = setTimeout(() => { if (!settled) { settled = true; reject(Object.assign(new Error('MQTT read timeout'), { code: 'MQTT_TIMEOUT' })); } }, Math.max(50, maxMs));
    const chunks = [];
    function onEnd() { if (!settled) { settled = true; clearTimeout(tid); reject(SceneError.fromCode('NETWORK_ERROR', 'MQTT socket closed')); } }
    function onErr(e) { if (!settled) { settled = true; clearTimeout(tid); reject(e); } }
    function onData(c) {
      chunks.push(c);
      const acc = Buffer.concat(chunks);
      if (acc.length >= n) { if (!settled) { settled = true; clearTimeout(tid); resolve(acc.slice(0, n)); } }
    }
    sock.once('end', onEnd);
    sock.once('error', onErr);
    sock.on('data', onData);
    // 订阅一次性 data 后，如果已满足要立即解绑（简单起见 data 每次检查，结束即 off）
  }).then(b => { sock.removeAllListeners('data'); return b; });
}

/** 读一个 MQTT 报文（header + remaining），返回整包 Buffer */
async function readPacket(sock, maxMs) {
  // 读 2 字节最小：固定头 + 第1位 varint
  let h1 = await readExactly(sock, 2, maxMs);
  let acc = h1;
  const fixed = h1[0];
  let { value: remaining, bytes: used } = readVarInt(h1, 1);
  while (used < 0) {}   // 占位（readVarInt 不会负）
  // 如果 varint 跨了 1 字节以上 → 继续读
  while (acc.length < 1 + used) {
    const need = (1 + used) - acc.length;
    const more = await readExactly(sock, need, maxMs);
    acc = Buffer.concat([acc, more]);
  }
  // 现在 1 + used 字节已全部读完（固定+varint结束），remaining 已知。
  const tail = await readExactly(sock, remaining, maxMs);
  const full = Buffer.concat([acc, tail]);
  return { fixed, remaining, buf: full, payload: tail };
}

function buildConnect(clientId, opts) {
  const flags = {
    username: !!(opts && opts.username),
    password: !!(opts && opts.password),
    willRetain: false, willQos: 0, willFlag: false, cleanSession: 1, reserved: 0
  };
  const byte8 =
    ((flags.username ? 1 : 0) << 7) |
    ((flags.password ? 1 : 0) << 6) |
    ((flags.willRetain ? 1 : 0) << 5) |
    ((flags.willQos & 0x3) << 3) |
    ((flags.willFlag ? 1 : 0) << 2) |
    ((flags.cleanSession ? 1 : 0) << 1) |
    (flags.reserved);

  const varPayloads = [
    encodeLenPrefixed(clientId)
  ];
  if (flags.username) varPayloads.push(encodeLenPrefixed(opts.username));
  if (flags.password) varPayloads.push(encodeLenPrefixed(opts.password));

  const protoName = encodeLenPrefixed('MQTT');
  const protoLevel = Buffer.from([4]);  // MQTT 3.1.1
  const flagsByte = Buffer.from([byte8]);
  const keepAlive = Buffer.alloc(2); keepAlive.writeUInt16BE(Number((opts && opts.keepAliveSec) || 60), 0);
  const variableHeader = Buffer.concat([protoName, protoLevel, flagsByte, keepAlive]);
  const payload = Buffer.concat(varPayloads);
  const remaining = variableHeader.length + payload.length;
  const fixed = Buffer.concat([Buffer.from([0x10]), encodeVarInt(remaining)]);
  return Buffer.concat([fixed, variableHeader, payload]);
}

function buildPublish(topic, payloadBuf, qos) {
  const topicBuf = encodeLenPrefixed(topic);
  const q = Math.max(0, Math.min(2, Number(qos) || 0));
  const fixedByte = 0x30 | (q << 1);   // PUBLISH=0x3<<4，无 retain/dup
  const variable = q > 0
    ? Buffer.concat([topicBuf, Buffer.from([0x00, 0x01])])   // 简化：packetId=1
    : topicBuf;
  const remaining = variable.length + payloadBuf.length;
  const fixed = Buffer.concat([Buffer.from([fixedByte]), encodeVarInt(remaining)]);
  return Buffer.concat([fixed, variable, payloadBuf]);
}

function buildDisconnect() { return Buffer.from([0xE0, 0x00]); }

function parsePayload(p, fmt) {
  if (Buffer.isBuffer(p)) return p;
  const f = String(fmt || 'auto').toLowerCase();
  switch (f) {
    case 'hex': {
      const s = String(p).replace(/[\s,;:]/g, '');
      if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw SceneError.fromCode('BAD_CONFIG', 'MQTT payload HEX 非法');
      return Buffer.from(s, 'hex');
    }
    case 'base64': return Buffer.from(String(p), 'base64');
    case 'utf8':
    case 'string':
    case 'auto':
    default: return Buffer.from(String(p == null ? '' : p), 'utf8');
  }
}

module.exports = {
  type: 'mqtt_publish',
  category: 'network',
  icon: 'fa-rss',
  label: 'MQTT 发布',
  configSchema: {
    host: { type: 'string', template: true, required: true, label: 'Broker Host' },
    port: { type: 'number', min: 1, max: 65535, default: 1883, required: true, label: '端口（通常 1883）' },
    clientId: { type: 'string', template: true, default: '', label: 'clientId（空则自动生成）' },
    username: { type: 'string', template: true, default: '', label: '用户名' },
    password: { type: 'string', template: true, default: '', label: '密码' },
    topic: { type: 'string', template: true, required: true, label: '主题' },
    payload: { type: 'string', template: true, required: true, label: '消息体', format: 'textarea' },
    format: { type: 'string', enum: ['auto','string','hex','base64'], default: 'auto', label: '消息体格式' },
    qos: { type: 'number', enum: [0,1,2], default: 0, label: 'QoS（MVP 只验证 QoS0）' },
    keepAliveSec: { type: 'number', min: 1, default: 60, label: 'KeepAlive(秒)' },
    connectTimeoutMs: { type: 'number', min: 100, default: 10000, label: '连接超时(ms)' },
    responseTimeoutMs: { type: 'number', min: 100, default: 5000, label: '收发等待(ms)' }
  },
  defaults: { host: '', port: 1883, clientId: '', username: '', password: '', topic: '', payload: '', format: 'auto', qos: 0, keepAliveSec: 60, connectTimeoutMs: 10000, responseTimeoutMs: 5000 },
  validate(config) {
    if (!config.host) throw SceneError.fromCode('BAD_CONFIG', 'mqtt_publish: host 不能为空');
    if (!(Number(config.port) >= 1 && Number(config.port) <= 65535)) throw SceneError.fromCode('BAD_CONFIG', 'mqtt_publish: port 非法');
    if (!config.topic) throw SceneError.fromCode('BAD_CONFIG', 'mqtt_publish: topic 不能为空');
  },
  async execute(ctx) {
    const c = ctx.config;
    const host = String(c.host);
    const port = Number(c.port);
    const clientId = String(c.clientId || `scene-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`);
    const topic = String(c.topic);
    const payload = parsePayload(c.payload, c.format);
    const qos = Number(c.qos) || 0;
    if (qos !== 0) throw SceneError.fromCode('BAD_CONFIG', 'mqtt_publish MVP 仅支持 QoS0；QoS1/2 后续迭代');

    // 复用连接池：同一个 host:port 如果之前已 connect，那 socket 上 broker 可能是已连接 & 已 CONNACK 状态。
    // 为简单起见 MVP 每次新建 socket，避免连接池里 sock 状态不一致。
    const socket = await (new Promise((resolve, reject) => {
      const sock = net.connect({ host, port }, () => {
        clearTimeout(tid); sock.removeListener('error', onErr); resolve(sock);
      });
      let settled = false;
      sock.setNoDelay(true);
      const onErr = (e) => { if (settled) return; settled = true; clearTimeout(tid); try { sock.destroy(); } catch (e2){} reject(e); };
      sock.once('error', onErr);
      const tid = setTimeout(() => {
        if (settled) return; settled = true;
        try { sock.destroy(); } catch (e) {}
        reject(Object.assign(new Error('MQTT connect timeout'), { code: 'MQTT_CONNECT_TIMEOUT' }));
      }, Math.max(100, Number(c.connectTimeoutMs) || 10000));
    }));

    const signal = ctx.signal;
    try {
      if (signal && signal.aborted) throw SceneError.fromCode('CANCELLED');
      // CONNECT
      const connectPacket = buildConnect(clientId, {
        username: c.username || undefined,
        password: c.password || undefined,
        keepAliveSec: Number(c.keepAliveSec) || 60
      });
      await new Promise((resolve, reject) => {
        let settled = false;
        socket.once('error', function onErr(e) { if (!settled) { settled = true; reject(e); } });
        socket.write(connectPacket, () => { if (!settled) { settled = true; resolve(); } });
      });
      // CONNACK（必须是 0x20 + remaining=2 + 2 bytes body）
      const connack = await readPacket(socket, Number(c.responseTimeoutMs) || 5000);
      if (connack.fixed !== 0x20 || connack.remaining !== 2 || connack.payload.length !== 2 || connack.payload[1] !== 0) {
        throw SceneError.fromCode('NETWORK_ERROR', `MQTT CONNACK 失败，code=${connack.payload ? connack.payload[1] : '?'}`);
      }
      // PUBLISH
      const pubPkt = buildPublish(topic, payload, 0);
      await new Promise((resolve, reject) => {
        let settled = false;
        socket.once('error', function onErr(e) { if (!settled) { settled = true; reject(e); } });
        socket.write(pubPkt, () => { if (!settled) { settled = true; resolve(); } });
      });
      // DISCONNECT（最佳实践）
      try { socket.write(buildDisconnect()); } catch (e) {}
    } finally {
      try { socket.end(); socket.destroy(); } catch (e) {}
    }
    return { output: { host, port, clientId, topic, payloadBytes: payload.length, qos: 0, payloadHex: payload.toString('hex').toUpperCase() } };
  }
};
