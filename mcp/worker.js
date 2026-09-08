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
  // [2026-08-17 P3-1] 개수를 주석에 적지 않는다 — 적는 순간 낡는다(이 줄이
  //   '6개 → 10개'였는데 실물은 12개였다). 개수는 TOOLS 배열에서 센다.
  // 도구가 늘면 version 을 올린다. 레지스트리·공개 저장소의 server.json 과
  //   반드시 같은 값이어야 하고, 값 변경에는 레지스트리 재등재 절차가 따로 있다.
  version: "2.1.2",
};
// ★[2026-08-12] 배포가 도착했는지 **묻지 않고 확인**하기 위한 표식.
//   사이트는 모든 JSON 봉투에 code_rev 를 실어 보내서, 코드가 갔는지를 발주자에게
//   물어보지 않고 라이브를 읽어 확인한다. 워커에는 그게 없었다 — 그래서 오늘
//   "배포했어"를 듣고도 반영 여부를 말할 수 없었다(version 은 도구가 늘 때만 올리고,
//   새 코드는 특정 조건에서만 다르게 동작해 겉으로 구분되지 않는다).
//   deploy_mcp.py 가 올릴 때 이 문자열을 git 짧은 해시로 바꿔 넣는다. 디스크의
//   worker.js 는 그대로 두므로(치환은 업로드본에만) 저장소가 더러워지지 않는다.
const CODE_REV = "__CODE_REV__";
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_VERSION = "2025-06-18";
// ★[2026-08-11 4호 A-6] 첫 문장이 '한국 주식 데이터'였다 — 그건 경쟁자도 다 하는 말이다.
//
// 감사 결론: 이 서버의 해자는 시세가 아니라 **공시 유형별 이후 주가 경로 통계 + 이벤트
// 원장**이다(조사 범위에서 대체재 미발견). 그 문장이 어디에도 앞에 없어서, 도구를
// 고르는 모델이 "그냥 또 하나의 주가 API"로 읽고 지나쳤다. 맨 앞에 둔다.
//
// ★"국내외 유일" 단정 금지(§7-7). Smithery 에 원격 한국주식 MCP 가 실재한다 —
//   반례 하나에 서사 전체가 무너지는 문장을 만들지 않는다. "우리가 아는 한"을 붙인다.
// ★h20 광고 금지(§7-8). 다만 "아직 발행 안 한다"고 못 박지도 않는다 — 채워지는 날
//   그 문장이 거짓이 된다. 상태는 disclosure_impact.json 의 h20_status 가 말한다(P-5).
// ★'서프라이즈' 금지(§7-2) — 컨센서스 데이터가 없다. YoY 방향까지만.
const INSTRUCTIONS =
  "★What this server has that others do not: post-filing price paths BY DISCLOSURE TYPE — " +
  "market-adjusted median return at h0/h1/h5 with 95% CI and up-ratio, plus the underlying " +
  "per-event ledger ({N_EVENTS} events with receipt timestamp and session). To our knowledge this is " +
  "the only sign-up-free, key-free remote MCP serving this for Korean equities. " +
  "Ask it things like \"유상증자 공시 다음날 주가는 보통 어땠나\" via get_disclosure_impact. " +
  "When a 95% CI includes zero the response says so — that means 'not distinguishable', not 'no effect'. " +
  "h20 (+20 trading days) appears per type once that type has enough samples — read " +
  "h20_status in disclosure_impact.json rather than assuming; missing is not the same as zero. | " +
  "★남들에게 없는 것: 공시 유형별 이후 주가 경로(시장조정 중앙값 h0/h1/h5·CI95·상승확률)와 " +
  "그 근거가 되는 이벤트 원장 {N_EVENTS}건(접수 시각·세션 포함). 우리가 아는 한, 가입·API 키 없이 " +
  "이것을 주는 원격 한국주식 MCP 는 여기뿐입니다. | " +
  "Korean stock data from aikstockdata.com (한국주식데이터): DART disclosures in easy language, " +
  "Financial Services Commission (금융위) T+1 confirmed closing prices, and machine-computed rankings " +
  "for {MARKETS}. Refreshed every trading day at 18:10 KST. No auth, no API key — 100% public, " +
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
  + "전에 get_data_urls() 를 부르세요. | Fair use: this data changes once per trading day "
  + "(18:10 KST) — polling faster than that returns the same values, it doesn't get you "
  + "fresher ones. | 공정 이용: 이 데이터는 매 거래일 18:10 한 번만 바뀝니다 — 그보다 "
  + "자주 불러도 같은 값이 돌아올 뿐 새 값을 안 줍니다.";

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

/**
 * 목록을 잘라 보일 때 **잘랐다는 사실과 전체 건수**를 한 문장으로 돌려준다.
 * 안 잘렸으면 빈 문자열.
 *
 * ★[2026-08-12 실사용자 감사] 이 저장소 최초의 실사용자 신고가 "개수만 주고 목록을
 *   안 준다"였다. 그 뒤 search_stock·실적캘린더·list_stocks 는 총건수를 말하도록
 *   고쳤는데, get_rankings·get_earnings·get_disclosures 는 **빠졌다.** 도구마다 손으로
 *   적었기 때문이다(CLAUDE.md 원칙 1 — 손목록은 반드시 낡는다).
 *
 *   특히 get_rankings 는 침묵을 넘어 **거짓말**을 하고 있었다. limit=3 으로 부르면
 *   "limit 을 올려도 growth 는 최대 3건입니다"라고 답했다 — 실제 원본은 8건인데
 *   돌려준 건수(rows.length)를 상한이라고 말한 탓이다. 받는 쪽은 더 요청할 이유를
 *   잃는다. 침묵보다 나쁘다.
 *
 * @param {number} total 자르기 **전** 전체 건수
 * @param {number} shown 실제로 보인 건수
 */
function moreLine(total, shown, unit = "건", hint = "limit 을 올리면 더 나옵니다") {
  if (!(total > shown)) return "";
  return `\n... 외 ${fmt(total - shown)}${unit} (전체 ${fmt(total)}${unit} — ${hint})`;
}

// ── 한글로 읽은 종목명 ────────────────────────────────────────────────────
//
// ★[2026-08-12 발주자 질문에서] "ktis 라는 종목도 있니?"를 받고 재 봤다.
//   유니버스 1,500 중 **이름에 라틴 문자가 든 것이 268개(17.9%)**, 그중 66개는
//   라틴 전용이다 — NAVER · SK · KT · LG · GS · CJ · HMM · S-Oil · HLB …
//   한국인이 가장 많이 치는 이름들이 거기 있다.
//
//   검색은 이름에 대한 대소문자 무시 부분일치라, 'ktis' 는 잘 찾아진다.
//   그런데 **'네이버'는 0건**이다 — 발행된 이름이 'NAVER' 이기 때문이다.
//   데이터가 있는데 사람이 쓰는 말로는 닿지 않는다(이 저장소 최초 신고와 같은 부류).
//
//   별칭표를 손으로 적으면 반드시 낡는다(CLAUDE.md 원칙 1). 그래서 대부분을
//   **낱자 규칙으로 기계 생성**하고, 단어처럼 읽는 소수만 표에 둔다.
const _KO_LETTER = {
  A: "에이", B: "비", C: "씨", D: "디", E: "이", F: "에프", G: "지", H: "에이치",
  I: "아이", J: "제이", K: "케이", L: "엘", M: "엠", N: "엔", O: "오", P: "피",
  Q: "큐", R: "알", S: "에스", T: "티", U: "유", V: "브이", W: "더블유",
  X: "엑스", Y: "와이", Z: "지",
};
// 낱자로 안 읽는 것만. 규칙으로 못 만드는 것이 여기 온다 — 짧게 유지한다.
const _KO_WORD = {
  NAVER: ["네이버"], POSCO: ["포스코"], OIL: ["오일"], KIWOOM: ["키움"],
  CGV: ["씨지브이"], ENM: ["이엔엠"], ENT: ["엔터", "엔터테인먼트"],
  ELECTRIC: ["일렉트릭"],
};

/** 라틴이 섞인 종목명을 **한글로 읽은 문자열들**로 바꾼다(없으면 빈 배열). */
function koReadings(name) {
  const runs = String(name || "").match(/[A-Za-z]+/g);
  if (!runs) return [];
  let outs = [String(name)];
  for (const run of runs) {
    const up = run.toUpperCase();
    const reads = _KO_WORD[up] ||
      [up.split("").map((ch) => _KO_LETTER[ch] ?? ch).join("")];
    const next = [];
    for (const base of outs) {
      for (const r of reads) next.push(base.replace(run, r));
    }
    outs = next.slice(0, 8);          // 조합 폭발 방지(라틴 덩어리가 많은 이름)
  }
  // & 는 '앤'으로 읽는다(KT&G → 케이티앤지, F&F → 에프앤에프)
  const read = outs.map((s) => s.replace(/&/g, "앤"));
  // ★붙여 쓴 형태도 같이 낸다. 'S-Oil' 은 낱자 치환만 하면 '에스-오일' 이 되는데
  //   사람은 '에스오일' 이라고 친다. 하이픈·공백·점은 사람이 안 친다고 본다.
  const compact = read.map((s) => s.replace(/[\s.\-]/g, ""));
  return [...new Set([...read, ...compact])].filter((s) => s && s !== String(name));
}
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

