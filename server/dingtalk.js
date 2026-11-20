'use strict';

const crypto = require('crypto');
const store = require('./store');

/**
 * 钉钉群机器人推送
 * 文案格式：[姓名]抽中[奖品]  —— 即 “张三抽中AirPods”
 * 支持加签（secret）模式；若机器人使用「自定义关键词」安全设置，
 * 请把关键词设为「抽中」，本系统的文案天然包含该关键词。
 */

function signedUrl(webhook, secret) {
  if (!secret) return webhook;
  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = crypto.createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64');
  const sep = webhook.includes('?') ? '&' : '?';
  return `${webhook}${sep}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
}

async function sendText(content, opts = {}) {
  const db = store.get();
  const webhook = opts.webhook || db.config.webhook;
  const secret = opts.secret !== undefined ? opts.secret : db.config.secret;

  if (!webhook) return { ok: false, message: '未配置钉钉 webhook' };

  const body = {
    msgtype: 'text',
    text: { content },
    at: { isAtAll: !!db.config.atAll, atMobiles: [] },
  };

  const url = signedUrl(webhook, secret);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=utf-8' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    const ok = res.ok && Number(data.errcode) === 0;
    return {
      ok,
      message: ok ? 'ok' : `errcode=${data.errcode} ${data.errmsg || res.statusText}`,
      raw: data,
    };
  } catch (err) {
    const msg = err.name === 'AbortError' ? '请求超时（8s）' : err.message;
    return { ok: false, message: msg };
  } finally {
    clearTimeout(timer);
  }
}

async function test() {
  return sendText('抽奖系统连接测试：抽中测试奖品');
}

module.exports = { sendText, test };
