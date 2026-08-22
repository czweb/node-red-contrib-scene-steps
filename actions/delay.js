/* eslint-disable */
/**
 * scene-steps — actions/delay.js
 * 延时等待动作。
 */

'use strict';

const { cancellableDelay } = require('../nodes/lib/cancel');

const action = {
  type: 'delay',
  category: 'timing',
  icon: 'fa-clock-o',
  label: '延时等待',
  configSchema: {
    type: 'object',
    required: ['delayMs'],
    properties: {
      delayMs:  { type: 'number', title: '延时(ms)', default: 1000, minimum: 0, maximum: 86400000, description: '单次最大 24 小时' },
      jitterMs: { type: 'number', title: '浮动范围(ms)', default: 0, minimum: 0, description: '实际延时 ±jitterMs 随机浮动，防止设备洪峰' }
    }
  },
  defaults: { delayMs: 1000, jitterMs: 0 },
  validate(cfg) {
    const d = Number(cfg.delayMs);
    if (!Number.isFinite(d) || d < 0) throw new Error('delayMs 必须为非负数字');
    return true;
  },
  async execute(ctx) {
    const ms = Number(ctx.config.delayMs);
    const jitter = Number(ctx.config.jitterMs) || 0;
    await cancellableDelay(ms, ctx.signal, jitter);
    return { output: { delayMs: ms, jitterMs: jitter } };
  }
};

module.exports = action;