// ★[2026-08-10 P1 · 실사용자 감사] 지수를 빼먹어 코스피 -4.58% 날을 "혼조"로 요약했다.
//
// today.json 에 코스피 6,296.38(-301.88p, -4.58%)·코스닥 801.67(+0.26%)이 멀쩡히 들어
// 있는데 get_today 도 get_market_summary 도 그것을 읽지 않고 등락 **종목 수**만 냈다.
// "오늘 시장 어땠어"는 이 서비스에 가장 많이 들어오는 질문인데, 거기서 정반대 인상을
// 준 셈이다. 운영자는 함정을 이미 알고 있었다 — market_breadth.tone_rule 에 "이 지표는
// 종목 수 기준이라 시가총액 가중인 지수와 방향이 다를 수 있다"고 자진 기재해 뒀다.
// 라벨 어휘만 바꾸고 정작 지수를 붙이는 처방은 안 한 상태였다.
const idxNum = (v) => Number(v).toLocaleString("en-US",
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sgn = (v) => (v > 0 ? "+" : "");

function indexLine(mi) {
  const parts = [];
  for (const k of ["코스피", "코스닥"]) {
    const x = (mi || {})[k];
    if (!x || x["close"] == null) continue;
    const ch = x["change"], cp = x["change_pct"];
    parts.push(`${k} ${idxNum(x["close"])}` +
      (ch == null ? "" : ` (${sgn(ch)}${ch}p, ${sgn(cp)}${cp}%)`));
  }
  return parts.length ? parts.join(" · ") : null;
}

// 지수와 등락 폭의 방향이 갈리는 날에만 한 줄. 늘 붙이면 잡음이 되고, 안 붙이면
// 사용자가 둘 중 하나만 보고 정반대로 읽는다. 기준은 지수 ±1.5% — 그 아래는
// 둘이 갈려도 이야깃거리가 아니다.
function breadthDivergence(mi, b) {
  const cp = (((mi || {})["코스피"]) || {})["change_pct"];
  const r = (b || {})["advance_ratio_ex_flat_pct"];
  if (cp == null || r == null || Math.abs(cp) < 1.5) return null;
  if (cp < 0 && r >= 45) {
    return `⚠ 코스피는 ${cp}% 빠졌는데 오른 종목은 절반(${r}%)입니다 — ` +
      "지수는 시가총액 가중이고 등락 폭은 종목 수 기준이라 큰 종목이 빠진 날 둘이 갈립니다.";
  }
  if (cp > 0 && r <= 55) {
    return `⚠ 코스피는 ${sgn(cp)}${cp}% 올랐는데 오른 종목은 ${r}%뿐입니다 — ` +
      "지수는 시가총액 가중이라 큰 종목 몇 개가 끌어올린 날일 수 있습니다.";
  }
  return null;
}

// ★[2026-08-10 실사용자 신고] 도구 6개만 보고 "이 서비스는 잠정실적·시계열이 없다"고
// 결론내린 AI 가 있었다. 데이터는 둘 다 이미 있었다(earnings.json · s/{code}_history.json).
// **AI 는 도구 목록을 능력의 경계로 읽는다.** 목록에 없으면 없는 것으로 취급한다.
// 그래서 모든 응답 꼬리에 "여기 말고 더 있다"를 한 줄 고정으로 붙인다.
// [2026-08-10 감사 P3-F] "데이터 20종"은 카탈로그 실물(endpoints 26개)과 어긋난다.
// 개수를 여기 하드코딩하면 카탈로그가 늘 때마다 조용히 틀려진다 — 숫자를 뺀다.
const MORE_LINE =
  "데이터 전체 카탈로그: get_data_urls() — 잠정실적(earnings)·1년 일별 시계열·" +
  "공시 이후 주가(disclosure_impact)·장중 공시(접수 시각)도 있습니다. 조건으로 목록을 뽑으려면 list_stocks().";

// ★[2026-08-17 P3-8] 스키마와 데이터셋 메타의 **존재**를 말한다.
//
// 사이트는 /data/public/schemas/ 에 JSON Schema 를 발행하고 공개 JSON 마다
// $schema 를 박는데, 이 파일에는 `schema_version` 문자열이 **0회**였다. MCP 로
// 들어온 소비자에겐 필드 정의가 존재한다는 신호가 어디에도 없었다 —
// "데이터가 있는데 도구가 그 존재를 말하지 않으면 소비자는 '없다'고 결론낸다".
//
// 한 줄이다. 모든 응답에 나가는 자리라 길이가 곧 비용이다.
// ★개수를 쓰지 않는다. "스키마 9종"은 열 번째가 생기는 날 거짓말이 된다
//   (MORE_LINE 이 "데이터 20종"으로 정확히 그 사고를 겪고 숫자를 뺐다).
const SCHEMA_LINE =
  `필드 정의(JSON Schema 2020-12): ${ORIGIN}/data/public/schemas/ · ` +
  `데이터셋 메타·라이선스: ${ORIGIN}/data/public/index.json`;

// ★[2026-08-10 P1-J · 실사용자 감사] 커버리지를 성공 응답에도 밝힌다.
// 지금까지 "1,500"은 **검색 실패 메시지에서만** 나왔다. 정상 경로로 답을 받은
// 사용자에게는 도달하지 않는다는 뜻이다. 그런데 "상승 690·하락 679"나
// "52주 신고가 12종목"이 **전체 시장 수치로 재인용되면 이 서비스가 오답의 출처**가
// 된다 — 재배포 자유 라이선스라 실제로 흘러간다.
// ★[2026-08-17 P2-10] 숫자를 문장에 박아 두면 확대하는 날 이 문장이 거짓말이 된다.
//   그런데 소비자는 이 숫자를 그대로 인용한다 — 재배포 자유 라이선스라 실제로 흘러간다.
//   그래서 이미 서빙 중인 /data/public/index.json 의 coverage 블록에서 읽는다
//   (sitegen 이 _COUNTS 로 매 발행 채우는 값). fetchJson 이 캐시하므로 매 요청마다
//   원본을 때리지 않는다.
//   ★못 읽으면 **숫자를 지어내지 않고** 숫자 없는 문장으로 간다. 틀린 수를 말하느니
//     범위를 말하지 않는 편이 낫다.
// ★★[2026-08-28 전종목 전환 뒤] 바로 위 P2-10 은 **숫자**를 살아 있는 값에서 읽게
//   고쳤다. 그런데 그 숫자를 **설명하는 말**은 손글씨로 남았고, 전종목 전환으로
//   그 말이 셋 다 거짓이 됐다:
//     · "시총 상위"          → 이제 시총순으로 자르지 않는다
//     · "우선주·리츠·스팩 미수록" → 라이브 실측(2026-08-28, /stocks 2,799행):
//                              우선주 93 · 리츠 24 · 스팩 42가 **발행되고 있다**
//     · "상장 전체가 아닙니다"
//   ★그냥 틀린 정도가 아니다 — **있는 데이터를 없다고 말하고 있었다.** 이 저장소
//     최초의 실사용자 신고가 정확히 그 사고였다(CLAUDE.md §4). 게다가 이 줄은
//     재배포 자유 라이선스를 타고 모든 도구 응답에 실려 나간다.
//   ⇒ 정말로 남은 단서는 다른 것이다: **랭킹만** 보통주로 좁힌다
//     (`build_rankings.ELIGIBLE_CLASS=("common",)`). 그 사실이 지금까지 어디에도
//     없었다. 그 수도 손으로 적지 않는다 — `coverage.rankings_eligible_n` 에서
//     읽고(발행이 rankings.json 의 eligibility 실물에서 채운다), 없으면 그 절만
//     통째로 빠진다(틀린 수를 말하느니 말하지 않는다 — 위와 같은 규약).
const COVERAGE_FALLBACK =
  "집계 범위: 우선주·리츠·스팩까지 포함한 유니버스 · 랭킹은 보통주만 집계합니다.";
// 요청마다 tools/call 진입에서 갱신된다. 갱신 전에도 문장은 성립한다(숫자만 없다).
let COVERAGE_LINE = COVERAGE_FALLBACK;

async function coverageLine() {
  try {
    const idx = await fetchJson("/data/public/index.json");
    const c = (idx && idx.coverage) || {};
    const uni = c.universe_n, pub = c.published_n, elig = c.rankings_eligible_n;
    if (!uni && !pub) return COVERAGE_FALLBACK;
    const num = (v) => Number(v).toLocaleString("ko-KR");
    const head = uni ? `유니버스 ${num(uni)}종목` : "유니버스";
    const got = pub ? `(당일 시세 수신 ${num(pub)})` : "";
    const rank = elig
      ? ` · 랭킹 집계 대상은 그중 ${num(elig)}종목(보통주·거래상태 자격)`
      : " · 랭킹은 보통주만 집계";
    return `집계 범위: ${head}${got} — 우선주·리츠·스팩 포함${rank}.`;
  } catch (e) {
    return COVERAGE_FALLBACK;
  }
}

// ★★[2026-08-13 실측] 같은 라벨(기준일)이 도구마다 **다른 형식**으로 나갔다.
//   get_today·get_stock·get_earnings·get_rankings·list_stocks·get_history → 20260811
//   get_disclosures                                                       → 2026-08-13
//   get_data_urls·get_earnings_calendar·get_disclosure_impact·search_stock → 2026.08.12
//   원본 파일의 as_of 를 그대로 흘려보낸 결과다. 날짜 정확성이 이 서비스의 정체성인데
//   같은 이름의 값이 세 형식이면 받는 쪽이 파싱 규칙을 하나로 못 잡는다. 배너 안에서
//   똑같은 사고를 이미 한 번 고쳤고(2026-08-11: 한 줄 안에 2026-08-07 과 20260810),
//   그때 만든 변환을 배너 안에 가둬 둔 것이 이번 재발의 원인이다 — 밖으로 뺀다.
//   (뜻까지 같아지는 것은 아니다: 시세 축과 발행 축이 섞여 있다. 그 구분은 배너가
//    맨 앞에서 시세·공시 날짜를 따로 말해 주고, 여기 출처 경로가 어느 파일인지 밝힌다.)
function isoDate(v) {
  const s = String(v == null ? "" : v).trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
  if (/^\d{4}[.\/]\d{2}[.\/]\d{2}$/.test(s)) return s.replace(/[.\/]/g, "-");
  return s;      // 모르는 모양은 건드리지 않는다 — 지어내는 것보다 그대로가 낫다
}

function footer(basisDate, srcPath) {
  return `\n---\n기준일 ${isoDate(basisDate) || "미기록"} | 출처 ${ORIGIN}${srcPath} | 투자 권유가 아닌 정보 제공입니다.` +
         `\n${COVERAGE_LINE}` +
         `\n${MORE_LINE}` +
         `\n${SCHEMA_LINE}`;
}

// ★[2026-08-10 3호 F-1] 공시 한 건 밑에 붙는 "이 유형은 과거에 어땠나" 한 줄.
//
// 지금 한국에서 이걸 무료·무키로 주는 곳이 없다. 그런데 우리는 그 데이터를 이미
// 만들어 놓고 **따로 물어보는 사람에게만** 줬다 — 파일 따로, 도구 따로.
// 조인 한 줄이면 모든 공시 응답이 즉시 차별화된다.
//
// 정직성 장치는 그대로 노출한다. 완화가 아니다:
//   구간이 0을 포함하면 그 사실을 쓰고, 표본이 모자라면 숫자 대신 사유를 쓴다.
function impactLine(im) {
  if (!im) return null;
  const seg = [];
  for (const [k, lab] of [["h1", "다음날"], ["h5", "5일"]]) {
    const c = im[k];
    if (!c) continue;
    if (!c.enough) { seg.push(`${lab} ${c.why || "표본 부족"}`); continue; }
    seg.push(`${lab} ${pct(c.median_excess_pct)}` +
      (c.up_ratio_pct != null ? `(상승 ${c.up_ratio_pct}%)` : "") +
      (c.ci_includes_zero ? " ←0 포함" : ""));
  }
  if (!seg.length) return null;
  const n = (im.h1 || im.h5 || {}).n;
  const from = (im.h1 || im.h5 || {}).sample_from;
  const to = (im.h1 || im.h5 || {}).sample_to;
  return `  └ 이 유형의 과거(n=${n ?? "?"}${from ? `, ${from}~${to}` : ""}): ` + seg.join(" · ") +
    " — 시장 등락을 뺀 중앙값이며 이 건의 예측이 아닙니다.";
}

function userError(message) {
  const e = new Error(message);
  e.isUserError = true;
  return e;
}

// ★[2026-08-10 P5-F · 실사용자 감사] 수치 파라미터만 무검증이었다.
//
// 문자열은 엄격했다 — 잘못된 filter 는 유효값 6개를 나열하며 정확히 거부한다.
// 그런데 get_history(days=-10) 은 오류 없이 "[최근 1거래일]" 한 줄을 냈고,
// get_earnings(limit=0) 은 2건, limit=-5 는 1건을 냈다. 서버 안에서 검증 수준이
// 갈리면 래퍼를 만드는 개발자가 에러 분기를 안정적으로 짤 수 없다.
//
// 조용히 자르지도 않는다. days=1000 이 말없이 60건이 되면 "이 서비스는 60일치밖에
// 없다"는 오해가 생긴다 — 실제로 그 오해가 보고됐다. 조정했으면 조정했다고 말한다.
function clampNum(v, lo, hi, dflt, name, notes) {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw userError(`${name} 은 숫자여야 합니다(받은 값: ${v}).`);
  const c = Math.max(lo, Math.min(hi, Math.trunc(n)));
  if (c !== Math.trunc(n) && notes) {
    notes.push(`요청한 ${name}=${v} 을 허용 범위(${lo}~${hi}) 안의 ${c} 로 조정했습니다.`);
  }
  return c;
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
      "Start here for \"how was the Korean market today?\" — index levels, breadth, 52-week high/low " +
      "counts, top-3 disclosures, growth top-3, movers and disclosure-type counts in one call. " +
      "Then drill down with get_stock / list_stocks / get_disclosures. " +
      "Coverage: top-by-market-cap universe (see coverage in index.json), not the full listing. | " +
      "\"오늘 시장 어땠어?\"의 출발점 — 지수·등락 폭·주요 공시·성장 랭킹·등락률 상하위를 한 번에. " +
      "이어서 get_stock / list_stocks / get_disclosures 로 파고들면 됩니다.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const d = await fetchJson("/data/public/today.json");
      const basis = d["as_of"] || "";
      const b = d["market_breadth"] || {};
      const out = [];
      out.push("오늘의 한국 증시 요약 (한국주식데이터 · 금융위 T+1 확정 종가)");
      out.push(`- 기준일: ${isoDate(basis)} · 스냅샷(실시간 아님)`);
      // 지수가 먼저다. "오늘 시장 어땠어"의 답은 등락 종목 수가 아니라 지수다.
      const ix = indexLine(d["market_index"]);
      if (ix) out.push(`- 지수: ${ix}`);
      if (b["up"] != null) {
        out.push(`- 등락 폭: ${b["tone"] || "-"} (상승 ${fmt(b["up"])}·하락 ${fmt(b["down"])}·보합 ${fmt(b["flat"])}종목, 상승 비율 ${b["up_ratio_pct"]}%) — 종목 수 기준(시총가중 아님)`);
      }
      const dv = breadthDivergence(d["market_index"], b);
      if (dv) out.push(`  ${dv}`);
      const hl = d["highs_lows_52w"] || {};
      out.push(`- 52주 신고가 ${fmt(hl["n_high"])}·신저가 ${fmt(hl["n_low"])} · 실측 흑자전환 ${fmt(d["earnings_turnaround_n"])}종목`);
      // 도구 설명이 이미 약속한 항목인데 출력에 없던 것들(감사 P1-B)
      const mu = d["movers_up"] || [], md = d["movers_down"] || [];
      if (mu.length || md.length) {
        out.push("");
        out.push("[등락률 상·하위]");
        if (mu.length) out.push("  상승 " + mu.slice(0, 3).map((x) => `${x["name"]}(${x["code"]}) ${pct(x["change_pct"])}`).join(" · "));
        if (md.length) out.push("  하락 " + md.slice(0, 3).map((x) => `${x["name"]}(${x["code"]}) ${pct(x["change_pct"])}`).join(" · "));
      }
      const td = d["top_disclosures"] || [];
      if (td.length) {
        out.push("");
        out.push("[주요 공시 TOP3]");
        td.forEach((e, i) => {
          out.push(`${i + 1}. ${e["name"]} — ${e["label"]}${e["fact"] ? ` (${e["fact"]})` : ""}`);
          const _il = impactLine(e["type_impact"]);
          if (_il) out.push(_il);
        });
      }
      const g = d["growth_top3"] || [];
      if (g.length) {
        out.push("");
        out.push("[성장 랭킹 TOP3 (공개 산식 · 추천 아님)]");
        g.forEach((s, i) => out.push(`${i + 1}. ${s["name"]} (점수 ${s["score"]}/100, 영업이익 전년비 ${s["status"] || pct(s["operating_income_yoy_pct"])})`));
        // ★[2026-08-31 · 9호 DATA-65] 기수를 말한다. 없으면 아무 말도 안 한다 —
        //   틀린 기수를 말하는 것보다 낫다. 값은 today.json 이 실어 준다.
        {
          const per = g.map((x) => x["financial_period"]).filter(Boolean);
          const uniq = [...new Set(per)];
          if (uniq.length) {
            out.push(`   재무 기수: ${uniq.join(" · ")} — 정기보고서 실측입니다. ` +
              "기수가 바뀌지 않으면 순위도 바뀌지 않습니다(시세를 쓰지 않습니다).");
          }
        }
      }
      if (d["earnings_improve_rate_pct"] != null) {
        out.push("");
        out.push(`[실적] 최근 발표 ${fmt(d["earnings_reported_n"])}개 중 전년 대비 개선 ${d["earnings_improve_rate_pct"]}%`);
      }
      // 공시 유형 집계 — description 이 "aggregate stats (disclosure-type counts)"라고
      // 약속해 놓고 출력에 없었다. 상위 6종만, 나머지는 건수로 접는다.
      const dtc = d["disclosure_type_counts"] || {};
      const dte = Object.keys(dtc).map((k) => [k, dtc[k]]).sort((a, b2) => b2[1] - a[1]);
      if (dte.length) {
        out.push("");
        out.push("[공시 유형] " + dte.slice(0, 6).map((e) => `${e[0]} ${e[1]}`).join(" · ") +
          (dte.length > 6 ? ` · 외 ${dte.length - 6}종` : ""));
      }
      out.push("");
      out.push(`상세는 get_stock(code)·get_rankings, 전체 데이터는 ${ORIGIN}/data/public/today.json`);
      return out.join("\n") + footer(basis, "/data/public/today.json");
    },
  },
  {
    name: "search_stock",
    title: "종목 검색 (Search stocks)",
    // ★[2026-08-26 · 9호 3-5] 이 설명에 **손글씨 '1,500'** 이 박혀 있었다.
    //   `tools/list` 로 AI 에게 그대로 나가는 문장이라, 전종목 전환(2026-08-26
    //   18:10, 약 2,800)이 켜지는 순간 **거짓말이 된다.** 이 파일이 이미 두 번
    //   같은 사고를 겪고 정한 규칙이 위에 있다 — SCHEMA_LINE 의 "개수를 쓰지
    //   않는다", MORE_LINE 의 "데이터 20종"에서 숫자를 뺀 것. 여기만 남아 있었다.
    //   ★COVERAGE_LINE 처럼 라이브에서 주입하지 않는 이유: `tools/list` 는 정적
    //     목록이라 요청마다 원본을 때리게 만들 값이 아니다. 범위를 말하지 않는
    //     편이 틀린 수를 말하는 것보다 낫다(같은 규칙).
    //   눈이 멀어 이걸 못 잡던 tools/count_census.py 도 같은 커밋에서 고친다.
    // ★[2026-08-12] 이 설명은 **도구가 실제로 하는 것보다 못한다고 말하고 있었다.**
    //   "한글명 부분일치 전용 — 영문은 안 됩니다"라고 적혀 있었는데, 구현은 처음부터
    //   대소문자 무시 부분일치라 'ktis' 로 KTis 가 잘 찾아진다(라이브 실측).
    //   틀린 설명은 기능을 없애는 것과 같다 — 읽은 사람은 시도조차 안 한다.
    //   실제로 발주자가 "ktis 라는 종목도 있니?"를 사람에게 물어야 했다.
    //   설명은 구현을 따라간다. 못 하는 것만 못 한다고 적는다(로마자 표기 'samsung').
    description:
      "Find a ticker from part of the name — Korean or Latin, case-insensitive — or a 6-digit " +
      "code, within the market-cap-ranked universe (ETFs included). Korean readings of " +
      "Latin names also match ('네이버' finds NAVER, '케이티' finds KT/KTis). Romanised Korean " +
      "does not ('samsung' returns nothing; '삼성' works). Up to 10 matches, market-cap sorted. | " +
      "이름 일부(한글·영문 모두, 대소문자 무시)나 6자리 코드로 찾습니다. 영문 이름의 " +
      "한글 읽기도 매치됩니다('네이버'→NAVER, '케이티'→KT·KTis). 다만 한국어의 로마자 " +
      "표기는 안 됩니다('samsung' 0건, '삼성' 14건). 시총 상위 유니버스 · 시총순 최대 10건.",
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
      // 이름·코드 부분일치(대소문자 무시) + **한글로 읽은 이름**까지 본다.
      // 예: '네이버' → NAVER · '에스케이하이닉스' → SK하이닉스 · '케이티' → KT·KTis·KTcs
      let hits = items.filter(
        (s) =>
          String(s.n ?? "").toLowerCase().includes(ql) ||
          String(s.c ?? "").includes(q) ||
          // ★발행 쪽이 계산해 실어 보낸 한글 읽기(k)를 **먼저** 쓴다. 규칙이 두 곳에
          //   있으면 갈라지므로, 데이터에 있으면 그것이 정답이다. 없을 때만(옛 인덱스·
          //   전파 지연) 아래 자체 계산으로 물러선다.
          (Array.isArray(s.k) ? s.k : koReadings(s.n)).some((r) => r.includes(q))
      );
      const basis = idx["as_of"] || "";
      if (hits.length === 0) {
        return (
          //  ★[2026-09-08] 「KOSPI·KOSDAQ」이라고 적혀 있었다 — **코넥스가 빠졌다.**
        //   우리는 코넥스도 싣는다(라이브 실측 106종목). 그렇다고 세 이름을 손으로
        //   박으면 시장이 늘 때 또 낡는다(§1) — 그래서 **열거하지 않는다.**
        `'${q}'와 일치하는 종목이 없습니다. 현재 데이터셋은 국내 상장 ${fmt(idx["count"])}종목입니다.\n` +
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
      // ★[2026-08-10 P6-O] 총건수를 숨기지 않는다. '삼성'은 14건 매치인데 10건만
      // 보여주면서 나머지 4건의 존재를 말하지 않았다 — 찾는 종목이 그 안에 있으면
      // 사용자는 "없다"고 결론낸다.
      const nAll = hits.length;
      hits = hits.slice(0, 10);
      const lines = hits.map(
        (s, i) => `${i + 1}. ${s.n} (${s.c}) | ${s.m} | 시총 ${eok(mcap[s.c])}`
      );
      const more = nAll > hits.length;
      return (
        `'${q}' 검색 결과 ${more ? `전체 ${nAll}건 중 시총 상위 ${hits.length}건` : `${hits.length}건`} (시가총액순):\n` +
        lines.join("\n") +
        (more ? `\n\n… 외 ${nAll - hits.length}건 — 이름을 길게 주면 좁혀집니다(예: search_stock("삼성제약")).` : "") +
        // ★[2026-08-12] 이 줄은 '에스케이→SK' 를 **안 되는 예**로 들고 있었다.
        //   지금은 그게 되는 예다. 응답에 박힌 틀린 안내는 도구 설명보다 더 자주 읽힌다.
        "\n\n이름 일부(한글·영문 모두)·6자리 코드로 찾습니다. 영문 이름의 한글 읽기도 " +
        "매치됩니다('네이버'→NAVER). 한국어의 로마자 표기는 안 됩니다('samsung' 0건)." +
        `\n상세는 get_stock(code)로, 전체 목록은 ${ORIGIN}/data/public/search_index.json 을 쓰세요.` +
        footer(basis, "/data/public/search_index.json")
      );
    },
  },
  {
    name: "get_stock",
    title: "종목 상세 (Stock detail)",
    description:
      "One Korean stock by 6-digit code: T+1 confirmed close & change, market cap, latest " +
      "quarterly financials (revenue / operating income / net income, with YoY), and ranking signals. " +
      "Two as-of dates move independently — price (quote_as_of) and filings (disclosure_through); " +
      "the response header carries both, do not merge them into one \"today\". null means not provided, " +
      "never 0. Name → code: search_stock. 250 trading days of prices: get_history. Filings with " +
      "receipt times: get_disclosures. Screening a list: list_stocks. | " +
      "6자리 코드로 한 종목 — 확정 종가·등락·시총·최근 분기 실적(전년비)·랭킹 신호. " +
      "기준일이 둘이고 따로 움직입니다(시세·공시) — 응답 머리말에 둘 다 실리니 하나로 합치지 마세요. " +
      "null 은 '미제공'이며 0이 아닙니다. 이름으로 찾기는 search_stock, 1년 시세는 get_history, " +
      "접수 시각이 있는 공시는 get_disclosures, 조건 목록은 list_stocks.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "6-digit ticker as a STRING with leading zeros kept — '000020', not 20. " +
            "e.g. '005930' (삼성전자). Unknown but well-formed code returns a short note " +
            "(not an error); a malformed one tells you to use search_stock. | " +
            "6자리 종목코드 **문자열**(앞자리 0 유지 — '000020'을 20으로 읽으면 안 맞습니다). " +
            "형식이 맞는데 없는 코드면 오류가 아니라 안내를 돌려주고, 형식이 틀리면 search_stock 을 안내합니다.",
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
      // ★[2026-08-10 P1-I · 실사용자 감사] 시세가 없는 종목(ETF 32종)에 진입 가드.
      //
      // 069660(KIWOOM 200) 응답이 「기준일:  · 스냅샷」(값 공백), 「종가: 미제공원」,
      // 「거래량: 미제공주」였고 ETF 인데 DART 기업검색 링크까지 붙었다. 원본
      // s/069660.json 은 quote=null·as_of=null 로 정직한데 렌더러가 null 에 단위
      // 접미사를 붙여 없는 단어를 만들어 냈다. 같은 '데이터 없음'인데 999999 는
      // 깔끔한 안내를 받고 이쪽만 깨진 문자열을 받는다 — 분기마다 답이 달랐다.
      if (!s["quote"]) {
        return `${s["name_ko"] || code} (${code})${s["market"] ? " — " + s["market"] : ""}\n\n` +
          "이 종목은 해당 거래일 시세를 받지 못해 수치를 제공하지 않습니다" +
          "(ETF·ETN 등 유니버스에 이름만 있는 종목이거나 거래정지·신규상장 구간).\n" +
          `제외 사유 목록: ${ORIGIN}/data/public/excluded.json` +
          footer(basis, `/data/public/s/${code}.json`);
      }
      const qt = s["quote"] || {};
      const out = [];
      out.push(`${s["name_ko"]} (${s["code"]}) — ${s["market"] || ""}`);
      out.push(`기준일: ${isoDate(basis)} · 스냅샷(실시간 아님) · 출처: 공공데이터(금융위 T+1·DART)`);
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
        // ★[2026-08-10 P1-C · 실사용자 감사] **더 최신 잠정실적이 있으면 여기서 말한다.**
        //
        // 349종목 전부 financials.newer_available 이 채워져 있는데 이 렌더러가 읽지
        // 않아서, 삼성전자 응답이 「1분기 누적 영업이익 57.2조」로 끝났다. 같은 파일
        // 안에 반기 잠정 146.7조가 들어 있었다 — 2.5배 차이다. 데이터 파이프라인은
        // 이미 완성돼 있었고 비어 있던 것은 렌더러 한 곳이었다.
        const na = f["newer_available"];
        if (na) {
          const yo = (v) => (v == null ? "" : ` (${pct(v)})`);
          const head = `⚠ 더 최신: ${na["period"] || "기간 미상"} ${na["label"] || "잠정 실적"}` +
            `${na["rcept_dt"] ? ` · ${na["rcept_dt"]} 접수` : ""}`;
          out.push("");
          out.push(head);
          if (na["fact"]) {
            out.push(`  ${na["fact"]}`);
          } else {
            // fact 가 비는 경우가 있다 — 항등식 가드가 수치를 보류했거나 추출에 실패한
            // 건이다. "최신이 있다"만 말하고 수치를 안 주면 사용자가 위 정기 수치를
            // 최신으로 오해한다. 있으면 증감률만이라도 주고, 사유는 아래 note 가 말한다.
            const yy = [na["revenue_yoy_pct"] != null ? `매출 전년비${yo(na["revenue_yoy_pct"])}` : null,
                        na["op_income_yoy_pct"] != null ? `영업이익 전년비${yo(na["op_income_yoy_pct"])}` : null]
              .filter(Boolean).join(" · ");
            out.push(`  ${yy || "수치 미확정"} — 상세: get_earnings("${code}")`);
          }
          if (na["note"]) out.push(`  ${na["note"]}`);
          // 기준(연결/별도)이 위 실적과 다르면 그냥 비교하면 안 된다. 실측 105/349건이
          // 불일치라 침묵하면 "2분기 매출 86% 증발" 같은 허위 결론이 유도된다.
          if (na["basis"] && f["basis"] && na["basis"] !== f["basis"]) {
            out.push(`  ⚠ 위 실적은 ${f["basis"]}, 이 잠정치는 ${na["basis"]} 기준입니다 — 직접 비교하지 마세요.`);
          }
          out.push(`  DART 원문: ${na["dart_url"] || ""}`);
        }
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
        out.push(`[최근 공시 ${rd.length}건] 쉬운 말 풀이: ${ORIGIN}/s/${code}`);
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
      "Answers \"which stocks scored highest on measured DART financials?\" — kind='growth' is " +
      "성장 TOP8 (max 8 rows), kind='quiet' is 조용한 실적주. Scores come from a published formula " +
      "over ACTUAL filed financials only — no prices, no analyst estimates. Mechanical, not stock " +
      "picks. For 52-week high/low or turnaround LISTS use list_stocks(). | " +
      "\"실측 재무로 점수가 높은 종목\"에 답합니다 — growth 는 최대 8건, quiet 는 조용한 실적주. " +
      "시세·전망치를 쓰지 않고 DART 실측 재무만 씁니다. 52주 신고저·흑자전환 목록은 list_stocks().",
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
        const all = d["growth_top8"] || [];
        const rows = all.slice(0, limit);
        if (!rows.length) {
          return "성장 랭킹 데이터가 비어 있습니다." + footer(basis, "/data/public/rankings.json");
        }
        const lines = rows.map((s, i) => {
          const yoy = s["상태"] ? s["상태"] : pct(s["영업이익YoY%"]);
          const opm = s["OPM%"] == null ? "미제공" : s["OPM%"] + "%";
          return `${i + 1}. ${s["name"]} (${s["code"]}) | 점수 ${s["score"]}/100 | 영업이익 전년비 ${yoy} | 매출 전년비 ${pct(s["매출YoY%"])} | 영업이익률 ${opm}`;
        });
        // ★[2026-08-10 P6-N] 원본에 완전한 산식이 있는데 도구가 아무것도 노출하지
        // 않았다. "공개 산식"이라고만 하면 무엇이 공개돼 있다는 건지 알 수 없다.
        const fv = d["formula_version"] || (d["설명"] || {})["formula_version"] || "growth-2.1";
        const uni = d["growth_universe_n"] || (d["설명"] || {})["growth_universe_n"];
        return (
          `실측 성장 TOP${rows.length} (DART 재무 기반 100점 만점 기계 산정 · 추천 아님):\n` +
          lines.join("\n") +
          finBasisLine(d) +
          `\n\n산식 ${fv}${uni ? ` (모집단 ${fmt(uni)}종목)` : ""}: 성장 35 + 규모 25 + 마진개선 15 + 이익률 25.` +
          "\n**DART 실측 재무만 사용합니다 — 시세·증권사 전망치를 쓰지 않습니다.** " +
          "흑자전환은 성장 항목 고정점. 전문은 rankings.json 의 설명.growth_top8." +
          // ★상한은 **원본 건수**(all.length)다. 돌려준 건수를 상한이라고 말하면
          //   limit 을 낮춰 부른 사용자에게 "더 없다"는 거짓을 주게 된다.
          (rows.length < all.length
            ? moreLine(all.length, rows.length)
            : `\ngrowth 는 원본이 최대 ${all.length}건입니다(limit 을 올려도 더 없습니다).`) +
          footer(basis, "/data/public/rankings.json")
        );
      }
      const allQ = d["quiet_top"] || [];
      const rows = allQ.slice(0, limit);
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
        moreLine(allQ.length, rows.length, "종목") +
        "\n\n후보 조건: 시총 500억원 이상 · 연환산 영업이익 흑자 · 최근 유상증자/전환사채류 공시 제외 · 금융업 제외." +
        "\n전문은 rankings.json 의 설명. 52주 신고저는 list_stocks(filter='new_high'|'new_low')." +
        footer(basis, "/data/public/rankings.json")
      );
    },
  },
  {
    name: "get_market_summary",
    // ★[2026-08-10 P3-M · 실사용자 감사] 이 도구는 get_today 의 완전 부분집합이었다.
    // 주던 3항목(등락 690/679/94, 52주 신고 12·신저 5, 흑자전환 110)이 get_today 출력
    // 2·3번째 줄에 **글자 그대로** 들어 있었고 추가 정보가 없었다. 둘 다 파라미터가
    // 없어 AI 가 무엇을 부를지 고를 근거도 description 뿐이었다.
    // → 지수·등락 폭 전용으로 역할을 좁힌다. 겹치던 52주·흑자전환은 라우팅만 남긴다.
    title: "지수·등락 폭 (Index & breadth)",
    description:
      "Index levels (KOSPI/KOSDAQ close, change, %) and up/down breadth — nothing else. " +
      "Prices are the previous session's T+1 settled close, never real-time. Index and breadth " +
      "routinely disagree — the index is cap-weighted, breadth is one vote per stock — which is why " +
      "both are returned; do not infer one from the other. " +
      "For the full daily digest (disclosures, rankings, movers) use get_today(). | " +
      "지수와 등락 폭만 봅니다. 하루 전체 요약은 get_today(), 조건별 종목 목록은 list_stocks().",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      // 지수는 today.json 에만 있다. rankings.json 에는 breadth 만 있어서
      // 이 도구가 지수를 못 냈던 것이기도 하다.
      const d = await fetchJson("/data/public/today.json");
      const basis = d["as_of"] || "";
      const b = d["market_breadth"] || {};
      const out = [];
      out.push("한국 증시 지수·등락 폭 (aikstockdata.com · 금융위 T+1 확정 종가)");
      out.push(`- 기준일: ${isoDate(basis)} · 스냅샷(실시간 아님)`);
      const ix = indexLine(d["market_index"]);
      out.push(ix ? `- 지수: ${ix}` : "- 지수: 이 발행본에 지수 블록이 없습니다");
      if (b["up"] != null) {
        out.push(`- 등락 폭: ${b["tone"] || "-"} (상승 ${fmt(b["up"])} · 하락 ${fmt(b["down"])} · 보합 ${fmt(b["flat"])}종목, 상승 비율 ${b["up_ratio_pct"]}%)`);
        out.push("  종목 수 기준입니다(시가총액 가중 아님) — 지수와 방향이 다를 수 있습니다.");
      }
      const dv = breadthDivergence(d["market_index"], b);
      if (dv) out.push(`  ${dv}`);
      out.push("");
      out.push("공시·랭킹·등락률 상하위까지 한 번에 보려면 get_today(), " +
        "52주 신고저·흑자전환 종목 '목록'은 list_stocks(filter='new_high'|'new_low'|'turnaround').");
      return out.join("\n") + footer(basis, "/data/public/today.json");
    },
  },
  {
    name: "get_data_urls",
    title: "공개 데이터 URL (Open data URLs)",
    description:
      "Direct URLs for every public dataset (JSON/CSV) — no signup, no API key. Call this BEFORE " +
      "concluding something is unavailable: the tool list is not the extent of the data. Returns the " +
      "endpoint catalog (quotes, disclosures, rankings, per-stock JSON, search index) plus the " +
      "30-trading-day dated archive with the exact dates held per pattern. Most AI fetch tools cut " +
      "responses near 150 KB and a truncated JSON is unparseable — the catalog names a smaller " +
      "alternative for every large file, so read that instead of guessing. | " +
      "전체 공개 데이터(JSON·CSV) 직링크 카탈로그 — 무가입·무키. **없다고 결론내기 전에 먼저 " +
      "부르세요**: 도구 목록이 데이터의 전부가 아닙니다. 최근 30영업일 날짜별 아카이브(패턴별 " +
      "보유 날짜 포함)도 함께 냅니다. 대부분의 AI 가 응답을 150KB 안팎에서 자르고 잘린 JSON 은 " +
      "파싱되지 않습니다 — 큰 파일마다 소형 대체본이 카탈로그에 적혀 있으니 그쪽을 쓰세요.",
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
      // ★[2026-08-13] 날짜별 아카이브가 이 카탈로그에 **한 줄도 없었다.**
      //   서버 자기소개는 "없다고 결론내기 전에 get_data_urls() 를 부르라"고 말한다
      //   — 즉 이 도구가 완전성의 근거다. 그런데 최근 30영업일 시세 CSV·공시 CSV·
      //   시장요약 JSON 이 다 발행돼 있는데 여기서 그 존재를 말하지 않았다.
      //   "데이터가 있는데 도구가 그 존재를 말하지 않으면 소비자는 '없다'고 결론낸다"
      //   — 이 저장소 최초의 실사용자 신고가 정확히 그것이었다.
      //   보유 날짜를 **패턴별로** 함께 낸다. 다른 패턴의 날짜로 URL 을 조립하면
      //   404 가 나기 때문이다(실측 30일 중 22일 — 오늘 우리 쪽 도구가 그걸 냈다).
      const da = idx["daily_archive"] || {};
      let pats = Array.isArray(da["patterns"]) ? da["patterns"] : null;
      if (!pats) {
        // 옛 index.json(= patterns 발행 전) 대비 — 이름으로 짝을 짓는다.
        pats = Object.keys(da)
          .filter((k) => k.endsWith("_pattern"))
          .map((k) => {
            const key = k.slice(0, -"_pattern".length);
            const dates = da[key.replace(/_(csv|json)$/, "") + "_available_dates"] || [];
            return {
              key, url_pattern: da[k], available_dates: dates,
              n_dates: dates.length, from: dates[0] || null,
              to: dates[dates.length - 1] || null,
              date_means: (da["date_semantics"] || {})[key] || "",
            };
          });
      }
      if (pats.length) {
        out.push("");
        out.push("날짜별 아카이브(최근 30영업일 · 위 파일들의 과거분):");
        for (const p of pats) {
          const rng = p["n_dates"] ? `${p["n_dates"]}일 보유 ${p["from"]}~${p["to"]}` : "보유 0일";
          out.push(`- ${p["url_pattern"]} — ${rng}`);
          if (p["date_means"]) out.push(`    날짜 토큰의 뜻: ${p["date_means"]}`);
        }
        out.push("  ★패턴마다 보유 날짜가 다릅니다. 위 구간 밖 날짜는 404 입니다 — " +
          "전체 날짜 목록은 index.json 의 daily_archive.patterns[].available_dates.");
      }
      // ★[2026-08-17 P3-8] 필드 정의(JSON Schema)가 이 카탈로그에 **한 줄도 없었다.**
      //   이 도구가 완전성의 근거라고 서버 자기소개가 말하는데, 정작 스키마의 존재를
      //   말하지 않았다. 소비자는 필드 뜻을 추측하거나 "정의가 없다"고 결론낸다.
      //   ★손으로 적지 않는다 — index.json 의 schemas 배열을 그대로 흘려보낸다
      //     (sitegen 이 _PUBLIC_SCHEMAS 에서 생성한다). 개수도 여기서 센다.
      const schemas = Array.isArray(idx["schemas"]) ? idx["schemas"] : [];
      out.push("");
      if (schemas.length) {
        out.push(`필드 정의 (JSON Schema · ${idx["schemas_note"] || "draft 2020-12"}):`);
        for (const s of schemas) out.push(`- ${s}`);
      } else {
        out.push(`필드 정의(JSON Schema): ${ORIGIN}/data/public/schemas/`);
      }
      out.push("");
      out.push(`종목 하나만 필요하면 ${ORIGIN}/data/public/s/종목코드6.json (예: /s/005930.json)`);
      out.push(`AI 활용 안내·인용 정책: ${ORIGIN}/ai · ${ORIGIN}/llms.txt`);
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
      const notes = [];
      const limit = clampNum(args.limit, 1, 60, 15, "limit", notes);
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
      // ★★[2026-08-13 실측] 같은 착시가 다시 났다. get_earnings(code=005930) 이
      //   **완전히 같은 머리글** 두 줄을 낸다:
      //     20260730 접수 · 2026.06 기준 · 삼성전자 · 잠정 실적(연결)
      //       매출액 305.37조원(+98.7%) · 영업이익 146.73조원(+1191.6%)
      //     20260730 접수 · 2026.06 기준 · 삼성전자 · 잠정 실적(연결)
      //       매출액 305.37조원(+98.7%) · 영업이익 146.73조원(+1191.4%) · 순이익 118.85조원
      //   접수번호가 다른 **별개 공시 2건**인데(…077 · …103) 화면에는 그 사실이
      //   한 글자도 없다. 받는 쪽에는 '같은 회사·같은 기간의 모순된 값 2건'으로 보이고,
      //   실제로 get_stock 은 …077 을, 이 목록은 …103 을 먼저 집는다 — 같은 서버가
      //   같은 질문에 두 답을 주는 셈이다.
      //   이노스페이스 7건 때 배운 것과 같은 병이고(그때는 period 를 안 찍어서),
      //   그때처럼 값은 하나도 안 틀렸다. **구별할 단서를 안 준 것**이 전부다.
      //   데이터는 이미 알고 있다 — rcept_no 가 행마다 있다. 겹칠 때만 찍는다
      //   (늘 찍으면 열 줄짜리 목록이 스무 줄이 된다).
      const _key = (r) => [r["code"], r["period"], r["label"], r["basis"]].join("|");
      const _dup = {};
      for (const r of items.slice(0, limit)) _dup[_key(r)] = (_dup[_key(r)] || 0) + 1;
      let _dupSeen = 0;
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
        // ★[2026-08-11] vs 문자열 목록이었다. content_gate 가 행 단위 보류
        // (withheld_by_gate)를 내면 목록에 없어 "우리가 못 뽑았다"(failed)로 읽혔다 —
        // 일부러 뺀 것과 정반대다. 값을 뺀 자리엔 언제나 withheld_values 가 남으므로
        // 그 존재로 판정한다. sitegen._parse_status 와 같은 규칙이다.
        const st = x["parse_status"] || (
          (x["fact"] || hasNum) ? "ok"
            : (x["withheld_values"] || /^(withdrawn|withheld)/.test(vs)) ? "withdrawn"
            : vs === "no_values_in_filing" ? "no_values" : "failed");
        const WHY = {
          withdrawn: "⚠ 수치를 뽑았으나 회계 항등식을 어겨(예: 순이익>매출액) 발행에서 뺐습니다 — 원문 확인: ",
          no_values: "ℹ 이 공시에는 재무 수치가 없습니다(판매대수만 담은 잠정공시 등) — 원문: ",
          failed: "⚠ 수치를 뽑지 못했습니다(저희 결함) — 원문 확인: ",
        };
        // label 에 이미 "(연결)"이 들어 있는 경우가 있다 — 두 번 붙이지 않는다
        const lab = String(x["label"] || "");
        const bas = String(x["basis"] || "");
        // ★[2026-08-10 P0 · 실사용자 감사] **기간을 반드시 찍는다.**
        // 이노스페이스는 2024년 3분기~2026년 1분기 과거 보고서 7개를 하루에 재작성
        // 제출했다. 데이터에는 period 가 2026.03·2025.12·…·2024.09 로 정확히 들어
        // 있는데 렌더러가 그것을 버려서, 화면에는 「20260731 이노스페이스 · 정기 실적
        // 보고서(연결)」 일곱 줄이 매출만 다른 채(14억~27.5억, 최대 186배) 나왔다.
        // 읽는 쪽에서는 '같은 날 같은 회사의 모순된 실적 7건'으로 보인다.
        // 값은 하나도 안 틀렸다. 기간 라벨이 없어서 생긴 착시다.
        const per = String(x["period"] || "").trim();
        // 정정본 표기 — is_correction 은 disclosures.json 이 이미 계산해 둔 값이고
        // earnings.json 으로 옮기는 중이다(P1-G). 없으면 조용히 생략한다.
        const corr = x["is_correction"] === true ? " (기재정정)" : "";
        out.push("- " + x["rcept_dt"] + " 접수 · " + (per ? per + " 기준" : "기간 미상") +
          " · " + (x["name"] || "") + " · " + lab +
          (bas && lab.indexOf(bas) < 0 ? "(" + bas + ")" : "") + corr);
        out.push("  " + (st === "ok"
          ? (x["fact"] || "수치 미제공")
          : WHY[st] + (x["url"] || "")));
        // ★[2026-08-10 P1-A] 수치는 맞는데 **이상해 보이는** 경우를 미리 설명한다.
        // SK하이닉스처럼 순이익이 매출액보다 큰 건이 실재한다(영업외이익). 설명이
        // 없으면 받는 쪽이 "이 데이터 틀렸네"라고 판단하고 서비스를 떠난다 —
        // 실제로 그 판단이 자기 문서에 박제된 전례가 있다.
        if (x["value_note"]) out.push("  ℹ " + x["value_note"]);
        if (_dup[_key(x)] > 1) {
          _dupSeen++;
          out.push("  ↳ 접수번호 " + (x["rcept_no"] || "?") +
            (x["url"] ? " · " + x["url"] : ""));
        }
      }
      if (_dupSeen) {
        out.push("");
        out.push("★같은 종목·같은 기간·같은 유형인데 접수번호가 다른 줄이 있습니다 — " +
          "모순이 아니라 **별개 공시**입니다(정정·정오표·연결/별도 재제출 등).");
        out.push(" 값이 다르면 접수번호가 큰 쪽이 나중 접수이고, 항목이 더 많은 쪽이 " +
          "더 완전합니다. 확정은 위 DART 원문으로 하세요.");
      }
      // 잘랐으면 잘랐다고 말한다 — 8/14 반기 마감 주간에는 조회 결과가 limit 을
      // 훌쩍 넘는다. 안 말하면 받는 쪽은 그게 전부인 줄 안다.
      const _m = moreLine(items.length, Math.min(limit, items.length));
      if (_m) out.push(_m.replace(/^\n/, ""));
      out.push("");
      out.push("잠정치는 확정치가 아닙니다. 확정은 다음 정기보고서에서 확인하세요.");
      for (const n of notes) out.push("※ " + n);
      out.push("전체 원장(120일 롤링): " + ORIGIN + "/data/public/earnings.json");
      return out.join("\n") + footer(d["as_of"], src);
    },
  },
  {
    name: "get_history",
    title: "종목 일별 시세 1년 (Daily price history)",
    description:
      "Answers \"is this stock near its high or deep in a drawdown, and is volume unusual?\" — " +
      "250 trading days of daily CLOSES, plus period high/low, drawdown from the high, and volume " +
      "vs the 60-day average. Close-based (the upstream feed has no intraday high/low), so it will " +
      "differ from an HTS 52-week range. | \"고점 대비 얼마나 빠졌나·거래량이 평소보다 많나\"에 " +
      "답합니다 — 250거래일 **종가 기준** 고저·낙폭·거래량 배수. 장중 고저가 아니라 HTS 52주 " +
      "범위와 다를 수 있습니다.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "6-digit ticker | 6자리 종목코드" },
        days: { type: "number", description: "recent N days to list, default 20, max 60 — for all 250 rows read /data/public/s/{code}_history.json | 나열할 최근 일수(기본 20, **최대 60**. 250행 전체는 s/{code}_history.json)" },
      },
      required: ["code"],
    },
    run: async (args) => {
      const code = String(args.code ?? "").trim();
      if (!/^\d{6}$/.test(code)) throw userError("code 는 6자리 숫자여야 합니다. 예: 005930");
      const notes = [];
      const days = clampNum(args.days, 1, 60, 20, "days", notes);
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
      // ★[2026-08-10 P6-I] 계산이 아니라 라벨을 고친다. 원천이 금융위 T+1 종가셋이라
      // 구조적으로 종가 기준일 수밖에 없다. pykrx 장중 기준과 낙폭이 2.0pp 차이 난다.
      out.push("고저·낙폭은 **종가 기준**입니다 — 원천 데이터에 장중 고가·저가가 없어 " +
        "HTS 의 52주 고저(장중 기준)와 다를 수 있습니다. 창은 250거래일(약 12.5개월)입니다.");
      for (const n of notes) out.push("※ " + n);
      return out.join("\n") + footer(h["as_of"] || "", "/data/public/s/" + code + "_history.json");
    },
  },
  {
    name: "get_disclosure_impact",
    title: "공시 유형별 이후 주가 (Post-filing price path)",
    // ★[2026-08-10 P3-P] 첫 문장이 '어떤 질문에 답하는 도구인지'를 말해야 한다.
    // AI 는 이름과 첫 문장만 보고 고른다. 필드 나열은 고르는 데 도움이 안 된다.
    description:
      "Answers \"what usually happened after this kind of filing?\" — median MARKET-ADJUSTED return " +
      "at +1/+5 trading days per DART filing type, with 95% intervals, sample window and n. " +
      "A historical record, not a forecast. Not available from other free Korean sources. " +
      "Coverage: top-by-market-cap universe (see coverage in index.json), not the full listing. | " +
      "\"이 공시 나오면 보통 어땠나\"에 답합니다 — 공시 유형별로 접수 이후 1·5거래일 뒤까지 " +
      "시장 등락을 뺀 수익률 중앙값·95% 구간·표본기간. 과거 기록이며 예측·추천이 아닙니다.",
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
      const method = d["method"] || {};
      // ★[2026-08-10 P5-D] 완전일치 우선 → 부분일치 폴백. 지금까지 부분일치 전용이라
      // '무상증자'를 물으면 경제적 의미가 다른 '유·무상증자'까지 섞여 나왔고,
      // 그 사실이 문서 어디에도 없었다. 폴백이 발동하면 첫 줄에 밝힌다.
      let rows = all.filter((r) => String(r["label"]) === want);
      let fellBack = false;
      if (!rows.length) {
        rows = all.filter((r) => !want || String(r["label"]).indexOf(want) >= 0);
        fellBack = Boolean(want) && rows.length > 0;
      }
      if (!rows.length) {
        return "'" + want + "' 유형이 없습니다.\n가능한 유형: " +
          all.map((r) => r["label"]).join(" · ");
      }
      const HZ = { h1: "+1거래일", h5: "+5거래일", h20: "+20거래일" };
      const out = ["공시 유형별 이후 주가 경로 — 시장조정 수익률 중앙값"];
      out.push("과거 사실의 사후 집계입니다. 인과도, 예측도, 추천도 아닙니다.");
      if (fellBack) {
        out.push(`※ '${want}' 와 정확히 같은 유형이 없어 이름이 포함된 유형을 모았습니다: ` +
          rows.map((r) => r["label"]).join(" · "));
      }
      out.push("");
      // ★집계에서 통째로 뺀 유형 — 이건 결측이 아니라 자랑할 판단인데
      // 지금까지 사용자에게는 '수치 없음'으로만 전달됐다.
      const withheld = method["withheld_types"] || [];
      for (const r of rows) {
        out.push("[" + r["label"] + "]");
        if (withheld.indexOf(String(r["label"])) >= 0) {
          out.push("  ⛔ " + (method["withheld_reason"] ||
            "이 유형은 표본과 무관하게 집계하지 않습니다."));
          continue;
        }
        let shown = 0;
        for (const k of ["h1", "h5", "h20"]) {
          const c = r[k];
          if (!c) continue;
          if (!c["enough"]) {
            // 조용히 건너뛰면 "왜 +20이 없지?"에 아무도 답하지 못한다.
            // 도구 설명이 +20을 광고하던 시절의 혼란이 정확히 이것이었다.
            const need = method["min_sample"] || 20;
            out.push("  " + HZ[k] + ": 표본 부족(n=" + (c["n"] || 0) + " < 최소 " + need +
              ") — 관측 기간이 그 지평만큼 쌓이면 채워집니다.");
            continue;
          }
          shown++;
          const ci = c["median_ci95"] || [];
          const zero = c["ci_includes_zero"] ? "  ← 0을 포함(0과 구분되지 않음)" : "";
          out.push("  " + HZ[k] + ": " + pct(c["median_excess_pct"]) +
            " (95% " + pct(ci[0]) + "~" + pct(ci[1]) + ", n=" + c["n"] + ")" + zero);
          // ★up_ratio 를 버리고 있었다. 중앙값 +2.28%(95% 0.23~4.65)보다
          // "10건 중 7건 상승"이 비전문가에게 즉시 읽힌다. 데이터에 이미 있다.
          if (c["up_ratio_pct"] != null) {
            const uci = c["up_ratio_ci95"] || [];
            out.push("      상승 비율 " + c["up_ratio_pct"] + "% (" +
              Math.round((c["n"] || 0) * c["up_ratio_pct"] / 100) + "/" + c["n"] + "건" +
              (uci.length ? ", 95% " + uci[0] + "~" + uci[1] + "%" : "") + ")" +
              (c["up_ratio_ci_includes_50"] ? "  ← 50%를 포함(반반과 구분되지 않음)" : ""));
          }
          // ★표본기간. n 만 보여주면 13거래일 한 국면에 몰린 표본인지 알 수 없다.
          if (shown === 1 && c["base_date_from"]) {
            out.push("      표본기간 " + c["base_date_from"] + "~" + c["base_date_to"] +
              (c["n_filings"] != null && c["n_filings"] !== c["n"]
                ? " · 공시 " + c["n_filings"] + "건 중 시세가 붙은 " + c["n"] + "건" : ""));
          }
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
      // 관측 창이 짧으면 국면 효과와 공시 효과가 분리되지 않는다 — 그 사실을 숨기지 않는다.
      const anyWin = rows.map((r) => (r["h1"] || {})["base_date_from"]).filter(Boolean)[0];
      if (anyWin) {
        out.push("표본이 짧은 구간에 몰려 있으면 시장 국면 효과와 공시 효과가 분리되지 않습니다 — " +
          "위 표본기간을 반드시 함께 읽으세요.");
      }
      if (d["n_events_used"] != null && d["n_clusters"] != null &&
          d["n_events_used"] !== d["n_clusters"]) {
        out.push("같은 날 같은 종목이 여러 공시를 내면 각 유형에 같은 수익률이 들어갑니다 " +
          "(공시 " + d["n_events_used"] + "건 / 종목·날짜 묶음 " + d["n_clusters"] + "개).");
      }
      out.push("표 전체: " + ORIGIN + "/disclosure-impact");
      return out.join("\n") + footer(d["as_of"] || "", "/data/public/disclosure_impact_summary.json");
    },
  },
  // ★[2026-08-10 3호 F-4] 마감 주간에 들어오는 질문은 하나로 수렴한다 —
  // "누가 아직 안 냈나 / 오늘 누가 새로 냈나." 파일만 내고 도구가 없으면
  // 아무도 못 쓴다(이 서비스가 이미 여러 번 겪은 실패 모드다).
  {
    name: "get_earnings_calendar",
    title: "실적 캘린더 (Earnings calendar & new filings)",
    description:
      "Answers \"who has filed this quarter's results, who hasn't, and what came in since last time?\" " +
      "— filed / not-yet lists against the statutory deadline, plus a diff of filings new since the " +
      "previous publish. Built for stateless agents: polling this replaces a webhook. | " +
      "\"누가 냈고 누가 아직인가 · 지난번 이후 새로 뜬 건 뭔가\"에 답합니다. 법정 마감 D-day 와 " +
      "직전 발행 대비 신규 목록까지. 상태를 못 들고 다니는 에이전트를 위한 도구입니다.",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", description: "summary(기본) | not_yet(미접수 목록) | filed(접수 목록) | new(직전 발행 이후 신규)" },
        limit: { type: "number", description: "목록 최대 건수(기본 20, 최대 100)" },
      },
    },
    run: async (args) => {
      const notes = [];
      const limit = clampNum(args.limit, 1, 100, 20, "limit", notes);
      const view = String(args.view ?? "summary").trim().toLowerCase();
      const OK = ["summary", "not_yet", "filed", "new"];
      if (OK.indexOf(view) < 0) throw userError("view 는 다음 중 하나여야 합니다: " + OK.join(" | "));
      const cal = await fetchJson("/data/public/earnings_calendar.json");
      const out = [`실적 캘린더 — ${cal["period"] || "최근 분기"}`];
      // ★[2026-08-12] days_to_deadline 은 **발행 시점(매일 18:10)에 굳은 값**이라
      // 자정을 넘기는 순간 하루씩 틀린다. 08-12 아침에 사이트·이 응답이 모두 D-3 을
      // 말했고 실제로는 D-2 였다. 워커는 요청마다 도니 여기서 다시 세면 항상 맞는다.
      // 파일 값은 참고로만 두고, 어긋나면 그 사실까지 말한다 — 조용히 고치면
      // 파일을 직접 읽는 소비자는 여전히 틀린 값을 쓰게 된다.
      const dl = String(cal["deadline"] || "");
      let dd = cal["days_to_deadline"];
      let ddNote = "";
      if (/^\d{8}$/.test(dl)) {
        const due = Date.UTC(+dl.slice(0, 4), +dl.slice(4, 6) - 1, +dl.slice(6, 8));
        const k = new Date(Date.now() + 9 * 3600 * 1000);   // KST 기준 오늘
        const today = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate());
        const live = Math.round((due - today) / 86400000);
        if (dd != null && live !== dd) {
          ddNote = `  (파일의 days_to_deadline=${dd} 은 ${cal["as_of"] || "발행"} 시점 값입니다 — ` +
                   `직접 읽을 때는 deadline 에서 오늘 날짜를 빼서 세세요)`;
        }
        dd = live;
      }
      out.push(`- 법정 마감 ${cal["deadline"] || "?"}` +
        (dd == null ? "" : dd > 0 ? ` (D-${dd})` : dd === 0 ? " (오늘)" : ` (${-dd}일 지남)`));
      if (ddNote) out.push(ddNote);
      // ★[2026-08-12 5호 X-1] filed 를 한 덩어리로 말하면 안 된다. 실측 413 중
      //   정기 실적 보고서는 57건뿐이고 나머지 356건은 잠정 실적(공정공시)이다.
      //   합계만 주면 받는 쪽(사람도 LLM 도)이 "413곳이 반기보고서를 냈다"로 쓴다.
      // ★[2026-08-13] 여기서 잠정을 filed_preliminary_n 으로 쓰면 안 된다 — 그 수는
      //   잠정을 낸 곳 **전부**라 정기와 겹친다(대부분 7월 잠정 → 마감 직전 반기보고서).
      //   겹치는 두 수를 나란히 놓으면 받는 쪽이 더해서 유니버스를 넘긴다
      //   (실측 295 + 368 + 903 = 1,566 > 1,500). 겹치지 않는 분할만 준다.
      const _peri = cal["filed_periodic_n"];
      // ★[2026-08-13] '잠정 실적만'이라는 말은 **겹침을 뺀 수**가 발행됐을 때만
      //   할 수 있다. 새 키가 없는 스냅샷에서 filed_n - 정기 로 뺄셈하면 그 수는
      //   '가장 이른 접수가 잠정인 곳'이라, 그중 일부는 반기보고서도 냈다
      //   (배포 당일 실측 368 중 66곳). 말이 데이터보다 세면 그게 사고다 —
      //   구분이 없으면 '만'을 빼고 약하게 말한다.
      const _hasOnly = typeof cal["filed_preliminary_only_n"] === "number";
      const _prelOnly = _hasOnly
        ? cal["filed_preliminary_only_n"]
        : (typeof _peri === "number" ? (cal["filed_n"] - _peri) : null);
      const _prelWord = _hasOnly ? "잠정 실적만" : "잠정 실적(정기와 겹칠 수 있음)";
      const _both = cal["filed_both_n"], _notPeri = cal["not_yet_periodic_n"];
      if (typeof _peri === "number") {
        out.push(`- 유니버스 ${fmt(cal["universe_n"])}종목 중 실적 공시 접수 ${fmt(cal["filed_n"])}` +
          ` (반기·분기 정기보고서 ${fmt(_peri)} · ${_prelWord} ${fmt(_prelOnly)}) · 어느 쪽도 없음 ${fmt(cal["not_yet_n"])}`);
        if (typeof _both === "number" && _both > 0) {
          out.push(`  정기보고서를 낸 ${fmt(_peri)}곳 중 ${fmt(_both)}곳은 앞서 잠정 실적도 냈습니다.`);
        }
        if (typeof _notPeri === "number") {
          out.push(`  반기보고서만 놓고 보면 아직 접수가 확인되지 않은 곳은 ${fmt(_notPeri)}곳입니다` +
            `(그중 ${fmt(_prelOnly)}곳은 잠정 실적은 냈습니다) — '어느 쪽도 없음'과 다른 수입니다.`);
        }
        out.push("  ※ '반기보고서를 낸 곳'은 정기보고서 쪽 수입니다 — 합계를 그 뜻으로 쓰지 마세요.");
      } else {
        // ★[2026-08-13] 이 대체 경로가 바로 X-1 이 고치려던 그 문장을 그대로 내고
        //   있었다. "접수 413"이 "반기보고서 법정 기한" 바로 아래 붙으면 받는 쪽은
        //   "413곳이 반기보고서를 냈다"로 읽는다 — 그 합계는 정기 보고서와 잠정
        //   실적(공정공시)을 섞은 수다. 웹은 고쳤는데 도구의 대체 경로는 안 고쳐서
        //   기계 쪽에만 틀린 말이 남아 있었다(실측: 오늘 16:40 라이브 응답).
        //   구분값이 없으면 **없다고 말한다.** 숫자를 지어내지도, 조용히 넘기지도 않는다.
        out.push(`- 유니버스 ${fmt(cal["universe_n"])}종목 중 실적 공시 접수 ` +
          `${fmt(cal["filed_n"])} · 어느 쪽도 없음 ${fmt(cal["not_yet_n"])}`);
        out.push("  ※ 이 스냅샷에는 정기/잠정 구분값이 없습니다. 이 합계는 정기 실적 " +
          "보고서와 잠정 실적을 **섞은 수**이므로 '반기보고서를 낸 곳'으로 쓰지 마세요.");
      }
      // ★[2026-08-12] '아직 없음'은 유니버스 − 접수분이라, 그날 DART 목록 수집이
      //   끊기면 못 본 회사가 그대로 이 숫자에 들어간다. 발행 쪽이 collection_complete
      //   로 알려 주므로, 거짓일 때는 **숫자를 말한 바로 그 자리에서** 못 믿는다고
      //   말한다. 각주로 밀어 두면 인용은 숫자만 떠서 나간다.
      if (cal["collection_complete"] === false) {
        out.push("  ★이 숫자를 인용하지 마세요 — 이번 수집이 완결되지 않아 '아직 없음'이");
        out.push("   과대계상입니다(그중 일부는 이미 접수된 건). 확정은 DART 원문으로.");
      }
      // ★[2026-08-12] 수집이 완결됐어도 '아직 없음'이 과대계상될 수 있다: 공시는
      //   잡혔는데 실적 파서가 그 건을 아직 못 읽은 경우다. 발행 쪽이 그 수를
      //   내주므로, 0 이 아닐 때만 **숫자를 말한 그 자리에서** 함께 말한다.
      //   (8/13~14 반기 마감 이틀에 미접수 1,087곳이 몰린다 — 그때 벌어지는 값이다.)
      const _gapN = cal["seen_filing_not_parsed_n"];
      if (typeof _gapN === "number" && _gapN > 0) {
        out.push(`  ※ 그중 ${fmt(_gapN)}종목은 이번 분기 실적 공시가 이미 잡혔는데`);
        out.push("   실적 파싱이 아직 안 끝난 것입니다 — '접수 없음'과 다릅니다.");
        for (const r of (cal["seen_filing_not_parsed"] || []).slice(0, 5)) {
          out.push(`     ${r["name"] || ""}(${r["code"] || ""}) ${r["rcept_dt"] || ""} ${r["label"] || ""}`);
        }
      }
      // ★★[2026-08-13] 마감 **다음 날**부터 같은 문장의 뜻이 바뀐다. 마감 전
      //   "어느 쪽도 없음 1,087"은 중립이지만(아직 시간이 있다), 마감이 지나면
      //   "기한 내 미제출 1,087곳"으로 읽힌다 — 이 서버는 그 판정을 할 수 없다.
      //   웹 쪽은 같은 날 고쳤다. 도구도 같이 고친다: 오늘 아침 X-1 을 한 면만
      //   고쳐 놓고 기계 쪽에 틀린 말이 남아 있던 것을 그대로 반복하지 않는다.
      //   dd 는 위에서 **오늘 날짜로 다시 센 값**이라 파일이 낡아도 옳다.
      if (typeof dd === "number" && dd < 0) {
        out.push("  ★법정 기한이 지났습니다 — 위 '어느 쪽도 없음'을 '기한 내 미제출'로");
        out.push("   쓰지 마세요. 결산월이 12월이 아니어서 기한 자체가 다른 법인, 접수는");
        out.push("   됐으나 실적 파싱이 안 끝난 건, 분류 밖 유형이 섞여 있습니다.");
        out.push("   미제출 판정은 DART 원문으로만 가능합니다.");
      }
      out.push(`  ${cal["deadline_note"] || ""}`);
      out.push("");
      if (view === "new") {
        const nd = await fetchJson("/data/public/new_since_yesterday.json");
        const it = nd["items"] || [];
        out.push(`[직전 발행 이후 신규 ${fmt(nd["count"])}건]` +
          (nd["first_run"] ? " ※ 첫 실행이라 전체를 신규로 봅니다" : ""));
        out.push(`  기준: ${nd["note"] || ""}`);
        for (const x of it.slice(0, limit)) {
          out.push(`- ${x["rcept_dt"] || ""}${x["receipt_time"] ? " " + x["receipt_time"] : ""} ` +
            `${x["name"] || ""} · ${x["label"] || ""}${x["period"] ? ` · ${x["period"]} 기준` : ""}`);
          if (x["fact"]) out.push("  " + x["fact"]);
        }
        if (it.length > limit) out.push(`... 외 ${it.length - limit}건`);
        for (const n of notes) out.push("※ " + n);
        return out.join("\n") + footer(nd["as_of"] || "", "/data/public/new_since_yesterday.json");
      }
      if (view === "not_yet" || view === "filed") {
        const rows = cal[view] || [];
        out.push(`[${view === "not_yet" ? "아직 접수가 확인되지 않은 종목" : "접수 완료 종목"} ${fmt(rows.length)}]`);
        for (const x of rows.slice(0, limit)) {
          out.push(view === "not_yet"
            ? `- ${x["name"]} (${x["code"]}) ${x["market"] || ""}`
            : `- ${x["rcept_dt"]} ${x["name"]} (${x["code"]}) · ${x["label"] || ""}`);
        }
        if (rows.length > limit) out.push(`... 외 ${rows.length - limit}종목`);
      } else {
        out.push("view='not_yet' 로 아직 안 낸 종목, 'filed' 로 낸 종목, 'new' 로 직전 발행 이후 신규를 봅니다.");
      }
      out.push("");
      // ★'안 냈다'가 아니라 '우리 수집 범위에 아직 없다' — 이 구분을 흐리면
      // 사용자가 회사를 잘못 판단한다. 캘린더가 사실을 넘어서면 안 된다.
      out.push(cal["caveat"] || "");
      out.push("결산월이 12월이 아닌 법인은 마감이 다릅니다. 확정은 DART 원문으로 확인하세요.");
      for (const n of notes) out.push("※ " + n);
      return out.join("\n") + footer(cal["as_of"] || "", "/data/public/earnings_calendar.json");
    },
  },
  // ★[2026-08-10 P5-C · 실사용자 감사] **공시 조회 전용 도구가 0개였다.**
  //
  // 접수 시각(HH:MM)이 이 서비스의 자랑인데(공개 API 어디에도 없다) 정작 공시를
  // 직접 묻는 도구가 없었다. get_today 가 TOP3 를 곁들일 뿐이다.
  //
  // 그리고 장중 파일에는 함정이 하나 있다. 수집이 하루 한 번(15:00)이라
  // **매 거래일 09:00~15:00 동안은 항상 전 거래일 수집본이 서빙된다** — 하루 여섯
  // 시간, 정확히 '장중 공시'가 쓸모 있는 그 시간대다. 그 사실을 응답 첫 줄에 밝힌다.
  {
    name: "get_disclosures",
    title: "공시 목록 (Disclosures with receipt times)",
    description:
      "Answers \"what was filed, and when exactly?\" — DART filings with RECEIPT TIME (HH:MM) and " +
      "session (pre-open / intraday / after-close), filterable by date, type and importance. " +
      "The receipt time is not exposed by any public Korean API. Roughly 40% of filings arrive " +
      "AFTER the close, so that day's price move is not a reaction to them. date=today serves the " +
      "15:00 intraday collection (no importance scores yet); any other date serves the ranked list " +
      "of the last 7 days. | " +
      "\"무슨 공시가 몇 시에 났나\"에 답합니다 — 접수 시각(HH:MM)과 장 구분까지. " +
      "공개 API 어디에도 없는 값입니다. 날짜·유형·중요도로 거를 수 있습니다. " +
      "접수분의 **40% 안팎이 장 마감 후**라 그날 등락은 그 공시의 반응이 아닙니다. " +
      "date=오늘이면 15:00 장중 수집본(아직 중요도 점수 없음), 다른 날짜면 최근 7일 상위 목록입니다.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYYMMDD. 오늘이면 장중 수집본, 아니면 최근 7일 상위 목록 | today for intraday" },
        session: { type: "string", description: "pre_open | intraday | after_close" },
        label: { type: "string", description: "공시 유형 부분일치(예: 배당, 자사주)" },
        min_score: { type: "number", description: "중요도 점수 하한(장중 수집본에는 점수가 없습니다)" },
        limit: { type: "number", description: "최대 건수(기본 20, 최대 100)" },
      },
    },
    run: async (args) => {
      const notes = [];
      const limit = clampNum(args.limit, 1, 100, 20, "limit", notes);
      const wantDate = String(args.date ?? "").trim().replace(/-/g, "");
      const wantSess = String(args.session ?? "").trim();
      const wantLabel = String(args.label ?? "").trim();
      const minScore = args.min_score != null ? Number(args.min_score) : null;

      // 장중 파일은 '오늘'을 물었을 때만 쓴다. 그 밖에는 본발행 상위 목록이 낫다
      // (장중본에는 score 가 없어 '중요한 것만'이 성립하지 않는다).
      let src = "/data/public/disclosures_top100.json";
      let doc = await fetchJson(src);
      let items = doc["items"] || doc["events"] || [];
      let head = "주요 공시(최근 7일 · 중요도 상위)";
      let intraday = false;
      if (wantDate) {
        const idoc = await fetchJson("/data/public/disclosures_intraday.json").catch(() => null);
        const ibase = String((idoc || {})["기준일"] || "").replace(/-/g, "");
        if (idoc && ibase === wantDate) {
          doc = idoc; src = "/data/public/disclosures_intraday.json";
          items = doc["items"] || []; intraday = true;
          head = `장중 공시 수집본 — 기준일 ${isoDate(doc["기준일"])}`;
        } else {
          items = items.filter((x) => String(x["rcept_dt"] || "") === wantDate);
          head = `주요 공시 — ${wantDate}`;
        }
      }
      const before = items.length;
      if (wantSess) items = items.filter((x) => String(x["session"] || "") === wantSess);
      if (wantLabel) items = items.filter((x) => String(x["label"] || "").indexOf(wantLabel) >= 0);
      if (minScore != null) items = items.filter((x) => (x["score"] ?? -1) >= minScore);

      const out = [head];
      if (intraday) {
        // ★함정을 먼저 말한다. 이 한 줄이 없으면 장중에 물어본 사람이
        // 전 거래일 목록을 오늘 것으로 읽는다.
        out.push(`수집 시각 ${doc["generated_kst"] || "미기록"} — 수집은 매 거래일 15:00 한 번입니다. ` +
          "그 이전 시간에 물으면 **직전 수집본**이 나옵니다.");
        if (doc["error"]) out.push(`⚠ 이 수집본에 오류가 기록돼 있습니다: ${doc["error"]}`);
        out.push("장중 수집본에는 중요도 점수가 없습니다 — 점수로 거르려면 date 를 빼고 부르세요.");
      }
      out.push("");
      if (!items.length) {
        out.push(before ? `조건에 맞는 공시가 없습니다(필터 전 ${before}건).`
                        : "이 기준일에 수집된 공시가 없습니다.");
        out.push("유형 목록은 get_disclosure_impact() 로, 전체는 " + ORIGIN + "/data/public/disclosures.json");
        for (const n of notes) out.push("※ " + n);
        return out.join("\n") + footer(doc["기준일"] || doc["as_of"] || "", src);
      }
      for (const x of items.slice(0, limit)) {
        const t = x["receipt_time"] ? ` ${x["receipt_time"]}` : "";
        const se = x["session"] && x["session"] !== "unknown" ? ` · ${x["session"]}` : "";
        const sc = x["score"] != null ? ` · 중요도 ${x["score"]}` : "";
        out.push(`- ${x["rcept_dt"] || ""}${t}${se} ${x["name"] || ""} · ${x["label"] || ""}${sc}`);
        if (x["fact"]) out.push("  " + x["fact"]);
        else if (x["title"]) out.push("  " + x["title"]);
        // ★[2026-08-12] 소형판(disclosures_top100.json)은 유형별 값을 항목마다
        //   복사하지 않고 by_label 에 한 번만 싣는다(그 복사가 파일의 58% 였고,
        //   그래서 잘림 방지용 파일이 도리어 문턱 150KB 를 넘고 있었다).
        //   항목에 있으면 그것, 없으면 label 로 찾는다 — 두 판본 다 읽는다.
        const _bl = (doc["by_label"] || {})[x["label"]] || {};
        const _il = impactLine(x["type_impact"] || _bl["type_impact"]);
        if (_il) out.push(_il);
        if (x["url"] || x["dart_url"]) out.push("  " + (x["url"] || x["dart_url"]));
      }
      // 전체 건수까지 같이 말한다(공통 헬퍼) — 남은 수만 알려주면 얼마나 큰
      // 모집단을 보고 있는지 모른 채 limit 을 더듬게 된다.
      const _md = moreLine(items.length, Math.min(limit, items.length));
      if (_md) out.push(_md.replace(/^\n/, ""));
      out.push("");
      out.push("접수 시각은 DART 최근공시 목록(dsac001)에서만 얻을 수 있는 값입니다 — " +
        "공개 API·개별 뷰어·공시검색에는 날짜만 있습니다.");
      out.push("session: pre_open(~09:00) · intraday(09:00~15:30) · after_close(15:30~). " +
        "장 마감 후 접수라면 그날 주가 움직임은 통째로 공시보다 **앞선** 것입니다.");
      for (const n of notes) out.push("※ " + n);
      return out.join("\n") + footer(doc["기준일"] || doc["as_of"] || "", src);
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
          description: "cap(시총 큰 순, 기본) | multiple(배수 낮은 순) | change(등락률 높은 순) | turnover(거래대금 큰 순) | drawdown(낙폭 큰 순)",
        },
        limit: { type: "number", description: "최대 건수(기본 20, 최대 100)" },
        // ★[2026-08-10 P5-B · 실사용자 감사] 거래대금(소외주) 필터.
        // 재료는 screen.json 1,500행에 value_traded_krw 로 **이미 전부** 채워져 있는데
        // 이 도구에 파라미터도 sort 옵션도 없었다. 지난 지시서의 실사용 예
        // "흑자전환 → 배수 10배 이하 → 소외"가 호출 한 번으로 끝나게 된다.
        max_turnover_pctile: {
          type: "number",
          description: "거래대금 백분위 상한(0~100). 예: 30 이면 거래대금 하위 30% — 소외주",
        },
        min_turnover_pctile: {
          type: "number",
          description: "거래대금 백분위 하한(0~100). 예: 70 이면 거래대금 상위 30%",
        },
        // ★[2026-08-10 P5-A] 고점 대비 낙폭. get_history 는 종목별로 이미 계산해
        // 주는데 벌크로 거를 방법이 없어, 전 종목 낙폭을 구하려면 시계열을 1,463회
        // 받아야 했다(약 20분). 이제 screen.json 에 열로 들어 있다.
        min_drawdown_pct: {
          type: "number",
          description: "고점 대비 낙폭 하한(%, 양수로). 예: 30 이면 250거래일 최고 종가 대비 30% 이상 하락한 종목만",
        },
        max_drawdown_pct: {
          type: "number",
          description: "고점 대비 낙폭 상한(%, 양수로). 예: 10 이면 고점 근처(10% 이내)만",
        },
      },
    },
    run: async (args) => {
      const F = String(args.filter ?? "turnaround").trim().toLowerCase();
      const OK = ["turnaround", "new_high", "new_low", "growth", "quiet", "all"];
      if (OK.indexOf(F) < 0) {
        throw userError("filter 는 다음 중 하나여야 합니다: " + OK.join(" | "));
      }
      const notes = [];
      const limit = clampNum(args.limit, 1, 100, 20, "limit", notes);
      const maxMul = Number(args.max_multiple) || null;
      const minCap = args.min_cap_eok != null ? Number(args.min_cap_eok) * 1e8 : null;
      const maxCap = args.max_cap_eok != null ? Number(args.max_cap_eok) * 1e8 : null;
      // 범위가 뒤집힌 조합은 "0종목"이 아니라 무엇이 문제인지 말해야 한다.
      // 지금은 조용히 빈 결과를 주고 사용자는 조건이 까다로운 줄 안다.
      if (minCap != null && maxCap != null && minCap > maxCap) {
        throw userError(`min_cap_eok(${args.min_cap_eok}) 이 max_cap_eok(${args.max_cap_eok}) 보다 큽니다 — 범위가 뒤집혔습니다.`);
      }
      const loP = args.min_turnover_pctile != null
        ? clampNum(args.min_turnover_pctile, 0, 100, 0, "min_turnover_pctile", notes) : null;
      const hiP = args.max_turnover_pctile != null
        ? clampNum(args.max_turnover_pctile, 0, 100, 100, "max_turnover_pctile", notes) : null;
      if (loP != null && hiP != null && loP > hiP) {
        throw userError(`min_turnover_pctile(${loP}) 이 max_turnover_pctile(${hiP}) 보다 큽니다 — 범위가 뒤집혔습니다.`);
      }
      const ddMin = args.min_drawdown_pct != null
        ? clampNum(args.min_drawdown_pct, 0, 100, 0, "min_drawdown_pct", notes) : null;
      const ddMax = args.max_drawdown_pct != null
        ? clampNum(args.max_drawdown_pct, 0, 100, 100, "max_drawdown_pct", notes) : null;
      if (ddMin != null && ddMax != null && ddMin > ddMax) {
        throw userError(`min_drawdown_pct(${ddMin}) 이 max_drawdown_pct(${ddMax}) 보다 큽니다 — 범위가 뒤집혔습니다.`);
      }
      const sort = String(args.sort ?? "cap").trim().toLowerCase();

      let d;
      try {
        d = await fetchJson("/data/public/screen.json");
      } catch (e) {
        return "조건 검색 재료가 아직 발행되지 않았습니다. 전체 시세는 " +
          ORIGIN + "/data/public/quotes.json 을 쓰세요.";
      }
      // rows: [code,name,market,cap,close,pct,value,opAnn,mult,turn,growth,quiet,hi,lo]
      // [2026-08-10 P5-A] 14~20 이 새로 붙었다 — 기존 인덱스는 그대로 두었으므로
      // 옛 소비자는 깨지지 않는다.
      const I = { code: 0, name: 1, mkt: 2, cap: 3, close: 4, pct: 5, val: 6,
                  op: 7, mult: 8, turn: 9, growth: 10, quiet: 11, hi: 12, lo: 13,
                  w52hi: 14, w52lo: 15, dd: 16, upLo: 17, fiscal: 18, basis: 19 };
      const PICK = {
        turnaround: (r) => r[I.turn],
        new_high: (r) => r[I.hi],
        new_low: (r) => r[I.lo],
        growth: (r) => r[I.growth],
        quiet: (r) => r[I.quiet],
        all: () => true,
      };
      const ALL = d["rows"] || [];
      let rows = ALL.filter(PICK[F]);
      const nMatched = rows.length;
      if (maxMul != null) rows = rows.filter((r) => r[I.mult] != null && r[I.mult] <= maxMul);
      if (minCap != null) rows = rows.filter((r) => (r[I.cap] || 0) >= minCap);
      if (maxCap != null) rows = rows.filter((r) => (r[I.cap] || 0) <= maxCap);
      // ★[2026-08-10 P5-B] 거래대금 백분위. 컷 금액을 함께 알려준다 — "하위 30%"만
      // 말하면 그게 얼마인지 몰라 결과를 검산할 수 없다.
      let cutLo = null, cutHi = null;
      if (loP != null || hiP != null) {
        const vals = ALL.map((r) => r[I.val]).filter((v) => typeof v === "number").sort((a, b) => a - b);
        const at = (q) => (vals.length ? vals[Math.min(vals.length - 1,
          Math.max(0, Math.round(q / 100 * (vals.length - 1))))] : null);
        cutLo = loP != null ? at(loP) : null;
        cutHi = hiP != null ? at(hiP) : null;
        rows = rows.filter((r) => {
          const v = r[I.val];
          if (typeof v !== "number") return false;   // 거래대금을 모르면 이 필터에서 제외
          if (cutLo != null && v < cutLo) return false;
          if (cutHi != null && v > cutHi) return false;
          return true;
        });
      }
      if (ddMin != null || ddMax != null) {
        rows = rows.filter((r) => {
          const d0 = r[I.dd];                    // 음수(-36.41 = 36.41% 하락)
          if (typeof d0 !== "number") return false;
          const fall = -d0;                      // 양수로 뒤집어 비교한다
          if (ddMin != null && fall < ddMin) return false;
          if (ddMax != null && fall > ddMax) return false;
          return true;
        });
      }
      const nAfter = rows.length;

      const KEY = {
        cap: (r) => -(r[I.cap] || 0),
        multiple: (r) => (r[I.mult] == null ? Infinity : r[I.mult]),
        change: (r) => -(r[I.pct] == null ? -Infinity : r[I.pct]),
        turnover: (r) => -(r[I.val] || 0),
        drawdown: (r) => (typeof r[I.dd] === "number" ? r[I.dd] : Infinity),
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
        const dd = typeof r[I.dd] === "number" ? " · 고점 대비 " + r[I.dd] + "%" : "";
        out.push("- " + r[I.name] + " (" + r[I.code] + ") " + (r[I.mkt] || ""));
        out.push("  종가 " + fmt(r[I.close]) + "원 (" + pct(r[I.pct]) + ") · 시총 " +
          eok(r[I.cap]) + " · " + mul + dd);
      }
      if (nAfter > limit) out.push("");
      if (nAfter > limit) out.push("... 외 " + (nAfter - limit) + "종목 (limit 를 올리거나 조건을 좁히세요)");
      out.push("");
      out.push("배수는 시가총액 ÷ 연환산 영업이익입니다(분기 누적을 1년치로 환산). " +
        "PER 이 아니며 영업이익 기준입니다. 영업이익이 0 이하면 산출하지 않습니다.");
      if (cutLo != null || cutHi != null) {
        const fmtCut = (v) => (v == null ? "-" : eok(v));
        out.push("거래대금 컷: " +
          (cutLo != null ? `하한 ${loP}%ile = ${fmtCut(cutLo)} 이상` : "") +
          (cutLo != null && cutHi != null ? " · " : "") +
          (cutHi != null ? `상한 ${hiP}%ile = ${fmtCut(cutHi)} 이하` : "") +
          " (모집단 시총 상위 유니버스 기준)");
      }
      // ★[2026-08-10 P5-E] 배수가 어느 보고서 기준인지 밝힌다. 7/30 에 접수된 반기
      // 잠정(영업이익 146.73조)을 반영하지 않아 삼성전자가 5.9배로 나오는데, 잠정
      // 기준이면 4.6배다 — 22% 차이다. 서버가 "최신 수치는 get_earnings 로"라고
      // 안내하므로 그 안내를 따른 사용자는 146조를 본 뒤 5.9배를 보고 같은 기준이라 믿는다.
      out.push("배수 산정 기준: **정기보고서만** 사용합니다(잠정 실적 미반영) — " +
        "잠정치는 get_earnings(code) 로 따로 확인하세요.");
      for (const n of notes) out.push("※ " + n);
      out.push("기계 산정이고 추천이 아닙니다. 원자료: " + ORIGIN + "/data/public/screen.json");
      return out.join("\n") + footer(d["as_of"], "/data/public/screen.json");
    },
  },
];

