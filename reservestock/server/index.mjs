#!/usr/bin/env node
// リザスト API を Claude Code から操作するための MCP サーバー（stdio・依存パッケージなし）
// Node.js 18 以上（組み込み fetch）で動く。
//
// 環境変数:
//   RESERVESTOCK_API_KEY   … 管理画面「API設定」で発行した API実行キー（必須）
//   RESERVESTOCK_BASE_URL  … 既定 https://www.reservestock.jp/（検証環境に向けるときだけ変更）

import readline from 'node:readline';

const SERVER_NAME = 'reservestock';
const SERVER_VERSION = '0.1.0';
const DEFAULT_PROTOCOL = '2025-06-18';

const BASE_URL = normalizeBaseUrl(process.env.RESERVESTOCK_BASE_URL || 'https://www.reservestock.jp/');
const API_KEY = cleanKey(process.env.RESERVESTOCK_API_KEY);

const MIN_INTERVAL_MS = 1100;           // API は同一キーで1秒以上空ける決まり
const MAX_RESPONSE_CHARS = 60000;       // 1回の応答で AI に渡す上限
const REFERENCE_TTL_MS = 60 * 60 * 1000;
const REFERENCE_MAX_CHARS = 30000;
const ACTION_RE = /^[a-z0-9_]+(\/[a-z0-9_]+)?$/;

function normalizeBaseUrl(url) {
  let u = String(url).trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.endsWith('/') ? u : u + '/';
}

function cleanKey(v) {
  const s = (v || '').trim();
  // 設定されずに展開されなかった変数（${...}）は未設定とみなす
  if (!s || /^\$\{.*\}$/.test(s)) return '';
  return s;
}

// ---------------------------------------------------------------- HTTP

let lastCallAt = 0;
async function waitInterval() {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

function appendQuery(url, params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) sp.append(`${k}[]`, String(item));
    } else if (typeof v === 'object') {
      sp.append(k, JSON.stringify(v));
    } else {
      sp.append(k, String(v));
    }
  }
  const q = sp.toString();
  return q ? `${url}?${q}` : url;
}

async function callApi(method, action, params) {
  if (!API_KEY) {
    return {
      isError: true,
      text: 'API実行キーが設定されていません。リザスト管理画面の「API設定」(https://www.reservestock.jp/api_config) でキーを発行し、プラグインの設定（api_key）または環境変数 RESERVESTOCK_API_KEY に入れてから Claude Code を再起動してください。',
    };
  }
  action = String(action || '').trim().replace(/^\/+/, '').replace(/^api\//, '');
  if (!ACTION_RE.test(action)) {
    return { isError: true, text: `action の形式が正しくありません: ${JSON.stringify(action)}（例: mail_magazines, private_reservations/availability）` };
  }

  let url = `${BASE_URL}api/${action}`;
  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    Accept: 'application/json',
    'User-Agent': `reservestock-claude-code-plugin/${SERVER_VERSION}`,
  };
  const init = { method, headers };
  if (method === 'GET') {
    url = appendQuery(url, params);
  } else {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    init.body = JSON.stringify(params || {});
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    await waitInterval();
    let res;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(120000) });
    } catch (e) {
      return { isError: true, text: `通信に失敗しました: ${e.message}` };
    }
    const body = await res.text();
    if (res.status === 429 && attempt === 0) {
      let retry = 2;
      try { retry = Math.min(30, Math.max(1, Number(JSON.parse(body).retry_after) || 2)); } catch (_) {}
      await new Promise((r) => setTimeout(r, retry * 1000));
      continue;
    }
    return formatResponse(method, action, res, body);
  }
}

