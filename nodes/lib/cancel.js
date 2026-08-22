/* eslint-disable */
/**
 * scene-steps — nodes/lib/cancel.js
 * 取消令牌 + 可取消延时 + 暂停/继续信号。
 * API 设计参考 AbortController。每个 SceneRun 实例创建一个 CancelSignal，
 * 所有动作的 execute(ctx) 能通过 ctx.signal 拿到，随时检查 aborted。
 */

'use strict';

const { SceneError } = require('./errors');
const EventEmitter = require('events');

class CancelSignal extends EventEmitter {
  constructor() {
    super();
    this.aborted = false;
    this.paused = false;
    this._pauseResolve = null;
  }
  abort(reason) {
    if (this.aborted) return;
    this.aborted = true;
    this.emit('abort', reason);
    // 如果处于 pause 中，也唤醒
    if (this._pauseResolve) { this._pauseResolve('aborted'); this._pauseResolve = null; }
  }
  pause() {
    this.paused = true;
    this.emit('pause');
  }
  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (this._pauseResolve) { const r = this._pauseResolve; this._pauseResolve = null; r('resumed'); }
    this.emit('resume');
  }
  /** 在动作中 await signal.ifPausedWait(); 就能在暂停时阻塞。 */
  ifPausedWait() {
    if (!this.paused) return Promise.resolve();
    if (this.aborted) return Promise.reject(SceneError.fromCode('CANCELLED'));
    return new Promise((resolve, reject) => {
      this._pauseResolve = resolve;
      const onAbort = () => reject(SceneError.fromCode('CANCELLED'));
      this.once('abort', onAbort);
    }).finally(() => this.off('abort', () => {}));
  }
}

function createSignal() { return new CancelSignal(); }

/**
 * 可取消延时。
 * @param {number} ms 毫秒（上限 2^31-1，超限自动截断到上限）
 * @param {CancelSignal} signal 取消令牌
 * @param {number} jitterMs 浮动范围 [ms-jitterMs, ms+jitterMs]（0 = 无浮动）
 * @returns {Promise<void>} 正常 resolve 或 signal abort 时 reject(CANCELLED)
 */
function cancellableDelay(ms, signal, jitterMs = 0) {
  let actual = Number(ms);
  if (!Number.isFinite(actual) || actual < 0) actual = 0;
  if (jitterMs && jitterMs > 0) {
    actual = Math.max(0, actual + (Math.random() * 2 - 1) * jitterMs);
  }
  // Node.js setTimeout 最多 2^31-1 ms
  const MAX = 2 ** 31 - 1;
  if (actual > MAX) actual = MAX;
  actual = Math.floor(actual);

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(SceneError.fromCode('CANCELLED'));
    let tid;
    const doReject = () => { clearTimeout(tid); reject(SceneError.fromCode('CANCELLED')); };
    if (signal) signal.once('abort', doReject);
    tid = setTimeout(() => {
      if (signal) signal.off('abort', doReject);
      resolve();
    }, actual);
  });
}

module.exports = { CancelSignal, createSignal, cancellableDelay };