// ★[2026-08-31 · 9호 DATA-65] 랭킹을 주면서 **어느 기수의 재무인지** 말하지 않았다.
//   "성장 랭킹 알려줘" 에 AI 가 받는 것에 기수가 없으면 두 가지를 못 답한다 —
//   ① 이 숫자가 2026H1 인지 2026Q1 인지 ② **왜 매일 같은지**(시세를 안 쓰기 때문).
//   기수는 이미 `rankings.json` 의 `fin_basis` 에 있다. 손으로 적지 않고 거기서 읽는다.
//   ★못 읽으면 **아무 말도 안 한다** — 틀린 기수를 말하는 것보다 낫다({N_EVENTS} 와 같은 판단).
function finBasisLine(d) {
  const fb = (d && d["fin_basis"]) || {};
  const per = fb["latest_expected"];
  if (!per) return "";
  const n = fb["n_at_latest"];
  const tail = Number.isFinite(Number(n)) ? ` (그 기수를 보유한 종목 ${fmt(n)}개)` : "";
  return `\n재무 기수: ${per}${tail} — 정기보고서 실측입니다. ` +
    "기수가 바뀌지 않으면 순위도 바뀌지 않습니다(시세를 쓰지 않습니다).";
}

// ── JSON-RPC 2.0 처리 ─────────────────────────────────────────────────────
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message, data) => ({
  jsonrpc: "2.0",
  id: id === undefined ? null : id,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

// ★[2026-08-12 5호 U-4] 자기소개에 **손으로 적은 수**가 있었다 — "833 events".
//   실제 n_events_used 는 989 다(그날 989/원장은 매 거래일 늘어난다). 서버가
//   자기를 소개하면서 사실을 틀리는 것은 이 데이터셋이 파는 것(정확성) 자체를
//   깎는다. 발행물이 그 수를 이미 내고 있으니 읽어서 채운다.
//   ★못 읽으면 **숫자를 지운다**(옛 수를 남기지 않는다). 모르는 것보다 틀린 것이 나쁘다.
// ★[2026-08-28] 같은 부류를 하나 더 찾았다 — 자기소개가 **"for KOSPI/KOSDAQ"** 이라고
//   손으로 적고 있었다. 전종목 전환으로 KONEX 106종목이 실제로 발행되는데, 이 서버는
//   자기를 소개하면서 싣지 않는다고 말하고 있었다. 발행물이 이제 그 목록을 낸다
//   (`index.json` 의 `coverage.markets_label`) — 읽어서 채운다.
//   ★못 읽으면 **옛 값을 쓰지 않는다.** 시장 이름을 아예 빼고 "Korean equities" 로
//     말한다 — 모르는 것보다 틀린 것이 나쁘다({N_EVENTS} 와 같은 판단).
async function marketsLabel() {
  try {
    const d = await fetchJson("/data/public/index.json");
    const lab = d && d.coverage && d.coverage.markets_label;
    if (typeof lab === "string" && lab.length) return lab;
  } catch (e) { /* 아래 폴백 */ }
  return "";
}

async function instructionsText() {
  const mk = await marketsLabel();
  let t = INSTRUCTIONS;
  t = mk ? t.replace(/\{MARKETS\}/g, mk)
         : t.replace("for {MARKETS}.", "for Korean equities.")
            .replace(/\{MARKETS\}/g, "Korean equities");
  try {
    const d = await fetchJson("/data/public/disclosure_impact_summary.json");
    const n = d && d["n_events_used"];
    if (typeof n === "number" && n > 0) {
      return t.replace(/\{N_EVENTS\}/g, n.toLocaleString("en-US"));
    }
  } catch (e) { /* 아래 폴백 */ }
  return t
    .replace("({N_EVENTS} events with receipt timestamp and session)",
      "(per-event rows carry receipt timestamp and session)")
    .replace("원장 {N_EVENTS}건(접수 시각·세션 포함)", "원장(접수 시각·세션 포함)")
    .replace(/\{N_EVENTS\}/g, "");
}

// ★[2026-08-17 P3-8] 첫 악수에서 데이터셋을 소개한다.
//
// initialize 는 클라이언트가 **반드시 한 번 부르는** 자리다. 여기서 카탈로그·스키마·
// 라이선스·기준일을 주면, 소비자는 도구를 부르기 전에 "이 서버가 무엇을 가졌고
// 인용해도 되는가"를 안다. 지금까지 그 답은 index.json 안에만 있었고, MCP 로 들어온
// 쪽에서는 그 파일의 존재조차 몰랐다.
//
// ★손으로 적지 않는다 — 전부 index.json 에서 읽는다(schemas 배열은 sitegen 이
//   _PUBLIC_SCHEMAS 에서 생성한다). fetchJson 이 10분 캐시라 추가 비용이 거의 없다.
// ★못 읽어도 initialize 는 성공해야 한다. 메타 하나 때문에 연결 자체가 실패하면
//   그게 더 큰 사고다 — 못 읽으면 주소만이라도 준다(지어내지 않는다).
async function datasetMeta() {
  const base = {
    catalog: `${ORIGIN}/data/public/index.json`,
    schemas_base: `${ORIGIN}/data/public/schemas/`,
    openapi: `${ORIGIN}/openapi.json`,
  };
  try {
    const idx = await fetchJson("/data/public/index.json");
    const lic = idx["license"] || {};
    return {
      ...base,
      schema_version: idx["schema_version"] || null,
      schemas: Array.isArray(idx["schemas"]) ? idx["schemas"] : [],
      schemas_note: idx["schemas_note"] || "",
      openapi: idx["openapi"] || base.openapi,
      license: lic["name"] || null,
      license_url: lic["url"] || null,
      citation: idx["citation"] || null,
      as_of: isoDate(idx["as_of"] || idx["quote_basis_date"] || ""),
      note: "스냅샷입니다(실시간 아님). 각 응답의 기준일을 그대로 인용하세요.",
    };
  } catch (e) {
    // 숫자도 목록도 지어내지 않는다 — 주소만 준다.
    return { ...base, schemas: [], note: "카탈로그를 읽지 못했습니다 — 위 주소를 직접 확인하세요." };
  }
}

async function doInitialize(params) {
  const requested = params.protocolVersion;
  const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : LATEST_VERSION;
  const [instructions, dataset] = await Promise.all([instructionsText(), datasetMeta()]);
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions,
    dataset,
  };
}

// ★[2026-08-10 P1-E · 실사용자 감사] 발행 지연을 **응답 맨 앞**에서 알린다.
//
// 8월 7일 시세가 통째로 없고(daily/quotes_20260807.csv → 404) index.json 이
// publish_status='degraded' 를 내고 있었는데, 도구 10개 중 아무도 그 사실을
// 말하지 않고 "기준일 20260806" 한 줄만 찍었다. 정작 index.json 의 note 는
// 소비자에게 "stale/delayed 면 답변에 데이터 지연을 먼저 밝힐 것"이라고 지시한다.
// 우리가 우리 지시를 안 지킨 셈이다.
//
// 푸터가 아니라 헤더에 넣는다 — AI 는 앞부분을 더 신뢰하고, 뒤는 자주 잘린다.
// 도구 10개를 각각 고칠 필요는 없다. 디스패처 한 곳이면 된다.
//
// 문구는 '이번 발행이 실패했다'고 말하지 않는다. 그 둘은 다른 질문이다
// (gates_passed 가 전부 통과여도 최근 이력은 나쁠 수 있다). 사실만 적는다.
// ★[2026-08-11 4호 W-3] 문제가 있을 때만 말하던 것을 **항상 말하게** 바꾼다.
//
// 종전에는 지연·실패일 때만 배너가 붙고 정상일 때는 아무 말도 안 했다. 그런데
// 에이전트에게 "아무 말 없음"은 **"확인했더니 최신"과 구별되지 않는다.** 응답에
// "기준일: 20260807" 만 있으면 그게 오늘 것인지 나흘 전 것인지 판단할 근거가 없다.
// 침묵을 정상 신호로 쓰면, 배너 로직이 고장난 날과 정상인 날이 똑같아 보인다.
//
// 그리고 공시 축(disclosure_through)이 어디에도 없었다. 이 서비스는 시세와 공시가
// **서로 다른 날짜**로 움직이는데(T+1 확정가 vs 당일 접수) 한쪽만 말해 왔다.
//
// 한 줄로 끝낸다. 12개 도구 × 모든 응답에 붙는 자리라 길면 그 자체가 비용이다.
async function staleBanner() {
  try {
    const ix = await fetchJson("/data/public/index.json");
    const fr = ix["freshness"] || {};
    const pl = ix["pipeline"] || {};
    const bits = [];
    const qa = fr["quote_as_of_iso"] || fr["quote_as_of"];
    const dt = fr["disclosure_through"];
    const lf = pl["last_failure_date"];
    // 시세 기준일보다 뒤에 실패가 있었다 = 그 거래일이 반영되지 않았다는 뜻.
    // 날짜 문자열 비교라 거래일 달력이 필요 없고 오탐이 없다.
    //
    // ★[2026-08-12] 단, **그 날이 복구됐으면 실패라고 말하면 안 된다.** 08-11 이
    // 정확히 그랬다: 18:10 이 sanity 에 막혔지만 19:30 재시도가 성공해 19:55 본이
    // 서빙됐고, 데이터도 recovered_dates=["2026-08-11"] · consecutive_failure_days=0
    // 으로 이미 그렇게 적고 있었다. 그런데 배너는 last_failure_date 만 읽어
    // "2026-08-11 발행 실패"를 **모든 MCP 호출마다** 내보냈다 — 바로 옆 필드가
    // 복구를 말하는데 배너만 반대로 말한 것이다.
    // 오늘 아침 check_publish 에서 고친 것과 같은 병이다: '실패가 있었나'와
    // '지금 문제가 있나'는 다른 질문이다. 늑대를 매번 외치면 진짜 늑대를 놓친다.
    const rec = pl["recovered_dates"];
    const wasRecovered = Array.isArray(rec) && rec.indexOf(String(lf)) >= 0;
    if (qa && lf && !wasRecovered &&
        String(lf).replace(/-/g, "") > String(qa).replace(/-/g, "")) {
      bits.push(`시세 기준일 ${isoDate(qa)}, 그 이후 ${isoDate(lf)} 발행 실패 — 해당 거래일이 반영되지 않았습니다`);
    }
    if (pl["serving_last_good"] === true) bits.push("이번 발행분이 아니라 직전 성공본을 서빙 중입니다");
    const cf = Number(pl["consecutive_failure_days"] || 0);
    if (!bits.length && cf > 0) bits.push(`최근 ${cf}일 연속 발행 실패 이력이 있습니다`);

    // ★[2026-08-12] 아래 상태어는 index.json 이 **발행 시점에** 계산해 둔 값이다.
    // 그래서 발행이 멈추면 그 값도 같이 멈춘다 — 데이터가 일주일 낡아도 계속
    // "정상"이라고 말한다. 정확히 위험한 때에 안심시키는 셈이라, 이건 침묵보다 나쁘다.
    // index.json 의 note 가 그 한계를 명시하고 **절대 날짜**를 함께 준다
    // (delayed_after · stale_after). 절대 날짜는 낡지 않으므로 지금 판정은 그것으로 한다.
    // 정상인 날에는 오늘이 두 날짜보다 앞이라 아무 말도 붙지 않는다 — 사이트 배지와
    // 어긋나는 것은 배지가 틀린 날뿐이고, 그날은 어긋나는 게 맞다.
    const todayKst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const da = String(fr["delayed_after"] || "");
    const sa = String(fr["stale_after"] || "");
    if (sa && todayKst > sa) {
      bits.push(`시세가 ${qa} 에 멈춰 있습니다 — 오늘(${todayKst}) 기준 stale_after(${sa}) 경과`);
    } else if (da && todayKst > da) {
      bits.push(`시세가 ${qa} 에 멈춰 있습니다 — 오늘(${todayKst}) 기준 delayed_after(${da}) 경과`);
    }

    // 상시 한 줄. 상태어는 index.json 이 이미 계산해 둔 것을 그대로 쓴다 —
    // 여기서 다시 판정하면 사이트 배지와 다른 말을 하게 된다(그 사고를 낸 적 있다).
    const st = String(fr["recent_health"] || fr["publish_status"] || "").toLowerCase();
    const word = bits.length ? "지연" : (st === "ok" ? "정상" : (st ? "주의" : "확인불가"));
    // ★[2026-08-11 실측] 한 줄 안에서 날짜 형식이 갈렸다 — 시세는 2026-08-07(ISO),
    // 공시는 20260810(원본 그대로). quote 쪽만 *_iso 필드가 있어서 생긴 차이다.
    // 날짜 정확성이 이 서비스의 정체성인데 같은 줄에서 형식이 두 가지면, 읽는
    // 쪽이 파싱 규칙을 하나로 못 잡는다. 여기서 세운다.
    // 변환은 모듈 수준 isoDate 하나뿐이다 — 여기에 자기 벌을 두면 푸터와 갈라진다
    // (실제로 갈라졌고, 그래서 푸터만 세 형식으로 나갔다).
    const iso = isoDate;
    // ★[2026-08-13 실측] 같은 응답 안에서 머리와 몸이 다른 날을 말하고 있었다.
    //   머리: "공시 2026-08-12" / 몸: "장중 공시 수집본 — 기준일 2026-08-13"(941건).
    //   머리를 먼저 읽는 쪽은 몸을 낡은 것으로 깎아 읽는다. 15:00 장중 수집본이
    //   본발행보다 하루 앞서 있는데 배너가 그 존재를 말하지 않았다 — 데이터가 있는데
    //   말하지 않으면 소비자는 '없다'고 결론낸다(이 저장소 최초의 실사용자 신고).
    //   본발행 날짜가 오늘보다 뒤처진 동안에만 붙인다(18:10 뒤에는 저절로 사라진다).
    //   추가 fetch 는 하지 않는다 — 12개 도구 × 모든 응답에 붙는 자리다.
    const dtIso = iso(dt);
    const intradayHint = (dtIso && todayKst && todayKst > dtIso)
      ? " · 이후 접수분은 15:00 장중본(get_disclosures)" : "";
    const line = `[신선도] ${word} · 시세 ${iso(qa) || "?"}(T+1 확정)` +
      (dt ? ` · 공시 ${dtIso}${intradayHint}` : "") + " · 다음 갱신 18:10 KST\n";

    if (!bits.length) return line + "\n";
    return `⚠ 발행 지연 — ${bits.join(" · ")}.\n` + line +
      `   상태 원본: ${ORIGIN}/data/public/index.json (freshness·pipeline)\n\n`;
  } catch (e) {
    // ★상태를 못 읽었으면 그렇다고 말한다. 예전엔 빈 문자열을 돌려줘서
    //   '못 읽음'이 '정상'으로 읽혔다 — 이 파일이 고치려는 바로 그 오류다.
    return "[신선도] 확인불가 — 상태 파일을 읽지 못했습니다. " +
      `${ORIGIN}/data/public/index.json 을 직접 확인하세요.\n\n`;
  }
}

async function doToolCall(id, params) {
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
  const args = params.arguments || {};
  try {
    const [banner, text] = await Promise.all([staleBanner(), tool.run(args)]);
    // ★[2026-08-10 P1-J] 푸터를 개별 return 에 맡기지 않는다.
    // 성공 응답 10/10 에는 카탈로그 안내가 글자 그대로 붙는데, '못 찾음' 분기
    // 세 곳(get_stock(999999)·get_history(999999)·get_disclosure_impact(없는 label))은
    // 푸터 두 줄이 통째로 빠져 있었다. 같은 '데이터 없음'인데 분기마다 답이 달랐다.
    // 이미 붙은 응답에 두 번 붙이지 않도록 표식으로 판정한다.
    // 커버리지 줄을 함께 붙인다 — 이 분기는 대개 "못 찾았다"는 응답이고,
    // 유니버스가 1,500 이라는 사실이 가장 필요한 자리가 바로 거기다.
    const withFooter = text.indexOf(MORE_LINE) >= 0
      ? text
      : `${text}\n---\n${COVERAGE_LINE}\n${MORE_LINE}\n${SCHEMA_LINE}`;
    return rpcResult(id, { content: [{ type: "text", text: banner + withFooter }], isError: false });
  } catch (e) {
    const raw = e && e.isUserError ? e.message : ORIGIN_FAIL_TEXT;
    // 실패 문구야말로 다음 행동을 줘야 한다 — 여기서 막히면 사용자는 서비스를 떠난다.
    const text = raw + "\n\n찾지 못했다면 시총 상위 유니버스 밖일 수 있습니다 — " +
      "조건 검색은 list_stocks(), 데이터 전체 카탈로그는 get_data_urls().";
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
        return rpcResult(id, await doInitialize(m.params || {}));
      case "ping":
        return rpcResult(id, {});
      // ★[2026-08-11 4호 A-5①] 도구 어노테이션.
      //
      // 클라이언트(Claude 커넥터 등)는 readOnlyHint 로 "확인 없이 불러도 되는 도구"를
      // 가른다. 없으면 보수적으로 다뤄져 매 호출마다 승인을 묻거나 아예 자동 호출에서
      // 빠진다 — 읽기 전용 데이터 서버에 그건 순손해다.
      //
      // ★12개에 손으로 붙이지 않는다. 이 서버는 **전부 읽기 전용**이라는 것이 성질이지
      // 도구별 사정이 아니다(§7-6: 인증을 어떤 공개 경로에도 추가 금지 — 쓰기가 생길
      // 여지 자체가 없다). 손목록으로 두면 13번째 도구에서 어긋난다.
      // 예외가 생기면 그때 t.annotations 를 개별로 얹으면 되게 병합만 해 둔다.
      case "tools/list":
        return rpcResult(id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: Object.assign({
              title: t.title,
              readOnlyHint: true,        // 정적 JSON 읽기만 한다 — 쓰기 경로가 없다
              destructiveHint: false,
              idempotentHint: true,      // 같은 스냅샷이면 같은 답(발행 사이엔 불변)
              openWorldHint: false,      // 우리가 발행한 닫힌 데이터셋만 본다
            }, t.annotations || {}),
          })),
        });
      case "tools/call":
        // [2026-08-17 P2-10] 도구가 돌기 전에 커버리지 문장을 한 번 새로 맞춘다.
        // footer() 는 동기라 매 자리에서 await 할 수 없다 — 여기서 모듈 변수를
        // 갱신해 두면 그 요청의 모든 footer 가 같은(최신) 문장을 쓴다.
        // fetchJson 캐시 덕에 원본을 매번 때리지 않고, 실패해도 폴백 문장이 남는다.
        COVERAGE_LINE = await coverageLine();
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
// [2026-08-17 P3-1] 도구 설명을 HTML 에 넣으려면 이스케이프가 필요하다.
// 지금 TOOLS 의 description 에 `<` 가 없더라도 **다음 도구에서 생긴다** —
// 없는 이스케이프는 조용한 XSS 표면이고, 그때는 아무도 이 자리를 다시 안 본다.
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

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
<!-- ★[2026-09-08 · 10호 §93] 이 안내 페이지는 **두 호스트**에서 같은 내용으로 나온다
     (mcp.aikstockdata.com · aikstockdata-mcp.na4tech.workers.dev). 실측으로 둘 다
     canonical 도 robots 도 없었다 — 우리 /ai.html 과 같은 이야기를 하는 색인 가능한
     사본이 두 벌 더 있었던 셈이다. 구글이 우리를 거의 안 읽는 마당(§92: site: 4장)에
     신호가 셋으로 갈라지는 것은 나쁘다. 정본을 가리킨다. -->
