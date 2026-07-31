/**
 * aikstockdata quickstart — Korean stock data, no API key.
 *
 *   node quickstart.js            # today's market digest
 *   node quickstart.js 005930     # one stock (Samsung Electronics)
 *
 * Runs in Node 18+ and in the browser (CORS is open on /data/public/*).
 */
const BASE = "https://aikstockdata.com";

const get = async (path) => {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
};

/** null means "not provided" — never render it as 0. */
const won = (v) =>
  v == null ? "n/a"
    : Math.abs(v) >= 1e12 ? `${(v / 1e12).toFixed(2)}조`
      : `${Math.round(v / 1e8).toLocaleString()}억`;

/** Freshness is computed by the publisher, not asserted. Check it before quoting numbers. */
async function checkFreshness() {
  const { freshness: f } = await get("/data/public/index.json");
  if (f.status !== "fresh") {
    console.warn(`⚠ 데이터 지연: ${f.status} (기준일 ${f.quote_as_of}, ${f.quote_as_of_age_days}일 경과)`);
  }
  return f;
}

async function marketDigest() {
  const t = await get("/data/public/today.json");
  const b = t.market_breadth || {};
  console.log(`기준일(price) ${t.quote_as_of} · 공시 수록 ${t.disclosure_through}`);
  console.log(`상승 ${b.up} · 하락 ${b.down} · 보합 ${b.flat} · 분위기 ${b.tone}\n`);
  for (const d of (t.top_disclosures || []).slice(0, 5)) {
    console.log(`  [${d.score}] ${d.name} — ${d.label}`);
    if (d.fact) console.log(`        ${d.fact}`);
  }
}

async function stock(code) {
  const s = await get(`/data/public/s/${code}.json`);   // ~5 KB per stock
  const q = s.quote || {};
  console.log(`${s.name_ko} (${s.code}) · ${s.market}`);
  console.log(`  종가 ${q.close?.toLocaleString()}원 · 등락률 ${q.change_pct}% · 거래량 ${q.volume?.toLocaleString()}`);
  console.log(`  시가총액 ${won(q.market_cap_krw)} · 기준일 ${q.as_of} · has_trade=${q.has_trade}`);

  const f = s.financials;
  if (f) {
    console.log(`  재무 ${f.period} (${f.basis})`);
    for (const [k, label] of [["revenue", "매출액"], ["operating_income", "영업이익"], ["net_income", "순이익"]]) {
      const m = f[k] || {};
      const yoy = m.yoy_pct == null ? "" : ` (전년 대비 ${m.yoy_pct > 0 ? "+" : ""}${m.yoy_pct}%)`;
      console.log(`    ${label} ${won(m.current)}${yoy}`);
    }
  }
  for (const d of (s.recent_disclosures || []).slice(0, 3)) {
    console.log(`  공시 ${d.rcept_dt} [${d.type}] ${d.fact || d.title}`);
  }
}

/** Name -> code. The lightweight index declares URL patterns once instead of repeating them. */
async function findCode(name) {
  const idx = await get("/data/public/search_index_min.json");
  const hit = idx.items.find((i) => i.n === name) || idx.items.find((i) => i.n.includes(name));
  if (!hit) throw new Error(`'${name}' 를 찾지 못했습니다.`);
  return hit.c;
}

(async () => {
  await checkFreshness();
  const arg = process.argv[2];
  if (!arg) return marketDigest();
  return stock(/^\d{6}$/.test(arg) ? arg : await findCode(arg));
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
