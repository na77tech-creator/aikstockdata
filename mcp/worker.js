/**
 * worker.js — 한국주식데이터 무인증 원격 MCP 서버 (Cloudflare Worker 단일 파일)
 *
 * - 프로토콜: MCP Streamable HTTP (stateless). POST /mcp 에 JSON-RPC 2.0.
 *   initialize / notifications/* (202) / tools/list / tools/call / ping 지원.
 *   GET /mcp → 405(JSON 에러 본문). GET / → 사람용 안내 HTML. Mcp-Session-Id 는 무시(무상태).
 * - 원천: https://aikstockdata.com/data/public/* (공공데이터 가공물 — DART 공시·금융위 T+1 시세·
 *   기계 랭킹). 100% 공개/재배포 합법(공공데이터법). KIS 원시 데이터 미사용(2026-07-23 공공 전환).
 *   인메모리 10분 캐시(+원천 실패 시 스테일 재사용).
 * - 빌드 도구 없음: 이 파일 하나가 배포 단위(deploy_mcp.py 가 그대로 PUT).
 * - 준법: 모든 도구 응답에 기준일 + 출처 URL + "투자 권유가 아닌 정보 제공입니다" 1줄 포함.
 *
 * 배포: mcp/DEPLOY_MCP.bat 더블클릭 (실행은 사용자 몫 — 자동 실행 금지)
 * 로컬 테스트: node --check worker.js && node test_local.mjs
 */

const ORIGIN = "https://aikstockdata.com";
const UA = "aikstockdata-mcp/2.0 (+https://aikstockdata.com/ai.html)";
const CACHE_TTL_MS = 10 * 60 * 1000; // 10분

const SERVER_INFO = {
  name: "aikstockdata-mcp",
  title: "한국주식데이터 (aikstockdata.com)",
  version: "2.0.0",
};
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_VERSION = "2025-06-18";
const INSTRUCTIONS =
  "Korean stock data from aikstockdata.com (한국주식데이터): DART disclosures in easy language, " +
  "Financial Services Commission (금융위) T+1 confirmed closing prices, and machine-computed rankings " +
  "for KOSPI/KOSDAQ. Refreshed every trading day at 18:10 KST. No auth, no API key — 100% public, " +
  "open-government data (freely redistributable). All data is a dated snapshot, not real-time — always " +
  "read the '기준일' (as-of date) in every tool response. A value of null means 'not provided' and is " +
  "different from 0. Rankings are mechanical calculations from public financials, not stock picks. " +
  "This server provides information only; it is not investment advice.";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

// ── 인메모리 캐시 (모듈 스코프 = isolate 수명 동안 유지 — 무상태 서버에 충분) ──
const _cache = new Map(); // path -> { ts, data }