<link rel="canonical" href="https://aikstockdata.com/ai.html">
<meta name="robots" content="index,follow">
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
회원가입·API 키가 필요 없고, 100% 공공데이터 가공물입니다.${basis ? ` 현재 데이터 기준일: <strong>${isoDate(basis)}</strong>.` : ""}</p>

<h2>연결 방법</h2>
<p>MCP 엔드포인트: <code>${ep}</code></p>
<ul>
  <li><strong>claude.ai</strong>: 설정 → 커넥터 → "커스텀 커넥터 추가" → 위 URL 붙여넣기 (인증 없음)</li>
  <li><strong>Claude Desktop</strong>: 설정 → 커넥터 → 커스텀 커넥터 추가 → 위 URL 붙여넣기</li>
  <li><strong>ChatGPT</strong>: 설정 → 커넥터 → 개발자 모드 활성화 후 커넥터 추가 → 위 URL 붙여넣기</li>
</ul>
<p>프로토콜: MCP Streamable HTTP(무상태). <code>POST ${ep}</code> 에 JSON-RPC 2.0 메시지를 보냅니다.
브라우저에서 <code>GET /mcp</code>는 405가 정상입니다.</p>

<h2>제공 도구 (${TOOLS.length}개)</h2>
<!-- [2026-08-17 P3-1] 이 표는 손으로 적지 않는다. TOOLS 배열에서 생성한다.
     같은 파일의 405 응답과 /health 는 이미 TOOLS.map() 으로 만드는데
     **사람이 읽는 표면 하나만** 손목록으로 남아 6개를 말하고 있었다(실물 12개).
     그 표의 어떤 도구 설명은 이미 한 번 실물과 어긋난 전력도 있다.
     ★이 블록에 도구 이름을 리터럴로 적지 마라(주석에도). test_mcp_landing 이
       블록 전체에서 이름 리터럴 0건을 요구한다 — 느슨하게 하면 검사가 약해진다. -->