function formatResponse(method, action, res, body) {
  const ctype = res.headers.get('content-type') || '';
  let text;
  if (ctype.includes('json')) {
    try { text = JSON.stringify(JSON.parse(body), null, 1); } catch (_) { text = body; }
  } else if (ctype.includes('html')) {
    // WAF などの HTML 応答は本文が長いので要点だけ
    const plain = body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    text = `(HTML応答) ${plain.slice(0, 1000)}`;
  } else {
    text = body;
  }
  let note = '';
  if (text.length > MAX_RESPONSE_CHARS) {
    note = `\n…（応答が長いため ${MAX_RESPONSE_CHARS} 文字で切りました。全体 ${text.length} 文字。絞り込みやページ指定のパラメータを使ってください）`;
    text = text.slice(0, MAX_RESPONSE_CHARS);
  }
  const head = `${method} /api/${action} → HTTP ${res.status}`;
  let hint = '';
  if (res.status === 202) hint = '\n※ 202 は事業者本人の確認待ちです。リザスト管理画面で確認してください。';
  if (res.status === 403 && method === 'POST') hint = '\n※ 403 はキーの利用権限不足のことが多いです（参照専用キーでは書き込み不可）。管理画面「API設定」でキーの利用権限を確認してください。';
  return { isError: res.status >= 400, text: `${head}\n${text}${note}${hint}` };
}

// ---------------------------------------------------------------- リファレンス

let referenceCache = { at: 0, text: '', sections: [] };