async function fetchJson(path) {
  const hit = _cache.get(path);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;
  let res;
  try {
    res = await fetch(ORIGIN + path, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
  } catch (e) {
    if (hit) return hit.data; // 스테일이라도 있으면 크래시 대신 재사용
    throw new Error("origin unreachable: " + (e && e.message));
  }
  if (!res.ok) {
    if (hit) return hit.data;
    throw new Error("origin HTTP " + res.status);
  }
  const data = await res.json();
  _cache.set(path, { ts: Date.now(), data });
  return data;
}

// ── 포맷 헬퍼 ─────────────────────────────────────────────────────────────
const fmt = (n) => (n == null ? "미제공" : Number(n).toLocaleString("en-US"));
const pct = (v) => (v == null ? "미제공" : `${v > 0 ? "+" : ""}${v}%`);
// v 는 '억원' 단위 값. 원(KRW) 값은 호출부가 /1e8 로 변환해 넘긴다.
const mcFmt = (v) => {
  if (v == null) return "미제공";
  const eok = `${fmt(v)}억원`;
  if (v >= 10000) {
    const jo = (v / 10000).toLocaleString("en-US", { maximumFractionDigits: 1 });
    return `${eok}(약 ${jo}조원)`;
  }
  return eok;
};
const eok = (won) => (won == null ? "미제공" : mcFmt(Math.round(won / 1e8)));

function footer(basisDate, srcPath) {
  return `\n---\n기준일 ${basisDate || "미기록"} | 출처 ${ORIGIN}${srcPath} | 투자 권유가 아닌 정보 제공입니다.`;
}

function userError(message) {
  const e = new Error(message);
  e.isUserError = true;
  return e;
}

const ORIGIN_FAIL_TEXT =
  "죄송합니다 — 데이터 원천(aikstockdata.com)에 일시적으로 접속하지 못했습니다. " +
  "잠시 후 다시 시도해 주세요. 데이터는 매 거래일 저녁 18:10(KST)에 갱신되는 정적 파일이라 " +
  "보통 곧 복구됩니다. 원천 직접 확인: " + ORIGIN + "/data/public/quotes.json";

// ── 도구 6개 (전부 공개 데이터 /data/public/*) ──────────────────────────────
const TOOLS = [
  {
    name: "get_today",
    title: "오늘의 시장 요약 (Today's market digest)",
    description:
      "One-shot daily digest of the Korean market: up/down breadth & tone, top-3 disclosures, growth " +
      "top-3, recent earnings, and aggregate stats (disclosure-type counts, earnings-improvement rate). " +
      "Best for 'how was the market today?'. | 오늘의 시장 다이제스트 — 등락 폭·주요 공시 TOP3·성장 " +
      "랭킹·실적·집계 통계를 한 번에. '오늘 시장 어땠어?'에 딱.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const d = await fetchJson("/data/public/today.json");
      const basis = d["as_of"] || "";
      const b = d["market_breadth"] || {};
      const out = [];
      out.push("오늘의 한국 증시 요약 (한국주식데이터 · 금융위 T+1 확정 종가)");
      out.push(`- 기준일: ${basis} · 스냅샷(실시간 아님)`);
      if (b["up"] != null) {
        out.push(`- 시장 분위기: ${b["tone"] || "-"} (상승 ${fmt(b["up"])}·하락 ${fmt(b["down"])}·보합 ${fmt(b["flat"])}종목, 상승 비율 ${b["up_ratio_pct"]}%)`);
      }
      const hl = d["highs_lows_52w"] || {};
      out.push(`- 52주 신고가 ${fmt(hl["n_high"])}·신저가 ${fmt(hl["n_low"])} · 실측 흑자전환 ${fmt(d["earnings_turnaround_n"])}종목`);
      const td = d["top_disclosures"] || [];
      if (td.length) {
        out.push("");
        out.push("[주요 공시 TOP3]");
        td.forEach((e, i) => out.push(`${i + 1}. ${e["name"]} — ${e["label"]}${e["fact"] ? ` (${e["fact"]})` : ""}`));
      }
      const g = d["growth_top3"] || [];
      if (g.length) {
        out.push("");
        out.push("[성장 랭킹 TOP3 (공개 산식 · 추천 아님)]");
        g.forEach((s, i) => out.push(`${i + 1}. ${s["name"]} (점수 ${s["score"]}/100, 영업이익 전년비 ${s["status"] || pct(s["operating_income_yoy_pct"])})`));
      }
      if (d["earnings_improve_rate_pct"] != null) {
        out.push("");
        out.push(`[실적] 최근 발표 ${fmt(d["earnings_reported_n"])}개 중 전년 대비 개선 ${d["earnings_improve_rate_pct"]}%`);
      }
      out.push("");
      out.push(`상세는 get_stock(code)·get_rankings, 전체 데이터는 ${ORIGIN}/data/public/today.json`);
      return out.join("\n") + footer(basis, "/data/public/today.json");
    },
  },
  {
    name: "search_stock",
    title: "종목 검색 (Search stocks)",
    description:
      "Search Korean stocks (KOSPI/KOSDAQ) by name or 6-digit ticker with partial match. " +
      "Returns up to 10 matches sorted by market cap: code, name, market, market cap. | " +
      "종목명·종목코드 부분일치 검색 — 시가총액순 상위 10개(코드·이름·시장·시총).",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Stock name or code fragment, e.g. '삼성' or '005930'. | 종목명 또는 6자리 코드의 일부",
        },
      },
      required: ["query"],
    },
    run: async (args) => {
      const q = String(args.query ?? "").trim();
      if (!q) throw userError("query 인자가 필요합니다. 예: {\"query\": \"삼성\"}");
      const idx = await fetchJson("/data/public/search_index.json");
      const items = idx["items"] || [];
      const ql = q.toLowerCase();
      let hits = items.filter(
        (s) =>
          String(s.n ?? "").toLowerCase().includes(ql) ||
          String(s.c ?? "").includes(q)
      );
      const basis = idx["as_of"] || "";
      if (hits.length === 0) {
        return (
          `'${q}'와 일치하는 종목이 없습니다. 현재 데이터셋은 KOSPI·KOSDAQ ${fmt(idx["count"])}종목입니다.\n` +
          `종목명 일부(예: '삼성')나 6자리 코드(예: '005930')로 다시 시도해 보세요.` +
          footer(basis, "/data/public/search_index.json")
        );
      }
      // 시가총액순 정렬·표기 (quotes.json 에서 시총 조회 — 실패해도 진행)
      const mcap = {};
      try {
        const qd = await fetchJson("/data/public/quotes.json");
        for (const s of qd["items"] || []) mcap[String(s["종목코드"])] = s["mrktTotAmt"];
      } catch (e) {
        /* 시총 없이도 진행 */
      }
      hits.sort((a, b) => (mcap[b.c] || 0) - (mcap[a.c] || 0));
      hits = hits.slice(0, 10);
      const lines = hits.map(
        (s, i) => `${i + 1}. ${s.n} (${s.c}) | ${s.m} | 시총 ${eok(mcap[s.c])}`
      );
      return (
        `'${q}' 검색 결과 상위 ${hits.length}건 (시가총액순):\n` +
        lines.join("\n") +
        `\n\n상세는 get_stock(code)로, 전체 목록은 ${ORIGIN}/data/public/search_index.json 을 쓰세요.` +
        footer(basis, "/data/public/search_index.json")
      );
    },
  },
  {
    name: "get_stock",
    title: "종목 상세 (Stock detail)",
    description:
      "Get one Korean stock by 6-digit code: T+1 confirmed close & change, market cap, latest " +
      "quarterly financials (revenue / operating income / net income with YoY), and ranking signals. | " +
      "6자리 코드로 단일 종목의 확정 종가·시총·최근 분기 실적(매출·영업이익·순이익 전년비)·랭킹 신호를 조회합니다.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "6-digit ticker code, e.g. '005930' (삼성전자). | 6자리 종목코드",
        },
      },
      required: ["code"],
    },
    run: async (args) => {
      const code = String(args.code ?? "").trim();
      if (!/^\d{6}$/.test(code)) {
        throw userError(
          "code는 6자리 숫자 종목코드여야 합니다. 예: {\"code\": \"005930\"}. " +
          "코드를 모르면 search_stock으로 먼저 검색하세요."
        );
      }
      let s;
      try {
        s = await fetchJson(`/data/public/s/${code}.json`);
      } catch (e) {
        return (
          `코드 ${code} 종목의 공개 데이터가 없습니다(유니버스 밖이거나 제외 종목일 수 있음).\n` +
          `종목명으로 search_stock을 먼저 시도하거나 제외 목록을 확인하세요: ${ORIGIN}/data/public/excluded.json`
        );
      }
      const basis = s["as_of"] || "";
      const qt = s["quote"] || {};
      const out = [];
      out.push(`${s["name_ko"]} (${s["code"]}) — ${s["market"] || ""}`);
      out.push(`기준일: ${basis} · 스냅샷(실시간 아님) · 출처: 공공데이터(금융위 T+1·DART)`);
      out.push("");
      out.push("[시세 · 금융위 T+1 확정 종가]");
      out.push(`- 종가: ${fmt(qt["close"])}원 (${pct(qt["change_pct"])})`);
      out.push(`- 시가총액: ${eok(qt["market_cap_krw"])}`);
      out.push(`- 거래량: ${fmt(qt["volume"])}주 · 상장주식수: ${fmt(qt["shares_outstanding"])}주`);
      const f = s["financials"];
      if (f && (f["revenue"] || f["operating_income"])) {
        const seg = (o) => {
          if (!o || o["current"] == null) return "미제공";
          const yoy = o["yoy_pct"] == null ? "" : ` (${pct(o["yoy_pct"])})`;
          return eok(o["current"]) + yoy;
        };
        out.push("");
        out.push(`[실적 · DART ${f["period_ko"] || f["period"] || ""} (${f["basis"] || ""})]`);
        out.push(`- 매출액: ${seg(f["revenue"])}`);
        out.push(`- 영업이익: ${seg(f["operating_income"])}`);
        out.push(`- 순이익: ${seg(f["net_income"])}`);
      }
      const sig = s["signals"] || {};
      const sigLines = [];
      if (sig["growth_top8"]) sigLines.push(`성장 TOP8 (점수 ${sig["growth_score"]}/100)`);
      if (sig["quiet_top"]) sigLines.push(`조용한 실적주 (점수 ${sig["quiet_score"]}/100)`);
      if (sigLines.length) {
        out.push("");
        out.push(`[랭킹 신호] ${sigLines.join(" · ")} — 공개 산식의 기계 산정이며 추천이 아닙니다.`);
      }
      const rd = s["recent_disclosures"] || [];
      if (rd.length) {
        out.push("");
        out.push(`[최근 공시 ${rd.length}건] 쉬운 말 풀이: ${ORIGIN}/s/${code}.html`);
      }
      out.push("");
      out.push(`전체 상세 JSON: ${ORIGIN}/data/public/s/${code}.json · DART 원문: ${s["dart_url"] || ORIGIN}`);
      return out.join("\n") + footer(basis, `/data/public/s/${code}.json`);
    },
  },
  {
    name: "get_rankings",
    title: "랭킹 조회 (Rankings)",
    description:
      "Machine-computed rankings from public DART financials. kind='growth' = 성장 TOP8 (measured " +
      "revenue/operating-profit growth); kind='quiet' = 조용한 실적주 (good results but low trading " +
      "interest). Mechanical, not stock picks. | 공개 재무 기반 기계 랭킹 — growth=성장 TOP8, " +
      "quiet=조용한 실적주. 추천 아님.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["growth", "quiet"],
          description: "'growth' (성장 TOP8) or 'quiet' (조용한 실적주)",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Number of rows, 1-20 (default 8). | 반환 개수",
        },
      },
      required: ["kind"],
    },
    run: async (args) => {
      const kind = String(args.kind ?? "");
      if (kind !== "growth" && kind !== "quiet") {
        throw userError("kind는 'growth' 또는 'quiet'여야 합니다.");
      }
      let limit = Number.isFinite(Number(args.limit)) ? Math.floor(Number(args.limit)) : 8;
      limit = Math.max(1, Math.min(20, limit));
      const d = await fetchJson("/data/public/rankings.json");
      const basis = d["price_basDt"] || "";
      if (kind === "growth") {
        const rows = (d["growth_top8"] || []).slice(0, limit);
        if (!rows.length) {
          return "성장 랭킹 데이터가 비어 있습니다." + footer(basis, "/data/public/rankings.json");
        }
        const lines = rows.map((s, i) => {
          const yoy = s["상태"] ? s["상태"] : pct(s["영업이익YoY%"]);
          const opm = s["OPM%"] == null ? "미제공" : s["OPM%"] + "%";
          return `${i + 1}. ${s["name"]} (${s["code"]}) | 점수 ${s["score"]}/100 | 영업이익 전년비 ${yoy} | 매출 전년비 ${pct(s["매출YoY%"])} | 영업이익률 ${opm}`;
        });
        return (
          `실측 성장 TOP${rows.length} (DART 재무 기반 100점 만점 기계 산정 · 추천 아님):\n` +
          lines.join("\n") +
          footer(basis, "/data/public/rankings.json")
        );
      }
      const rows = (d["quiet_top"] || []).slice(0, limit);
      if (!rows.length) {
        return "조용한 실적주 데이터가 비어 있습니다." + footer(basis, "/data/public/rankings.json");
      }
      const lines = rows.map((s, i) => {
        const yoy = s["상태"] ? s["상태"] : pct(s["영업이익YoY%"]);
        return `${i + 1}. ${s["name"]} (${s["code"]}) | 점수 ${s["quiet"]}/100 | 영업이익 전년비 ${yoy} | 매출 전년비 ${pct(s["매출YoY%"])}`;
      });
      return (
        `조용한 실적주 TOP${rows.length} (실적 대비 거래 관심 낮은 종목 · 공개 산식 · 추천 아님):\n` +
        lines.join("\n") +
        footer(basis, "/data/public/rankings.json")
      );
    },
  },
  {
    name: "get_market_summary",
    title: "시장 요약 (Market summary)",
    description:
      "Snapshot summary of the Korean market from T+1 data: up/down breadth, 52-week high/low counts, " +
      "and earnings-turnaround count (prior-year loss → current profit, from DART). | " +
      "시장 요약 — 상승/하락 폭(breadth), 52주 신고가·신저가 수, 실측 흑자전환 종목 수.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const d = await fetchJson("/data/public/rankings.json");
      const basis = d["price_basDt"] || "";
      const br = d["breadth"] || {};
      const hi = d["hi52"] || {};
      const out = [];
      out.push("한국 주식시장 요약 (aikstockdata.com · 금융위 T+1 확정 종가)");
      out.push(`- 기준일: ${basis} · 스냅샷(실시간 아님)`);
      if (br["up"] != null) {
        const ratio = br["ratio"] != null ? Math.round(br["ratio"] * 100) : "?";
        out.push(
          `- 등락 폭(breadth): 상승 ${fmt(br["up"])} · 하락 ${fmt(br["down"])} · 보합 ${fmt(br["flat"])}종목 (상승 비율 ${ratio}%)`
        );
      }
      out.push(`- 52주 신고가 ${fmt(hi["n_high"])}종목 · 신저가 ${fmt(hi["n_low"])}종목`);
      out.push(`- 실측 흑자전환(전년 동기 적자→당기 흑자, DART): ${fmt(d["turnaround_n"])}종목`);
      out.push("");
      out.push("성장 랭킹은 get_rankings(kind='growth'), 종목 상세는 get_stock(code)로 조회하세요.");
      return out.join("\n") + footer(basis, "/data/public/rankings.json");
    },
  },
  {
    name: "get_data_urls",
    title: "공개 데이터 URL (Open data URLs)",
    description:
      "Get direct URLs for all public datasets (JSON/CSV) — no signup, no API key. Returns the endpoint " +
      "catalog: quotes, disclosures, rankings, per-stock JSON, search index. | " +
      "전체 공개 데이터(JSON·CSV) 직링크 카탈로그 — 무가입·무키.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const idx = await fetchJson("/data/public/index.json");
      const basis = idx["as_of"] || idx["quote_basis_date"] || "";
      const eps = idx["endpoints"] || [];
      const out = [];
      out.push("한국주식데이터 공개 엔드포인트 (무가입·무키 · 공공데이터 가공물):");
      for (const e of eps) {
        const u = e["url"] || e["url_pattern"] || e["example"] || "";
        out.push(`- ${e["name"]}: ${u}${e["format"] ? ` (${e["format"]})` : ""}`);
      }
      out.push("");
      out.push(`종목 하나만 필요하면 ${ORIGIN}/data/public/s/종목코드6.json (예: /s/005930.json)`);
      out.push(`AI 활용 안내·인용 정책: ${ORIGIN}/ai.html · ${ORIGIN}/llms.txt`);
      return out.join("\n") + footer(basis, "/data/public/index.json");
    },
  },
];