<p class="note">설명은 AI 클라이언트가 받는 원문 그대로입니다 — 실물과 다른 친절한 번역보다 실물이 낫습니다.</p>
<table>
  <tr><th>도구</th><th>설명</th></tr>
  ${TOOLS.map((t) => `<tr><td><code>${escapeHtml(t.name)}</code></td><td>${escapeHtml(t.description)}</td></tr>`).join("\n  ")}
</table>

<h2>데이터 원천</h2>
<p>모든 응답은 <a href="https://aikstockdata.com/data/public/quotes.json">quotes.json</a> ·
<a href="https://aikstockdata.com/data/public/disclosures.json">disclosures.json</a> ·
<a href="https://aikstockdata.com/data/public/rankings.json">rankings.json</a> ·
<a href="https://aikstockdata.com/data/public/search_index.json">search_index.json</a> 등
공개 정적 파일(공공데이터 가공물)의 무상태 프록시입니다(10분 캐시).
필드 정의·단위·결측 규칙은 <a href="https://aikstockdata.com/ai">AI 활용 안내</a>와
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
          docs: `${ORIGIN}/ai`,
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
        // 배포된 소스의 git 짧은 해시. 로컬에서 이 한 줄만 읽으면 도착이 확인된다.
        code_rev: CODE_REV,
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
