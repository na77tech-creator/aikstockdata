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
// [2026-08-10] ai.html → ai. 사이트가 확장자 없는 정본으로 바뀌어 .html 은 307 이다.
// 우리가 남의 로그에 찍는 주소가 리다이렉트를 타게 두지 않는다.
const UA = "aikstockdata-mcp/2.1 (+https://aikstockdata.com/ai)";
const CACHE_TTL_MS = 10 * 60 * 1000; // 10분

const SERVER_INFO = {
  name: "aikstockdata-mcp",
  title: "한국주식데이터 (aikstockdata.com)",
  // 2.1.0 — 도구 6개 → 10개(list_stocks·get_earnings·get_history·get_disclosure_impact).
  // 도구가 늘면 여기를 올린다. 레지스트리·공개 저장소의 server.json 과 반드시 같은 값이어야 한다.
  version: "2.1.0",
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
  "This server provides information only; it is not investment advice. " +
  "IMPORTANT — the tool list is NOT the extent of the data. Preliminary quarterly earnings "
  + "(filed ~2 weeks before the regular report), 250 trading days of daily prices per stock, "
  + "post-filing price paths by filing type, and an intraday (15:00 KST) disclosure list with "
  + "receipt timestamps are all available. Call get_data_urls() before concluding that "
  + "something is unavailable. | ★도구 목록이 데이터의 전부가 아닙니다. 잠정실적·1년 일별 "
  + "시계열·공시 유형별 이후 주가·장중 공시(접수 시각)가 모두 있습니다. '없다'고 결론내기 "
  + "전에 get_data_urls() 를 부르세요.";

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

// ★[2026-08-10 실사용자 신고] 도구 6개만 보고 "이 서비스는 잠정실적·시계열이 없다"고
// 결론내린 AI 가 있었다. 데이터는 둘 다 이미 있었다(earnings.json · s/{code}_history.json).
// **AI 는 도구 목록을 능력의 경계로 읽는다.** 목록에 없으면 없는 것으로 취급한다.
// 그래서 모든 응답 꼬리에 "여기 말고 더 있다"를 한 줄 고정으로 붙인다.
const MORE_LINE =
  "데이터 20종 전체 카탈로그: get_data_urls() — 잠정실적(earnings)·1년 일별 시계열·" +
  "공시 이후 주가(disclosure_impact)·장중 공시(접수 시각)도 있습니다. 조건으로 목록을 뽑으려면 list_stocks().";

function footer(basisDate, srcPath) {
  return `\n---\n기준일 ${basisDate || "미기록"} | 출처 ${ORIGIN}${srcPath} | 투자 권유가 아닌 정보 제공입니다.` +
         `\n${MORE_LINE}`;
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
  // ★[2026-08-10 실사용자 신고] 아래 셋은 **데이터가 이미 있는데 도구가 없어서**
  // 아무도 못 쓰던 것들이다. 한 사용자가 잠정실적을 못 찾아 "이 서비스는 못 본다"고
  // 자기 문서에 박제했고, 250일 시계열이 있는 줄 몰라 pykrx 를 따로 설치했다.
  {
    name: "get_earnings",
    title: "잠정·정기 실적 (Quarterly earnings, incl. preliminary)",
    description:
      "Quarterly earnings from DART, INCLUDING preliminary (잠정) results filed ~2 weeks before the " +
      "regular report. Pass a code for one stock's history, or omit it for the largest caps. " +
      "get_stock returns the REGULAR report only — use this for the newest numbers. | " +
      "DART 분기 실적 — 정기보고서보다 2주 빠른 잠정실적 포함. code 를 주면 그 종목 이력, " +
      "생략하면 시총 상위. get_stock 은 정기보고서만 주므로 최신 수치는 이 도구로 보세요.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "6-digit ticker, optional | 6자리 종목코드(선택)" },
        limit: { type: "number", description: "max rows, default 15 | 최대 건수(기본 15)" },
      },
    },
    run: async (args) => {
      const code = String(args.code ?? "").trim();
      const limit = Math.max(1, Math.min(60, Number(args.limit) || 15));
      const d = await fetchJson("/data/public/earnings_recent60.json");
      let items = d["items"] || [];
      let src = "/data/public/earnings_recent60.json";
      if (code) {
        if (!/^\d{6}$/.test(code)) throw userError("code 는 6자리 숫자여야 합니다. 예: 005930");
        const all = await fetchJson("/data/public/earnings.json");
        src = "/data/public/earnings.json";
        items = (all["items"] || []).filter((x) => String(x["code"]) === code);
        if (!items.length) {
          return "코드 " + code + " 의 실적 공시가 최근 120일 롤링에 없습니다.\n" +
            "전체 원장: " + ORIGIN + "/data/public/earnings.json" + footer(d["as_of"], src);
        }
      }
      const out = [code ? items[0]["name"] + " (" + code + ") 실적 공시" : "실적 공시 — 시총 상위 + 최근 접수"];
      out.push("");
      for (const x of items.slice(0, limit)) {
        // ★수치가 없는 이유는 셋이고 서로 전혀 다르다(2026-08-10 원문 5건 대조).
        //   withdrawn  회계 항등식을 어겨 우리가 뺐다 — 우리가 잘한 것
        //   no_values  공시 자체에 수치가 없다(판매대수 공시 등) — DART 내용
        //   failed     우리가 못 뽑았다 — 우리 결함
        // 하나로 뭉뚱그려 "파싱 실패"라고 쓰면 멀쩡한 판단이 결함으로 읽힌다.
        // 전체 원장에는 parse_status 가 없으므로 value_status 로 판정한다.
        const fin0 = x["fin"] || {};
        const hasNum = ["매출액", "영업이익", "순이익"].some(
          (k) => (fin0[k] || {})["당기"] != null);
        const vs = String(x["value_status"] || "");
        const st = x["parse_status"] || (
          (x["fact"] || hasNum) ? "ok"
            : vs === "withdrawn_inconsistent" ? "withdrawn"
            : vs === "no_values_in_filing" ? "no_values" : "failed");
        const WHY = {
          withdrawn: "⚠ 수치를 뽑았으나 회계 항등식을 어겨(예: 순이익>매출액) 발행에서 뺐습니다 — 원문 확인: ",
          no_values: "ℹ 이 공시에는 재무 수치가 없습니다(판매대수만 담은 잠정공시 등) — 원문: ",
          failed: "⚠ 수치를 뽑지 못했습니다(저희 결함) — 원문 확인: ",
        };
        // label 에 이미 "(연결)"이 들어 있는 경우가 있다 — 두 번 붙이지 않는다
        const lab = String(x["label"] || "");
        const bas = String(x["basis"] || "");
        out.push("- " + x["rcept_dt"] + " " + (x["name"] || "") + " · " + lab +
          (bas && lab.indexOf(bas) < 0 ? "(" + bas + ")" : ""));
        out.push("  " + (st === "ok"
          ? (x["fact"] || "수치 미제공")
          : WHY[st] + (x["url"] || "")));
      }
      out.push("");
      out.push("잠정치는 확정치가 아닙니다. 확정은 다음 정기보고서에서 확인하세요.");
      out.push("전체 원장(120일 롤링): " + ORIGIN + "/data/public/earnings.json");
      return out.join("\n") + footer(d["as_of"], src);
    },
  },
  {
    name: "get_history",
    title: "종목 일별 시세 1년 (Daily price history)",
    description:
      "Up to 250 trading days of daily close & volume for one stock, plus computed 52-week high/low, " +
      "drawdown from the high, and volume vs 60-day average. | 한 종목의 250거래일 일별 종가·거래량과 " +
      "52주 고저·고점 대비 낙폭·60일 평균 거래량 대비 배수를 함께 계산해 줍니다.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "6-digit ticker | 6자리 종목코드" },
        days: { type: "number", description: "recent N days to list, default 20 | 나열할 최근 일수(기본 20)" },
      },
      required: ["code"],
    },
    run: async (args) => {
      const code = String(args.code ?? "").trim();
      if (!/^\d{6}$/.test(code)) throw userError("code 는 6자리 숫자여야 합니다. 예: 005930");
      const days = Math.max(1, Math.min(60, Number(args.days) || 20));
      let h;
      try {
        h = await fetchJson("/data/public/s/" + code + "_history.json");
      } catch (e) {
        return "코드 " + code + " 의 시계열이 없습니다(유니버스 밖일 수 있음).\n종목 목록: " + ORIGIN + "/stocks";
      }
      const rows = h["rows"] || h["items"] || [];
      if (!rows.length) return "코드 " + code + " 시계열이 비어 있습니다.";
      const cl = (r) => (Array.isArray(r) ? r[1] : r["close"]);
      const vl = (r) => (Array.isArray(r) ? r[2] : r["volume"]);
      const dt = (r) => (Array.isArray(r) ? r[0] : r["date"]);
      const px = rows.map(cl).filter((v) => v != null);
      const vol = rows.map(vl).filter((v) => v != null);
      const hi = Math.max.apply(null, px);
      const lo = Math.min.apply(null, px);
      const last = px[px.length - 1];
      const v60 = vol.slice(-60);
      const avg60 = v60.length ? v60.reduce((a, b) => a + b, 0) / v60.length : null;
      const lastVol = vol[vol.length - 1];
      const out = [(h["name_ko"] || code) + " (" + code + ") 일별 시세 — " + rows.length + "거래일"];
      out.push("");
      out.push("- 최근 종가: " + fmt(last) + "원 (" + dt(rows[rows.length - 1]) + ")");
      out.push("- 기간 내 최고/최저: " + fmt(hi) + " / " + fmt(lo) + "원");
      out.push("- 최고가 대비: " + ((last / hi - 1) * 100).toFixed(1) + "%");
      if (avg60) out.push("- 최근 거래량 / 60일 평균: " + (lastVol / avg60).toFixed(2) + "배");
      out.push("");
      out.push("[최근 " + days + "거래일]");
      for (const r of rows.slice(-days).reverse()) {
        out.push("  " + dt(r) + "  " + fmt(cl(r)) + "원  " + fmt(vl(r)) + "주");
      }
      out.push("");
      out.push("전 영업일 확정 종가이며 수정주가가 아닙니다 — 권리락·병합 구간은 계열이 끊깁니다.");
      return out.join("\n") + footer(h["as_of"] || "", "/data/public/s/" + code + "_history.json");
    },
  },
  {
    name: "get_disclosure_impact",
    title: "공시 유형별 이후 주가 (Post-filing price path)",
    description:
      "For each filing type, the median MARKET-ADJUSTED return at +1/+5/+20 trading days after the " +
      "filing, with 95% intervals. A record of what happened — not a forecast, not a recommendation. " +
      "Not available from other free Korean sources. | 공시 유형별로 접수 이후 1·5·20거래일 뒤까지 " +
      "시장 등락을 뺀 수익률 중앙값과 95% 구간. 과거 기록이며 예측·추천이 아닙니다.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "filing type in Korean, e.g. 배당 결정 | 공시 유형(선택)" },
      },
    },
    run: async (args) => {
      const want = String(args.label ?? "").trim();
      const d = await fetchJson("/data/public/disclosure_impact_summary.json");
      const all = d["summary"] || [];
      const rows = all.filter((r) => !want || String(r["label"]).indexOf(want) >= 0);
      if (!rows.length) {
        return "'" + want + "' 유형이 없습니다.\n가능한 유형: " +
          all.map((r) => r["label"]).join(" · ");
      }
      const HZ = { h1: "+1거래일", h5: "+5거래일", h20: "+20거래일" };
      const out = ["공시 유형별 이후 주가 경로 — 시장조정 수익률 중앙값"];
      out.push("과거 사실의 사후 집계입니다. 인과도, 예측도, 추천도 아닙니다.");
      out.push("");
      for (const r of rows) {
        out.push("[" + r["label"] + "]");
        for (const k of ["h1", "h5", "h20"]) {
          const c = r[k];
          if (!c || !c["enough"]) continue;
          const ci = c["median_ci95"] || [];
          const zero = c["ci_includes_zero"] ? "  ← 0을 포함(0과 구분되지 않음)" : "";
          out.push("  " + HZ[k] + ": " + pct(c["median_excess_pct"]) +
            " (95% " + pct(ci[0]) + "~" + pct(ci[1]) + ", n=" + c["n"] + ")" + zero);
        }
        const rs = r["receipt_sessions"] || {};
        const tot = (rs["pre_open"] || 0) + (rs["intraday"] || 0) + (rs["after_close"] || 0);
        if (tot) {
          out.push("  접수 시각: 장전 " + (rs["pre_open"] || 0) + " · 장중 " + (rs["intraday"] || 0) +
            " · 장후 " + (rs["after_close"] || 0));
        }
      }
      out.push("");
      out.push("접수일 당일(h0)은 접수 시각 탓에 공시 반응으로 식별되지 않아 여기서 뺐습니다.");
      out.push("표 전체: " + ORIGIN + "/disclosure-impact");
      return out.join("\n") + footer(d["as_of"] || "", "/data/public/disclosure_impact_summary.json");
    },
  },
  // ★[2026-08-10 실사용자 신고] "get_market_summary 가 '흑자전환 110종목'이라고 알려주는데
  // 그 110개가 뭔지 볼 방법이 없다. 오늘 스크리닝하다가 여기서 막혔다."
  // 개수만 주고 목록을 안 주면 전 종목을 하나씩 조회하는 수밖에 없다.
  {
    name: "list_stocks",
    title: "조건으로 종목 목록 (Screen stocks by condition)",
    description:
      "Return the LIST of stocks matching a condition — turnaround to profit, 52-week high/low, " +
      "growth or quiet-performer rankings — with optional market-cap range and a cap-to-operating-income " +
      "multiple ceiling. Other tools give counts; this one gives the names. | 조건에 맞는 종목 " +
      "목록을 돌려줍니다 — 흑자전환·52주 신고저·성장/조용한 실적주. 시총 범위와 " +
      "시총÷연환산영업이익 배수 상한도 걸 수 있습니다. 다른 도구가 개수를 준다면 이건 목록을 줍니다.",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description:
            "turnaround(흑자전환) | new_high(52주 신고가) | new_low(52주 신저가) | " +
            "growth(성장 TOP) | quiet(조용한 실적주) | all(전체). 기본 turnaround",
        },
        max_multiple: {
          type: "number",
          description: "시총÷연환산영업이익 상한(예: 10). 영업이익 흑자 종목만 남습니다",
        },
        min_cap_eok: { type: "number", description: "시가총액 하한(억원)" },
        max_cap_eok: { type: "number", description: "시가총액 상한(억원)" },
        sort: {
          type: "string",
          description: "cap(시총 큰 순, 기본) | multiple(배수 낮은 순) | change(등락률 높은 순)",
        },
        limit: { type: "number", description: "최대 건수(기본 20, 최대 100)" },
      },
    },
    run: async (args) => {
      const F = String(args.filter ?? "turnaround").trim().toLowerCase();
      const OK = ["turnaround", "new_high", "new_low", "growth", "quiet", "all"];
      if (OK.indexOf(F) < 0) {
        throw userError("filter 는 다음 중 하나여야 합니다: " + OK.join(" | "));
      }
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
      const maxMul = Number(args.max_multiple) || null;
      const minCap = args.min_cap_eok != null ? Number(args.min_cap_eok) * 1e8 : null;
      const maxCap = args.max_cap_eok != null ? Number(args.max_cap_eok) * 1e8 : null;
      const sort = String(args.sort ?? "cap").trim().toLowerCase();

      let d;
      try {
        d = await fetchJson("/data/public/screen.json");
      } catch (e) {
        return "조건 검색 재료가 아직 발행되지 않았습니다. 전체 시세는 " +
          ORIGIN + "/data/public/quotes.json 을 쓰세요.";
      }
      // rows: [code,name,market,cap,close,pct,value,opAnn,mult,turn,growth,quiet,hi,lo]
      const I = { code: 0, name: 1, mkt: 2, cap: 3, close: 4, pct: 5, val: 6,
                  op: 7, mult: 8, turn: 9, growth: 10, quiet: 11, hi: 12, lo: 13 };
      const PICK = {
        turnaround: (r) => r[I.turn],
        new_high: (r) => r[I.hi],
        new_low: (r) => r[I.lo],
        growth: (r) => r[I.growth],
        quiet: (r) => r[I.quiet],
        all: () => true,
      };
      let rows = (d["rows"] || []).filter(PICK[F]);
      const nMatched = rows.length;
      if (maxMul != null) rows = rows.filter((r) => r[I.mult] != null && r[I.mult] <= maxMul);
      if (minCap != null) rows = rows.filter((r) => (r[I.cap] || 0) >= minCap);
      if (maxCap != null) rows = rows.filter((r) => (r[I.cap] || 0) <= maxCap);
      const nAfter = rows.length;

      const KEY = {
        cap: (r) => -(r[I.cap] || 0),
        multiple: (r) => (r[I.mult] == null ? Infinity : r[I.mult]),
        change: (r) => -(r[I.pct] == null ? -Infinity : r[I.pct]),
      };
      rows = rows.slice().sort((a, b) => (KEY[sort] || KEY.cap)(a) - (KEY[sort] || KEY.cap)(b));

      const NAME_KO = {
        turnaround: "흑자전환(전년 동기 영업적자 → 당기 흑자)",
        new_high: "52주 신고가", new_low: "52주 신저가",
        growth: "성장 TOP", quiet: "조용한 실적주", all: "전체",
      };
      const out = [NAME_KO[F] + " — " + nMatched + "종목"];
      if (nAfter !== nMatched) out.push("추가 조건 적용 후 " + nAfter + "종목");
      if (!nAfter) {
        out.push("");
        out.push("조건에 맞는 종목이 없습니다. 배수·시총 조건을 풀어 보세요.");
        return out.join("\n") + footer(d["as_of"], "/data/public/screen.json");
      }
      out.push("");
      for (const r of rows.slice(0, limit)) {
        const mul = r[I.mult] == null ? "배수 산출불가" : "시총/연환산영업이익 " + r[I.mult] + "배";
        out.push("- " + r[I.name] + " (" + r[I.code] + ") " + (r[I.mkt] || ""));
        out.push("  종가 " + fmt(r[I.close]) + "원 (" + pct(r[I.pct]) + ") · 시총 " +
          eok(r[I.cap]) + " · " + mul);
      }
      if (nAfter > limit) out.push("");
      if (nAfter > limit) out.push("... 외 " + (nAfter - limit) + "종목 (limit 를 올리거나 조건을 좁히세요)");
      out.push("");
      out.push("배수는 시가총액 ÷ 연환산 영업이익입니다(분기 누적을 1년치로 환산). " +
        "PER 이 아니며 영업이익 기준입니다. 영업이익이 0 이하면 산출하지 않습니다.");
      out.push("기계 산정이고 추천이 아닙니다. 원자료: " + ORIGIN + "/data/public/screen.json");
      return out.join("\n") + footer(d["as_of"], "/data/public/screen.json");
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
      // GET /mcp (또는 DELETE 등) — 무상태 서버: 스트림·세션 미지원.
      // ★405 는 규약상 '정답'이다(MCP Streamable HTTP: SSE 스트림을 제공하지 않으면 GET 에
      //   405 를 반환해야 한다). 다만 [2026-08-03 AI 리뷰 3건]이 "GET 405 라 뭐가 있는지
      //   알 수 없다"고 지적했다 → 상태코드는 규약대로 두고 **본문에 도구 목록과 호출법**을
      //   넣어, 주소만 눌러본 사람·크롤러도 서버의 정체를 바로 알 수 있게 한다.
      return jsonResponse(
        {
          ...rpcError(null, -32000, "Method Not Allowed: send a JSON-RPC 2.0 POST to /mcp (stateless server; GET stream and sessions are not supported)"),
          server: { ...SERVER_INFO, transport: "streamable-http", auth: "none" },
          registry: "com.aikstockdata/mcp",
          docs: `${ORIGIN}/ai.html`,
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
          example: {
            method: "POST",
            url: `${url.origin}/mcp`,
            headers: { "Content-Type": "application/json" },
            body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
          },
        },
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