// ── JSON-RPC 2.0 처리 ─────────────────────────────────────────────────────
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message, data) => ({
  jsonrpc: "2.0",
  id: id === undefined ? null : id,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

function doInitialize(params) {
  const requested = params.protocolVersion;
  const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : LATEST_VERSION;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  };
}

async function doToolCall(id, params) {
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
  const args = params.arguments || {};
  try {
    const text = await tool.run(args);
    return rpcResult(id, { content: [{ type: "text", text }], isError: false });
  } catch (e) {
    const text = e && e.isUserError ? e.message : ORIGIN_FAIL_TEXT;
    return rpcResult(id, { content: [{ type: "text", text }], isError: true });
  }
}

async function handleMessage(m) {
  if (!m || typeof m !== "object" || m.jsonrpc !== "2.0" || typeof m.method !== "string") {
    return rpcError(m && m.id !== undefined ? m.id : null, -32600, "Invalid Request: expected a JSON-RPC 2.0 message");
  }
  if (m.method.startsWith("notifications/")) return null; // 알림 — 응답 없음(202)
  if (m.id === undefined) return null; // id 없는 요청도 알림으로 취급
  const id = m.id;
  try {
    switch (m.method) {
      case "initialize":
        return rpcResult(id, doInitialize(m.params || {}));
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      case "tools/call":
        return await doToolCall(id, m.params || {});
      default:
        return rpcError(id, -32601, `Method not found: ${m.method}`);
    }
  } catch (e) {
    return rpcError(id, -32603, "Internal error", String((e && e.message) || e));
  }
}

function jsonResponse(payload, status = 200, extra = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

async function handleMcpPost(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(rpcError(null, -32700, "Parse error: body is not valid JSON"), 400);
  }
  if (Array.isArray(body) && body.length === 0) {
    return jsonResponse(rpcError(null, -32600, "Invalid Request: empty batch"), 400);
  }
  const msgs = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const m of msgs) {
    const r = await handleMessage(m);
    if (r) responses.push(r);
  }
  if (responses.length === 0) {
    // 알림만 있는 요청 — MCP Streamable HTTP 규격: 202 Accepted, 본문 없음
    return new Response(null, { status: 202, headers: CORS_HEADERS });
  }
  return jsonResponse(Array.isArray(body) ? responses : responses[0], 200);
}

