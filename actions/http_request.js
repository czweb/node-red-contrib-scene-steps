/**
 * actions/http_request.js
 *  原生 http/https 模块 HTTP 请求。仅用 Node.js 自带。
 */
'use strict';

const http = require('http');
const https = require('https');
const url = require('url');
const { URL } = require('url');
const { SceneError } = require('../nodes/lib/errors');

function applyHeadersHeadersCaseInsensitive(headers, name, value) {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) { headers[k] = value; return; }
  }
  headers[name] = value;
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

module.exports = {
  type: 'http_request',
  category: 'network',
  icon: 'fa-globe',
  label: 'HTTP 请求',
  configSchema: {
    url: { type: 'string', template: true, required: true, label: 'URL' },
    method: { type: 'string', enum: ['GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS'], default: 'GET', label: '方法' },
    headers: { type: 'object', default: {}, template: true, label: '请求头 (JSON)' },
    body: { type: 'string', template: true, default: '', label: '请求体', format: 'textarea' },
    bodyJson: { type: 'boolean', default: false, label: '请求体自动 JSON 化（设置 Content-Type: application/json）' },
    bodyEncode: { type: 'string', enum: ['utf8','hex','base64'], default: 'utf8', label: '请求体编码' },
    timeoutMs: { type: 'number', min: 50, default: 15000, label: '超时(ms)' },
    followRedirect: { type: 'boolean', default: false, label: '跟随重定向 3xx' },
    redirectLimit: { type: 'number', min: 0, default: 5, label: '重定向次数上限' },
    responseParse: { type: 'string', enum: ['utf8','json','hex','base64','buffer'], default: 'utf8', label: '响应解析' }
  },
  defaults: { url: '', method: 'GET', headers: {}, body: '', bodyJson: false, bodyEncode: 'utf8', timeoutMs: 15000, followRedirect: false, redirectLimit: 5, responseParse: 'utf8' },
  validate(config) {
    if (!config.url) throw SceneError.fromCode('BAD_CONFIG', 'http_request: url 不能为空');
    try { new URL(String(config.url)); } catch (e) { throw SceneError.fromCode('BAD_CONFIG', 'http_request: url 格式错误: ' + config.url); }
  },
  async execute(ctx) {
    const c = ctx.config;
    const signal = ctx.signal;
    async function doFetch(reqUrl, remainRedirect) {
      const u = new URL(String(reqUrl));
      const driver = u.protocol === 'https:' ? https : http;
      const headers = Object.assign({}, (c.headers && typeof c.headers === 'object') ? c.headers : {});
      applyHeadersCaseInsensitive(headers, 'User-Agent', headers['User-Agent'] || 'scene-steps/1.0 (+Node-RED)');

      let bodyBuf = null;
      const method = String(c.method || 'GET').toUpperCase();
      if (c.body != null && c.body !== '' && ['POST','PUT','PATCH'].includes(method)) {
        const body = c.body;
        if (c.bodyEncode === 'hex') {
          const s = String(body).replace(/[\s,;:]/g, '');
          if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw SceneError.fromCode('BAD_CONFIG', 'HTTP body hex 非法');
          bodyBuf = Buffer.from(s, 'hex');
        } else if (c.bodyEncode === 'base64') {
          bodyBuf = Buffer.from(String(body), 'base64');
        } else if (c.bodyJson) {
          try {
            const obj = (typeof body === 'string' && (body.startsWith('{') || body.startsWith('['))) ? JSON.parse(body) : body;
            bodyBuf = Buffer.from(JSON.stringify(obj), 'utf8');
            applyHeadersCaseInsensitive(headers, 'Content-Type', 'application/json; charset=utf-8');
          } catch (e) {
            throw SceneError.fromCode('BAD_CONFIG', 'HTTP bodyJSON 解析失败: ' + e.message);
          }
        } else {
          bodyBuf = Buffer.from(String(body), 'utf8');
        }
        applyHeadersCaseInsensitive(headers, 'Content-Length', String(bodyBuf.length));
      }

      const opts = {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers,
        timeout: Number(c.timeoutMs) || 15000
      };

      return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        let req;
        try {
          req = driver.request(opts, (res) => {
            // 3xx redirect
            if (c.followRedirect && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && remainRedirect > 0) {
              // 读掉 res，确保没有未读 data 事件挂住
              res.resume();
              const next = new URL(res.headers.location, reqUrl).toString();
              doFetch(next, remainRedirect - 1).then(resolve, reject);
              return;
            }
            readAll(res).then(buf => {
              if (settled) return;
              settled = true; clearTimeout(timer);
              let data;
              const parseMode = String(c.responseParse || 'utf8');
              switch (parseMode) {
                case 'json':
                  try { data = buf.length ? JSON.parse(buf.toString('utf8')) : null; } catch (e) { data = buf.toString('utf8'); }
                  break;
                case 'hex': data = buf.toString('hex').toUpperCase(); break;
                case 'base64': data = buf.toString('base64'); break;
                case 'buffer': data = buf; break;
                case 'utf8':
                default: data = buf.toString('utf8');
              }
              resolve({ statusCode: res.statusCode, statusMessage: res.statusMessage, headers: res.headers, body: data, bodyLen: buf.length });
            }).catch(err => {
              if (settled) return;
              settled = true; clearTimeout(timer); reject(err);
            });
          });
          req.once('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
          req.once('timeout', () => {
            if (settled) return;
            settled = true; clearTimeout(timer);
            try { req.destroy(new Error('HTTP timeout')); } catch (e2) {}
            reject(Object.assign(new Error(`HTTP timeout ${c.timeoutMs}ms`), { code: 'HTTP_TIMEOUT' }));
          });
          if (signal && typeof signal.once === 'function') {
            signal.once('abort', function onAbort() {
              if (settled) return;
              settled = true; clearTimeout(timer);
              try { req.destroy(); } catch (e) {}
              reject(SceneError.fromCode('CANCELLED'));
            });
          }
          timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { req.destroy(Object.assign(new Error('HTTP timeout'), { code: 'HTTP_TIMEOUT' })); } catch (e) {}
          }, Math.max(10, Number(c.timeoutMs) || 15000));
          if (bodyBuf) req.write(bodyBuf);
          req.end();
        } catch (e) {
          if (!settled) { settled = true; clearTimeout(timer); reject(e); }
        }
      });
    }

    const r = await doFetch(c.url, Math.max(0, Number(c.redirectLimit) || 5));
    return { output: r };
  }
};
