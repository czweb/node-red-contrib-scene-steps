/* eslint-disable */
/**
 * scene-steps — nodes/lib/registry.js
 * 动作注册表：所有动作 require 后在这里 register，供 executor 按 type 获取。
 * 使用方式：
 *   const registry = require('./registry');
 *   registry.register(action);   // action = { type, category, icon, label, configSchema, defaults, validate(), async execute(ctx) }
 *   const delay = registry.get('delay');
 *   delay.execute(ctx);
 */

'use strict';

const { SceneError } = require('./errors');

const ACTIONS = new Map();        // type -> action
const CATEGORY_LABEL = {
  timing:   '时序流控',
  flow:     '流程控制',
  network:  '网络通讯',
  data:     '数据处理',
  system:   '系统扩展'
};

function validateActionShape(a) {
  if (!a || typeof a !== 'object') throw new TypeError('action must be object');
  if (typeof a.type !== 'string' || !a.type) throw new TypeError('action.type must be non-empty string');
  if (typeof a.execute !== 'function') throw new TypeError(`action(${a.type}).execute must be function`);
  if (a.validate && typeof a.validate !== 'function') throw new TypeError(`action(${a.type}).validate must be function`);
  if (!a.category) a.category = 'flow';
  if (!a.configSchema || typeof a.configSchema !== 'object') a.configSchema = { type: 'object', properties: {} };
  if (!a.defaults || typeof a.defaults !== 'object') a.defaults = {};
  if (!a.label) a.label = a.type;
  if (!a.icon) a.icon = 'fa-cog';
  return a;
}

function register(action) {
  const a = validateActionShape(action);
  if (ACTIONS.has(a.type)) throw new SceneError(`Action type "${a.type}" already registered`, { code: 'CONFIG_INVALID', recoverable: false });
  ACTIONS.set(a.type, a);
  return a;
}

function get(type) {
  const a = ACTIONS.get(type);
  if (!a) throw SceneError.fromCode('CONFIG_INVALID', `Unknown action type: ${type}`);
  return a;
}

function has(type) { return ACTIONS.has(type); }

function listMeta() {
  const result = [];
  for (const a of ACTIONS.values()) {
    result.push({
      type: a.type,
      category: a.category,
      categoryLabel: CATEGORY_LABEL[a.category] || a.category,
      icon: a.icon,
      label: a.label,
      configSchema: a.configSchema,
      defaults: JSON.parse(JSON.stringify(a.defaults))
    });
  }
  return result;
}

function listTypes() { return Array.from(ACTIONS.keys()); }

function clear() { ACTIONS.clear(); }   // 仅测试用

module.exports = { register, get, has, listMeta, listTypes, clear, CATEGORY_LABEL };
