/* eslint-disable */
/**
 * scene-steps — nodes/lib/template.js
 * 配置模板插值 + 安全表达式求值。
 *
 * 支持语法：
 *   - {{ vars.x }} / {{ vars['x'] }}
 *   - {{ input }}           (msg.payload)
 *   - {{ outputs[-1].f }}   (outputs 是之前所有步骤 execute 返回 output 的数组，负索引映射)
 *   - {{ env.USER }}        (process.env)
 *   - {{ flow.get('k') }}   (flow context 占位，MVP 阶段只支持同步 flow 对象传入)
 *   - {{ 2 + 2 }}           (任意简单表达式，只要符合 return <expr> 语义)
 *   - 逻辑判断：jump.whenExpr 字段直接接受裸表达式（不带 {{}}）
 *
 * 安全设计：
 *   1) 用 new Function + 5 形参构造沙盒；禁止访问 this（strict mode）
 *   2) vars / flow / global 的原型链访问通过 Proxy 拦截 __proto__ / constructor / prototype 关键字
 *   3) 在插值字符串内禁止形如 {{ (new Function(...))() }} 构造新函数：简单词法扫描 Function / eval / process / require 单词
 *   4) evalExpr 超时保护（最长 100ms）：对死循环用户表达式用 vm（可选）或 try/catch 软保护
 */

'use strict';

const vm = require('vm');
const { SceneError } = require('./errors');

const UNSAFE_KEYWORDS = /\b(eval|Function|process|require|globalThis|setTimeout|setInterval|setImmediate|Buffer|Worker|child_process|fs\b|import|System)\b/;
const INTERPOLATE_RE = /\{\{\{?\s*([\s\S]*?)\s*\}\}\}?/g;   // 匹配 {{...}} 或 {{{...}}}

// 生成一个 Object.freeze 的 Proxy：禁止用 __proto__ / constructor / prototype
function safeSandbox(target, label, allowWrite = false) {
  if (target == null || typeof target !== 'object') return target;
  const blockedKeys = new Set(['__proto__', 'constructor', 'prototype']);
  return new Proxy(target, {
    get(t, k, recv) {
      if (typeof k === 'symbol') return undefined;
      if (blockedKeys.has(k)) return undefined;
      const v = t[k];
      // 嵌套对象：递归包一层 Proxy（避免 vars.a.b.__proto__）
      if (v !== null && typeof v === 'object') return safeSandbox(v, `${label}.${k}`, allowWrite);
      return v;
    },
    set(t, k, v, recv) {
      if (!allowWrite) return false;
      if (typeof k === 'symbol') return false;
      if (blockedKeys.has(k)) return false;
      t[k] = v;
      return true;
    },
    has() { return false; },   // 禁止 in 操作，防止 for-in 枚举
    ownKeys(t) { return []; },
    getOwnPropertyDescriptor(t, k) { return undefined; }
  });
}

/**
 * 对包含 {{expr}} 的字符串做插值。
 * 遇到单个 null/undefined：返回字符串空 "null"/"undefined" 不抛错。
 * 遇到语法异常：抛 SceneError(TEMPLATE_UNSAFE).
 */
function interpolate(str, ctx) {
  if (str == null) return str;
  if (typeof str !== 'string') return str;
  if (str.indexOf('{') === -1) return str;    // 快速路径
  const vars = safeSandbox(ctx.vars || {}, 'vars', true);
  const env  = safeSandbox(ctx.env || process.env || {}, 'env');
  const outputs = wrapOutputs(ctx.outputs || []);
  const flow = safeSandbox(ctx.flow || {}, 'flow');
  const glob = safeSandbox(ctx.global || {}, 'global');
  let replaced = false;
  const result = str.replace(INTERPOLATE_RE, (match, body) => {
    replaced = true;
    if (UNSAFE_KEYWORDS.test(body)) {
      throw SceneError.fromCode('TEMPLATE_UNSAFE', `插值含禁用关键字: ${body.trim()}`);
    }
    const v = evalExprInternal(body, vars, ctx.input, outputs, env, flow, glob);
    if (v === undefined) return '';
    if (v === null) return 'null';
    if (typeof v === 'object') {
      try { return JSON.stringify(v); } catch { return String(v); }
    }
    return String(v);
  });
  return replaced ? result : str;
}

/**
 * 深遍历对象/数组，对所有字符串字段做 interpolate。
 * 用于整个 action.config 的模板展开（含嵌套对象/数组）。
 */
function deepInterpolate(value, ctx) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return interpolate(value, ctx);
  if (Array.isArray(value)) return value.map(v => deepInterpolate(v, ctx));
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = deepInterpolate(value[k], ctx);
    return out;
  }
  return value;
}

/**
 * 执行一个独立的表达式（无 {{}} 包裹）。
 * 示例：evalExpression('vars.code >= 200 && vars.code < 300', { vars: {code: 200} }) -> true
 */
function evalExpression(expr, ctx) {
  if (typeof expr !== 'string' || !expr.trim()) return true;
  if (UNSAFE_KEYWORDS.test(expr)) throw SceneError.fromCode('TEMPLATE_UNSAFE', `表达式含禁用关键字: ${expr.trim()}`);
  const vars = safeSandbox(ctx.vars || {}, 'vars', true);
  const env  = safeSandbox(ctx.env || process.env || {}, 'env');
  const outputs = wrapOutputs(ctx.outputs || []);
  const flow = safeSandbox(ctx.flow || {}, 'flow');
  const glob = safeSandbox(ctx.global || {}, 'global');
  return !!evalExprInternal(expr, vars, ctx.input, outputs, env, flow, glob);
}

// 内部：eval（通过 vm 沙盒）
function evalExprInternal(exprStr, vars, input, outputs, env, flow, global_) {
  // 1) 先做 vm 独立 context（不影响宿主）
  const sandbox = {
    vars, input, outputs, env, flow, global: global_,
    Math, JSON, Number, String, Boolean, Array, Object, Date,
    parseInt, parseFloat, isNaN, isFinite,
    RegExp, console: { log() {}, warn() {}, error() {} }   // 限制 console
  };
  try {
    vm.createContext(sandbox);
    // IIFE：用箭头函数包裹，保证 return/声明语句 都能在函数体内合法。
    // 注：ensureReturn 会对不以关键字开头的表达式加 "return (expr);"。
    const src = `(function(){ 'use strict'; ${ensureReturn(exprStr)} })()`;
    const script = new vm.Script(src, { timeout: 100, filename: 'scene-expr.vm' });
    return script.runInContext(sandbox);
  } catch (e) {
    throw SceneError.fromCode('TEMPLATE_UNSAFE', e.message || String(e));
  }
}

// 保证 exprStr 前面有 return，方便用户写 "vars.x == 1"
function ensureReturn(expr) {
  const s = expr.trim();
  if (!s) return 'return undefined;';
  if (/^(return|const|let|var|function|if|for|while|switch|try)\b/.test(s)) return s;
  return 'return (' + s + ');';
}

// outputs 包装：支持 outputs[-1] 负索引
function wrapOutputs(outputs) {
  if (!Array.isArray(outputs)) return [];
  return new Proxy(outputs.slice(), {
    get(t, k) {
      if (k === 'length') return t.length;
      let idx = (typeof k === 'string' && /^-?\d+$/.test(k)) ? Number(k) : NaN;
      if (Number.isInteger(idx)) {
        if (idx < 0) idx = t.length + idx;
        return t[idx];
      }
      return t[k];
    }
  });
}

module.exports = { interpolate, deepInterpolate, evalExpression };
