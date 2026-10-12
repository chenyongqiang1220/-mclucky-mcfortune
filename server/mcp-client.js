'use strict';

/**
 * 麦当劳 MCP Streamable HTTP 客户端（零依赖，仅用 Node 内置 fetch）
 *
 * 协议要点：
 *   - POST {endpoint}  JSON-RPC 2.0
 *   - 请求头 Authorization: Bearer <MCP_TOKEN>
 *   - Accept 同时声明 application/json 与 text/event-stream
 *     （服务端可能回 JSON，也可能回 SSE 流，必须两种都能解析）
 *   - initialize 响应头里的 Mcp-Session-Id 要回带给后续请求
 */

const DEFAULT_ENDPOINT = 'https://mcp.mcd.cn';
const PROTOCOL_VERSION = '2025-06-18';

class McpError extends Error {
  constructor(message, { code, data } = {}) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.data = data;
  }
}

/** 把 SSE 文本流解析成若干 JSON-RPC 消息 */
function parseSse(text) {
  const out = [];
  let buffer = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith('event:') || line.startsWith('id:') || line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      buffer += line.slice(5).trim();
      continue;
    }
    if (line === '' && buffer !== '') {
      try {
        out.push(JSON.parse(buffer));
      } catch {
        /* 忽略半包 */
      }
      buffer = '';
    }
  }
  if (buffer !== '') {
    try {
      out.push(JSON.parse(buffer));
    } catch {
      /* ignore */
    }
  }
  return out;
}

class McpClient {
  constructor({ endpoint, token, fetchImpl, timeoutMs = 20000 } = {}) {
    this.endpoint = endpoint || DEFAULT_ENDPOINT;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.sessionId = null;
    this._id = 0;
    this._toolsCache = null;
  }

  get configured() {
    return Boolean(this.token);
  }

  _headers(extra = {}) {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...extra,
    };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  async _post(payload, { expectResponse = true } = {}) {
    if (!this.fetchImpl) throw new McpError('当前 Node 版本不支持内置 fetch，请升级到 Node 18+');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const reason = err && err.name === 'AbortError' ? `请求超时(${this.timeoutMs}ms)` : err.message;
      throw new McpError(`无法连接 MCP Server ${this.endpoint}：${reason}`);
    }
    clearTimeout(timer);

    const sid = res.headers.get('mcp-session-id') || res.headers.get('Mcp-Session-Id');
    if (sid) this.sessionId = sid;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new McpError(`MCP 返回 HTTP ${res.status}：${body.slice(0, 300)}`);
    }

    if (!expectResponse) return null;

    const text = await res.text();
    if (!text || !text.trim()) return null;

    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (ctype.includes('text/event-stream')) {
      const msgs = parseSse(text);
      if (!msgs.length) throw new McpError('MCP 返回了空的 SSE 流');
      return msgs[msgs.length - 1];
    }

    try {
      return JSON.parse(text);
    } catch {
      const msgs = parseSse(text);
      if (msgs.length) return msgs[msgs.length - 1];
      throw new McpError(`MCP 返回了无法解析的内容：${text.slice(0, 200)}`);
    }
  }

  async initialize() {
    const res = await this._post({
      jsonrpc: '2.0',
      id: ++this._id,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'maimen-daily-fortune', version: '1.0.0' },
      },
    });
    if (res && res.error) throw new McpError(res.error.message || 'initialize 失败', res.error);
    // 通知服务端初始化完成（不要求响应体）
    try {
      await this._post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { expectResponse: false });
    } catch {
      /* 通知失败不影响后续调用 */
    }
    return res && res.result ? res.result : res;
  }

  async listTools({ force = false } = {}) {
    if (this._toolsCache && !force) return this._toolsCache;
    const res = await this._post({
      jsonrpc: '2.0',
      id: ++this._id,
      method: 'tools/list',
      params: {},
    });
    if (res && res.error) throw new McpError(res.error.message || 'tools/list 失败', res.error);
    const tools = (res && res.result && res.result.tools) || [];
    this._toolsCache = tools;
    return tools;
  }

  async callTool(name, args = {}) {
    const res = await this._post({
      jsonrpc: '2.0',
      id: ++this._id,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    if (res && res.error) {
      throw new McpError(res.error.message || `tools/call ${name} 失败`, res.error);
    }
    const result = (res && res.result) || {};

    // MCP content 约定：{ content: [{ type:'text', text:'...' }] }
    const content = result.content || [];
    const structured = result.structuredContent;
    let text = '';
    for (const c of content) {
      if (c && c.type === 'text' && typeof c.text === 'string') text += c.text;
    }

    // 麦当劳 MCP 习惯把结构化数据放进 text 里的 JSON，先尝试解析
    let data = null;
    if (structured && typeof structured === 'object') {
      data = normalize(structured);
    }
    if (data == null && text) {
      data = extractJson(text);
    }

    return {
      raw: result,
      text,
      data,
      isError: Boolean(result.isError),
    };
  }
}

/** 从混杂的文本里抠出 JSON 对象（麦当劳 MCP 常在正文前后加展示说明） */
function extractJson(text) {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1].trim() : trimmed;

  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };

  // 1) 整段就是单个 JSON
  const whole = tryParse(candidate);
  if (whole !== undefined) return normalize(whole);

  // 2) 文本里嵌了多个 JSON，取第一个含 success/code/data 特征的
  const re = /\{[\s\S]*?\}(?=\s*(?:\{|[^\s])|$)/g;
  let m;
  const pool = [];
  while ((m = re.exec(candidate)) !== null) pool.push(m[0]);

  // 优先挑最长的可解析片段（麦当劳返回体常带 markdown 表格说明，JSON 是最后一大坨）
  pool.sort((a, b) => b.length - a.length);
  for (const frag of pool) {
    const v = tryParse(frag);
    if (v !== undefined) return normalize(v);
  }
  return null;
}

/** 统一剥掉 { success, code, message, data } 信封，直接返回 data */
function normalize(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if ('success' in obj && 'data' in obj) return obj.data;
  return obj;
}

/** 带超时的安全调用：失败返回 { ok:false, error }，绝不抛出 */
async function safeCall(client, name, args, { label } = {}) {
  try {
    const res = await client.callTool(name, args);
    if (res.isError) {
      return { ok: false, error: (res.text || `${name} 调用失败`).slice(0, 200) };
    }
    return { ok: true, data: res.data, text: res.text };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = { McpClient, McpError, safeCall, extractJson, parseSse };