async function loadReference() {
  if (referenceCache.text && Date.now() - referenceCache.at < REFERENCE_TTL_MS) return referenceCache;
  const res = await fetch(`${BASE_URL}api_config/api_reference_for_ai?format=md`, {
    headers: { 'User-Agent': `reservestock-claude-code-plugin/${SERVER_VERSION}` },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`APIリファレンスを取得できませんでした (HTTP ${res.status})`);
  const text = await res.text();
  referenceCache = { at: Date.now(), text, sections: splitSections(text) };
  return referenceCache;
}

// 「## 大見出し」配下の「### 小見出し」単位に分ける
function splitSections(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let h2 = '';
  let cur = null;
  let inFence = false;
  const flush = () => { if (cur) { cur.body = cur.lines.join('\n').trim(); delete cur.lines; sections.push(cur); } };
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    if (!inFence) {
      const m2 = line.match(/^## (.+)/);
      const m3 = line.match(/^### (.+)/);
      if (m2) { flush(); h2 = m2[1].trim(); cur = { h2, title: h2, lines: [line] }; continue; }
      if (m3) { flush(); cur = { h2, title: m3[1].trim(), lines: [line] }; continue; }
    }
    if (!cur) cur = { h2: '', title: '(冒頭)', lines: [] };
    cur.lines.push(line);
  }
  flush();
  return sections;
}

function scoreSection(sec, terms) {
  const title = `${sec.h2} ${sec.title}`.toLowerCase();
  const body = sec.body.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (title.includes(t)) score += 10;
    else if (body.includes(t)) score += 1 + Math.min(4, body.split(t).length - 2);
    else return 0; // すべての語を含むものだけ
  }
  return score;
}

async function searchReference(query, maxSections) {
  const ref = await loadReference();
  const q = String(query || '').trim();
  if (!q) {
    // 目次
    const toc = [];
    let lastH2 = null;
    for (const s of ref.sections) {
      if (s.h2 !== lastH2) { toc.push(`\n## ${s.h2 || '(冒頭)'}`); lastH2 = s.h2; }
      if (s.title !== s.h2) toc.push(`- ${s.title}`);
    }
    return truncate(`APIリファレンス目次（query に見出しやAPI名・キーワードを入れると本文を返します）\n${toc.join('\n')}`, REFERENCE_MAX_CHARS);
  }
  const terms = q.toLowerCase().split(/[\s　]+/).filter(Boolean);
  const hits = ref.sections
    .map((s) => ({ s, score: scoreSection(s, terms) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(10, maxSections || 4)));
  if (hits.length === 0) {
    return `「${q}」に一致する節はありませんでした。語を減らすか、query を空にして目次を確認してください。`;
  }
  const out = hits.map(({ s }) => `<!-- ${s.h2} -->\n${s.body}`).join('\n\n---\n\n');
  return truncate(out, REFERENCE_MAX_CHARS);
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + `\n…（${n} 文字で切りました。語を増やして絞り込んでください）` : s;
}

// ---------------------------------------------------------------- MCP

const paramsSchema = {
  type: 'object',
  description: 'API に渡すパラメータ（キーと値）。正規パラメータ名（customer_id, event_id など）はリファレンスで確認する。api_key は入れない。',
  additionalProperties: true,
};

const TOOLS = [
  {
    name: 'reference',
    title: 'リザストAPIリファレンス検索',
    description: 'リザストAPIのリファレンス（AIエージェント用）を検索する。API を呼ぶ前に必ずこれで正しい action 名・GET/POST・必須パラメータを確認すること。query を空にすると目次を返す。複数語はAND検索。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '探したいAPI名・機能・見出しの語（例: "メルマガ記事 下書き", "create_mail_magazine_article", "個別予約 空き"）。空なら目次。' },
        max_sections: { type: 'integer', minimum: 1, maximum: 10, description: '返す節の最大数（既定4）' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'api_get',
    title: 'リザストAPI 参照（GET）',
    description: 'リザストAPIをGETで呼ぶ（データの取得・検索。リザスト上のデータは変わらない）。action は /api/ 以降の名前（例: mail_magazines, customers, profile, private_reservations/availability）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '/api/ 以降のAPI名' },
        params: paramsSchema,
      },
      required: ['action'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'api_post',
    title: 'リザストAPI 変更・実行（POST）',
    description: 'リザストAPIをPOSTで呼ぶ（作成・更新・削除・配信・送信などリザスト上のデータや顧客に影響する操作）。メール配信・顧客へのメール送信・削除・入金確認・返金など取り消せない操作は、実行前に内容（対象・件数・本文）をユーザーに示して明示の了承を得ること。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '/api/ 以降のAPI名（例: create_mail_magazine_article, update_event_lp）' },
        params: paramsSchema,
      },
      required: ['action'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handleToolCall(name, args) {
  args = args || {};
  try {
    if (name === 'reference') {
      const text = await searchReference(args.query, args.max_sections);
      return { content: [{ type: 'text', text }] };
    }
    if (name === 'api_get' || name === 'api_post') {
      let params = args.params;
      if (typeof params === 'string') {
        try { params = JSON.parse(params); } catch (_) { return toolError('params は JSON オブジェクトで渡してください'); }
      }
      if (params && typeof params === 'object') {
        delete params.api_key;
      }
      const r = await callApi(name === 'api_get' ? 'GET' : 'POST', args.action, params || {});
      return { content: [{ type: 'text', text: r.text }], isError: !!r.isError };
    }
    return toolError(`不明なツール: ${name}`);
  } catch (e) {
    return toolError(e.message || String(e));
  }
}

function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: 'リザスト（予約・メルマガ・顧客管理サービス）をAPIで操作する。まず reference で該当APIの仕様を確認し、参照は api_get、変更は api_post を使う。取り消せない操作（配信・送信・削除・入金確認・返金）は実行前にユーザーの了承を得る。',
      });
    case 'ping':
      return isRequest && reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call':
      return reply(id, await handleToolCall(params && params.name, params && params.arguments));
    default:
      if (isRequest) replyError(id, -32601, `Method not found: ${method}`);
  }
}

// API は1秒間隔の決まりがあるので、要求は1件ずつ順に処理する
let queue = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return replyError(null, -32700, 'Parse error'); }
  queue = queue.then(() => handle(msg)).catch((e) => {
    if (msg && msg.id !== undefined) replyError(msg.id, -32603, e.message || String(e));
  });
});
// 入力が閉じても処理中の応答は返し切ってから終わる
rl.on('close', () => { queue.finally(() => process.exit(0)); });
