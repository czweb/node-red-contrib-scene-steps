/**
 * nodes/lib/tcp_pool.js
 * 轻量 TCP 连接池：key = host:port，按 host:port 维护一个 idle list。
 * 仅使用 Node.js 原生 net 模块，零第三方依赖。
 *
 * - acquire(host, port, {connectTimeoutMs, idleTimeoutMs}): Promise<Socket>
 * - release(socket, {host, port}): 若 socket 未 end 则入池；超过 idleTimeoutMs 自动销毁
 * - destroy(socket): 立即销毁并从池中剔除
 * - shutdown(): 清空池中所有 socket
 */
'use strict';

const net = require('net');

const DEFAULT_IDLE_MS = 60000;
const DEFAULT_CONNECT_MS = 10000;
const DEFAULT_MAX_PER_KEY = 5;

class TcpPool {
  constructor(opts) {
    this.idleTimeoutMs = Number((opts || {}).idleTimeoutMs) || DEFAULT_IDLE_MS;
    this.connectTimeoutMs = Number((opts || {}).connectTimeoutMs) || DEFAULT_CONNECT_MS;
    this.maxPerKey = Number((opts || {}).maxPerKey) || DEFAULT_MAX_PER_KEY;
    this._pool = new Map(); // key -> [{socket, expiresAt}]
    this._register = new WeakMap(); // socket -> {key}
  }

  _key(host, port) { return `${String(host)}:${Number(port)}`; }

  acquire(host, port, opts) {
    const connectTimeoutMs = Number(opts && opts.connectTimeoutMs) || this.connectTimeoutMs;
    const key = this._key(host, port);
    // 从池里取：优先取 idle 未过期的
    let idle = this._pool.get(key) || [];
    idle = idle.filter(entry => entry.expiresAt > Date.now());
    // 反向：取最新 push 的那条（LIFO，减少同时在途时间）
    while (idle.length) {
      const entry = idle.pop();
      const s = entry.socket;
      if (s.destroyed || !s.writable || !s.readable) { try { s.destroy(); } catch (e) {} continue; }
      this._pool.set(key, idle);
      return Promise.resolve(s);
    }
    this._pool.set(key, idle);

    // 新建连接
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = net.connect({ host, port }, () => {
        if (settled) return;
        settled = true;
        clearTimeout(tid);
        socket.removeListener('error', onErr);
        this._register.set(socket, { key });
        socket.once('error', () => { /* 连接上后，错误交给上层处理 */ });
        resolve(socket);
      });
      socket.setNoDelay(true);
      const onErr = (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(tid);
        try { socket.destroy(); } catch (e2) {}
        reject(e);
      };
      socket.once('error', onErr);
      const tid = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch (e) {}
        reject(Object.assign(new Error(`connect ${key} timeout ${connectTimeoutMs}ms`), { code: 'TCP_CONNECT_TIMEOUT' }));
      }, connectTimeoutMs);
    });
  }

  release(socket) {
    if (!socket || socket.destroyed) return;
    const info = this._register.get(socket);
    if (!info) return;
    const key = info.key;
    const list = this._pool.get(key) || [];
    // 池上限：超过则销毁
    if (list.length >= this.maxPerKey) {
      try { socket.end(); socket.destroy(); } catch (e) {}
      return;
    }
    const expiresAt = Date.now() + this.idleTimeoutMs;
    list.push({ socket, expiresAt });
    this._pool.set(key, list);
    // idle timeout 清理
    socket.setTimeout(this.idleTimeoutMs, () => {
      // 超时从池中移除
      const arr = this._pool.get(key);
      if (arr) {
        const idx = arr.findIndex(e => e.socket === socket);
        if (idx !== -1) arr.splice(idx, 1);
      }
      try { socket.end(); socket.destroy(); } catch (e) {}
    });
  }

  destroy(socket) {
    if (!socket) return;
    const info = this._register.get(socket);
    if (info) {
      const arr = this._pool.get(info.key);
      if (arr) {
        const idx = arr.findIndex(e => e.socket === socket);
        if (idx !== -1) arr.splice(idx, 1);
      }
    }
    try { socket.end(); socket.destroy(); } catch (e) {}
  }

  shutdown() {
    for (const list of this._pool.values()) {
      for (const entry of list) {
        try { entry.socket.end(); entry.socket.destroy(); } catch (e) {}
      }
    }
    this._pool.clear();
  }
}

// 全局默认实例（scene-steps 节点共享；Node-RED 进程中单例足够）
const defaultPool = new TcpPool();

module.exports = { TcpPool, defaultPool };