// ── 사람용 안내 페이지 (GET /) ─────────────────────────────────────────────
async function landingPage(url) {
  let basis = "";
  try {
    const idx = await fetchJson("/data/public/index.json");
    basis = idx["as_of"] || idx["quote_basis_date"] || "";
  } catch {
    /* 원천 실패해도 안내 페이지는 뜬다 */
  }
  const ep = `${url.origin}/mcp`;
  const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>한국주식데이터 MCP 서버 — aikstockdata.com</title>
<style>
  body{font-family:'Malgun Gothic',Apple SD Gothic Neo,sans-serif;max-width:760px;margin:0 auto;
       padding:24px 16px;line-height:1.65;color:#1c2733;background:#f7f9fb}
  h1{font-size:1.35rem;border-bottom:2px solid #23425f;padding-bottom:8px}
  h2{font-size:1.05rem;margin-top:28px;color:#23425f}
  code,pre{background:#eef2f6;border-radius:4px;padding:2px 6px;font-size:.9em;word-break:break-all}
  pre{padding:10px 12px;overflow-x:auto}
  table{border-collapse:collapse;width:100%;font-size:.9rem}
  th,td{border:1px solid #cfd8e0;padding:6px 8px;text-align:left;vertical-align:top}
  th{background:#e8eef4}
  .disc{margin-top:32px;padding:12px;background:#fff7e6;border:1px solid #e0c98f;border-radius:6px;font-size:.85rem}
  a{color:#1a5fa8}
  footer{margin-top:24px;font-size:.8rem;color:#5a6b7a}
</style>
</head>
<body>
<h1>한국주식데이터 MCP 서버</h1>
<p><a href="https://aikstockdata.com">aikstockdata.com</a>의 공개 데이터(KOSPI·KOSDAQ 공시(DART)·확정 종가(금융위 T+1)·기계 랭킹,
매 거래일 저녁 6시 10분 KST 갱신)를 AI가 도구로 쓸 수 있게 하는 <strong>무인증·무료 MCP 서버</strong>입니다.
회원가입·API 키가 필요 없고, 100% 공공데이터 가공물입니다.${basis ? ` 현재 데이터 기준일: <strong>${basis}</strong>.` : ""}</p>

<h2>연결 방법</h2>
<p>MCP 엔드포인트: <code>${ep}</code></p>
<ul>
  <li><strong>claude.ai</strong>: 설정 → 커넥터 → "커스텀 커넥터 추가" → 위 URL 붙여넣기 (인증 없음)</li>
  <li><strong>Claude Desktop</strong>: 설정 → 커넥터 → 커스텀 커넥터 추가 → 위 URL 붙여넣기</li>
  <li><strong>ChatGPT</strong>: 설정 → 커넥터 → 개발자 모드 활성화 후 커넥터 추가 → 위 URL 붙여넣기</li>
</ul>
<p>프로토콜: MCP Streamable HTTP(무상태). <code>POST ${ep}</code> 에 JSON-RPC 2.0 메시지를 보냅니다.
브라우저에서 <code>GET /mcp</code>는 405가 정상입니다.</p>

<h2>제공 도구 (6개)</h2>
<table>
  <tr><th>도구</th><th>설명</th></tr>
  <tr><td><code>get_today</code></td><td>오늘의 시장 요약 — 등락 폭·주요 공시 TOP3·성장 랭킹·실적·집계 통계 ("오늘 시장 어땠어?")</td></tr>
  <tr><td><code>search_stock</code></td><td>종목명·코드 부분일치 검색 — 시총순 상위 10 (코드·이름·시장·시총)</td></tr>
  <tr><td><code>get_stock</code></td><td>단일 종목 — 확정 종가·시총·최근 분기 실적(전년비)·랭킹 신호</td></tr>
  <tr><td><code>get_rankings</code></td><td>성장 TOP8 / 조용한 실적주 (공개 재무 기반 기계 랭킹 · 추천 아님)</td></tr>
  <tr><td><code>get_market_summary</code></td><td>등락 폭·52주 신고저 수·흑자전환 수</td></tr>
  <tr><td><code>get_data_urls</code></td><td>전체 공개 데이터(JSON·CSV) 직링크 카탈로그(무가입·무키)</td></tr>
</table>

<h2>데이터 원천</h2>
<p>모든 응답은 <a href="https://aikstockdata.com/data/public/quotes.json">quotes.json</a> ·
<a href="https://aikstockdata.com/data/public/disclosures.json">disclosures.json</a> ·
<a href="https://aikstockdata.com/data/public/rankings.json">rankings.json</a> ·
<a href="https://aikstockdata.com/data/public/search_index.json">search_index.json</a> 등
공개 정적 파일(공공데이터 가공물)의 무상태 프록시입니다(10분 캐시).
필드 정의·단위·결측 규칙은 <a href="https://aikstockdata.com/ai.html">AI 활용 안내</a>와
<a href="https://aikstockdata.com/llms.txt">llms.txt</a>를 참조하세요.</p>

<div class="disc"><strong>면책</strong> — 이 서버와 모든 도구 응답은 정보 제공 목적이며 투자 권유가 아닙니다.
데이터는 기준일 시점의 스냅샷(실시간 아님)이고, 랭킹은 공개 산식의 기계 산정이며, 투자 판단과 책임은 이용자 본인에게 있습니다.</div>

<footer>운영: <a href="https://aikstockdata.com">aikstockdata.com</a> — 한국주식데이터 · 서버 버전 ${SERVER_INFO.version}</footer>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", ...CORS_HEADERS },
  });
}

// ── 엔트리포인트 ──────────────────────────────────────────────────────────
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      if (request.method === "POST") return handleMcpPost(request);
      // GET /mcp (또는 DELETE 등) — 무상태 서버: 스트림·세션 미지원
      return jsonResponse(
        rpcError(null, -32000, "Method Not Allowed: send a JSON-RPC 2.0 POST to /mcp (stateless server; GET stream and sessions are not supported)"),
        405,
        { Allow: "POST, OPTIONS" }
      );
    }
    if (request.method === "GET" && url.pathname === "/health") {
      // [2026-07-30 리뷰] 상태 점검 — 서버 버전 + 원천 신선도(index.json 경유, 캐시 재사용)
      let basis = null;
      try {
        const idx = await fetchJson("/data/public/index.json");
        basis = idx["quote_basis_date"] || idx["as_of"] || null;
      } catch (e) { /* 원천 실패해도 health 는 응답 */ }
      return jsonResponse({
        status: "ok", protocol: "MCP (JSON-RPC 2.0, stateless)",
        server: SERVER_INFO.name, version: SERVER_INFO.version,
        tools: TOOLS.map((t) => t.name),
        data_quote_as_of: basis,
        origin: ORIGIN, endpoint: url.origin + "/mcp",
      });
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return landingPage(url);
    }
    return jsonResponse(
      { error: "not found", hint: "MCP endpoint: POST /mcp — human guide: GET /" },
      404
    );
  },
};
