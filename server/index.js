'use strict';

require('dotenv').config();

const path = require('path');
const { Readable } = require('stream');
const express = require('express');

const { McpClient } = require('./mcp-client');
const { buildLuck } = require('./orchestrator');
const { MOODS, MOOD_KEYS } = require('./luck');
const { reverseGeocode } = require('./geo');

const PORT = Number(process.env.PORT) || 3000;
const MCP_TOKEN = process.env.MCP_TOKEN || '';
const MCP_ENDPOINT = process.env.MCP_ENDPOINT || 'https://mcp.mcd.cn';

const app = express();

// 允许跨域：本地用静态预览（file:// 或别的端口）打开 index.html 时，
// 前端会探测并直连本服务，此时需要 CORS 才能拿到 /api/* 与商品图。
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '64kb' }));

// 单页应用 + 持续迭代，禁掉静态文件缓存，
// 避免「我改了代码浏览器还在用旧 JS / 旧 HTML」的诡异现象。
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html') || req.path.endsWith('.js') || req.path.endsWith('.css')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

/* ------------------------------------------------------------------ */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'maimen-daily-fortune',
    version: '1.0.0',
    time: new Date().toISOString(),
    mcp: {
      endpoint: MCP_ENDPOINT,
      tokenConfigured: Boolean(MCP_TOKEN),
    },
  });
});

/** 调试用：返回 MCP Server 真实暴露的工具清单 */
app.get('/api/tools', async (req, res) => {
  if (!MCP_TOKEN) {
    return res.status(503).json({
      ok: false,
      error: '未配置 MCP_TOKEN，请在 .env 中填入你的麦当劳 MCP Token',
    });
  }
  const client = new McpClient({ endpoint: MCP_ENDPOINT, token: MCP_TOKEN });
  try {
    await client.initialize();
    const tools = await client.listTools({ force: true });
    res.json({
      ok: true,
      endpoint: MCP_ENDPOINT,
      count: tools.length,
      tools: tools.map((t) => ({
        name: t.name,
        description: (t.description || '').slice(0, 120),
        required: Object.keys((t.inputSchema && t.inputSchema.required) || (t.inputSchema && t.inputSchema.properties) || {}),
      })),
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

/**
 * 商品图代理：菜单图片都在 mcd.cn 域下，直接 drawImage 会污染 canvas，
 * 导致 toDataURL 抛 SecurityError。走同源代理就能正常导出签图。
 * 限定只允许 mcd.cn 域名，避免变成开放代理。
 */
app.get('/api/img', async (req, res) => {
  const url = String(req.query.url || '');
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return res.status(400).json({ ok: false, error: '非法 url' });
  }
  if (!/(^|\.)mcd\.cn$/.test(host)) {
    return res.status(403).json({ ok: false, error: '只允许代理 mcd.cn 域名的图片' });
  }
  try {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!upstream.ok) return res.status(502).json({ ok: false, error: `上游返回 ${upstream.status}` });
    res.set('Content-Type', upstream.headers.get('content-type') || 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    // fetch 返回的是 Web ReadableStream，要转成 Node 流才能 pipe 给 Express
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get('/api/moods', (req, res) => {
  res.json({
    ok: true,
    moods: MOOD_KEYS.map((k) => ({
      key: k,
      label: MOODS[k].label,
      emoji: MOODS[k].emoji,
      hint: MOODS[k].hint,
    })),
  });
});

/** 经纬度 → 城市 + 地标（前端拿到坐标后调一次，直接填回输入框并展示「已定位·城市」） */
app.get('/api/geo', async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ ok: false, error: '需要 lat 和 lng' });
  }
  try {
    const r = await reverseGeocode(lat, lng);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

/** 核心：求今日麦门签 */
app.post('/api/luck', async (req, res) => {
  const started = Date.now();
  const body = req.body || {};

  const mood = String(body.mood || 'whatever');
  const budget = clampBudget(body.budget);
  const lat = toNum(body.lat);
  const lng = toNum(body.lng);
  const city = typeof body.city === 'string' ? body.city.slice(0, 40) : '';
  const keyword = typeof body.keyword === 'string' ? body.keyword.slice(0, 60) : '';

  if (!MCP_TOKEN) {
    return res.status(503).json({
      ok: false,
      error: '服务端未配置 MCP_TOKEN。复制 .env.example 为 .env 并填入 Token 后重启。',
    });
  }

  try {
    const data = await buildLuck(
      { mood, budget, lat, lng, city, keyword },
      { endpoint: MCP_ENDPOINT, token: MCP_TOKEN }
    );
    res.json({ ok: true, requestMs: Date.now() - started, ...data });
  } catch (e) {
    console.error('[api/luck] 未捕获异常', e);
    res.status(500).json({
      ok: false,
      error: e && e.message ? e.message : '求签失败',
      mood,
      budget,
      warnings: ['后端编排异常，请查看服务端日志'],
    });
  }
});

/* ------------------------------------------------------------------ */

function clampBudget(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 40;
  return Math.min(120, Math.max(15, Math.round(n * 100) / 100));
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log('');
    console.log('  🍔 麦门今日运势   http://localhost:' + PORT);
    console.log(`  MCP  ${MCP_ENDPOINT}  token=${MCP_TOKEN ? '已配置' : '❌ 未配置'}`);
    if (!MCP_TOKEN) console.log('  ⚠️  请复制 .env.example 为 .env 并填入 MCP_TOKEN');
    console.log('');
  });
}

module.exports = app;
