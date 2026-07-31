# aikstockdata — Korean Stock Data for AI (MCP + free JSON)

**KOSPI / KOSDAQ closing prices and DART regulatory filings, published every trading day as
AI‑readable JSON. No signup. No API key. No rate limit.**

🔗 **Site:** https://aikstockdata.com · **MCP endpoint:** `https://aikstockdata-mcp.na4tech.workers.dev/mcp`

[![MCP](https://img.shields.io/badge/MCP-server-blue)](https://modelcontextprotocol.io)
[![Auth](https://img.shields.io/badge/auth-none-brightgreen)]()
[![License](https://img.shields.io/badge/data-public%20domain%20derived-brightgreen)]()

---

## Why this exists

Korean market data is hard for AI to use. The official sources (금융위원회 public data portal,
금융감독원 DART) require API keys, return raw XML/JSON with untranslated Korean field names, and
give you no way to tell whether a number is missing or actually zero.

This project normalizes them into self‑describing JSON that an LLM can read directly — and adds an
MCP server so Claude and ChatGPT can query it mid‑conversation without any setup beyond pasting a URL.

**The practical difference:** no credentials. Most Korean stock MCP servers proxy the DART or
brokerage APIs live, so you have to register for a key before the first call. This one serves
pre‑built public files, so it works the moment you paste the URL.

---

## Quick start — connect an AI in 30 seconds

### Claude / ChatGPT (MCP connector)

Add this URL as a custom connector in settings. No authentication.

```
https://aikstockdata-mcp.na4tech.workers.dev/mcp
```

Six tools become available: `get_today`, `search_stock`, `get_stock`, `get_rankings`,
`get_market_summary`, `get_data_urls`.

Then just ask: *"오늘 한국 시장 어땠어?"* or *"Samsung Electronics latest disclosures?"*

### Any AI, without MCP — paste a URL

```
https://aikstockdata.com/data/public/today.json 을 읽고 오늘 한국 시장을 요약해줘.
```

### Python

```python
import urllib.request, json

def get(path):
    req = urllib.request.Request("https://aikstockdata.com" + path,
                                 headers={"User-Agent": "my-app"})
    return json.loads(urllib.request.urlopen(req).read())

today = get("/data/public/today.json")
print(today["market_breadth"], today["quote_as_of"])

samsung = get("/data/public/s/005930.json")     # one stock, ~5 KB
print(samsung["quote"], samsung["financials"])
```

### JavaScript (browser or Node — CORS is open)

```js
const r = await fetch("https://aikstockdata.com/data/public/today.json");
const today = await r.json();
console.log(today.market_breadth, today.quote_as_of);
```

### curl

```bash
curl -s https://aikstockdata.com/data/public/s/005930.json | jq .quote
```

---

## Endpoints

Start at the catalog — it lists every file with its size, freshness and archive dates:

```
https://aikstockdata.com/data/public/index.json
```

| Endpoint | What it is | Size |
|---|---|---|
| `today.json` | One‑day market digest — breadth, top filings, rankings, earnings | 7 KB |
| `s/{code6}.json` | **One stock** — quote, financials, recent filings, signals | ~5 KB |
| `search_index_min.json` | Name → code lookup (URL patterns declared once) | 83 KB |
| `disclosures_top100.json` | Top 100 filings by importance score, plain‑Korean explanation | 80 KB |
| `quotes_top300.json` | Top 300 by market cap, sort order guaranteed | 84 KB |
| `rankings.json` | Growth top 8, quiet performers, 52‑week highs/lows, movers | 17 KB |
| `earnings.json` | Earnings filings, 120‑day rolling scoreboard | 148 KB |
| `quotes_slim.json` | All stocks, 6 core fields | 201 KB |
| `quotes.json` | All stocks, all fields | 400 KB |
| `disclosures.json` | All filings from the last 7 days, with financial detail | 380 KB |
| `excluded.json` | Stocks in the universe with no quote, and why | 9 KB |
| `notices.json` | Machine‑readable incident and correction log | 9 KB |
| `quotes.csv` / `quotes_en.csv` | Same data as CSV (Korean / English headers) | 161 KB |

Also: [`/llms.txt`](https://aikstockdata.com/llms.txt) ·
[`/llms-full.txt`](https://aikstockdata.com/llms-full.txt) ·
[`/feed.xml`](https://aikstockdata.com/feed.xml) ·
JSON Schemas under `/data/public/schemas/`

### ⚠️ Large files get truncated by AI fetch tools

Most AI fetch tools cut responses at 50–150 KB, and a truncated JSON is **unparseable** — which
produces silently wrong answers rather than an error. `index.json` carries a machine‑readable
`fetch_guide` block with the small alternative for every large file. Rule of thumb: if you need
one stock, always use `s/{code}.json`.

---

## Design decisions that matter for AI

- **`null` never means zero.** A missing value is `null`. `0` means an actual measured zero
  (e.g. no trades that day, flagged by `has_trade: false`).
- **Two different "as of" dates.** `quote_as_of` (price date, T+1 settled close) and
  `disclosure_through` (last filing receipt date) are separate fields, because they move
  independently. Never collapse them into one "today".
- **Freshness is computed, not asserted.** `index.json → freshness.status` is derived from the
  actual age of the data (`fresh` ≤4d / `delayed` 5–7d / `stale` 8d+), and
  `quote_as_of_age_days` is exposed so you can check the arithmetic yourself.
- **Numbers that violate accounting identities are withdrawn, not published.** If a parsed filing
  shows net income exceeding revenue, the numbers are dropped and only the filing title and the
  DART original link remain, tagged `value_status: "withdrawn_inconsistent"`.
- **Every ranking formula is published** inside `rankings.json` itself, with per‑component scores,
  so any result can be recomputed.
- **Failures are logged in public.** `notices.json` records pipeline failures and corrections.
  When a run fails, the last good snapshot is kept rather than publishing a partial one.
- **Not investment advice.** Rankings are mechanical screens over public filings. No target
  prices, no analyst opinions, no buy/sell recommendations — by design.

---

## What is *not* here

No real‑time quotes (data is the previous trading day's settled close, T+1). No PER/PBR/analyst
consensus/target prices from brokerage sources. No order execution. These are deliberate — the
project only redistributes data it has clear rights to redistribute.

---

## Data sources & license

Data derives from Korean public sources:

- **금융감독원 전자공시시스템 (DART)** — regulatory filings
- **금융위원회 공공데이터포털** — daily settled closing prices

The published files are derived works of public data and are free to use, including commercially,
with attribution:

> 자료: 한국주식데이터(aikstockdata.com) — 원천: 금융감독원 DART · 금융위원회 공공데이터포털

The code in this repository is MIT licensed (see `LICENSE`). The data license above applies to the
published JSON/CSV files, not to this repository's code.

---

## Repository contents

```
mcp/worker.js      MCP server (Cloudflare Worker, stateless JSON-RPC over HTTP)
examples/          Runnable Python / JavaScript / shell examples
```

The data pipeline that produces the published files is maintained separately.

---

## 한국어 안내

**한국 주식 공시·종가를 AI가 바로 읽는 무료 JSON + MCP 서버입니다. 가입·API 키가 필요 없습니다.**

매 거래일 저녁, 금융감독원 DART 공시와 금융위원회 공공데이터 확정 종가를 수집해
AI가 그대로 인용할 수 있는 JSON으로 발행합니다.

- **AI에 연결하기**: Claude·ChatGPT 설정의 '커스텀 커넥터'에 위 MCP 주소를 붙여넣으면 끝입니다.
- **그냥 물어보기**: `https://aikstockdata.com/data/public/today.json 읽고 오늘 시장 요약해줘`
- **한 종목만**: `https://aikstockdata.com/data/public/s/005930.json` (약 5KB)
- **사람이 보는 안내**: https://aikstockdata.com/ai.html

### 설계 원칙

- `null`은 0이 아닙니다 — 결측은 `null`, 0은 실제로 0(거래 없음 등)입니다.
- 시세 기준일(`quote_as_of`)과 공시 수록일(`disclosure_through`)을 분리해서 제공합니다.
- 신선도는 주장이 아니라 계산값입니다 — 데이터가 오래되면 스스로 `stale`이라고 밝힙니다.
- 회계 항등식을 어기는 수치(순이익 > 매출액 등)는 게시하지 않고 철회합니다.
- 랭킹 산식은 전부 공개돼 있어 누구나 재계산할 수 있습니다.
- 파이프라인 실패도 공개 기록(`notices.json`)에 남깁니다.
- **투자 권유가 아닙니다.** 공개 공시에 대한 기계적 집계이며 목표주가·투자의견은 제공하지 않습니다.

---

*Keywords: Korean stock market API, KOSPI JSON, KOSDAQ data, DART disclosures API, MCP server Korea,
free Korean stock data, 한국 주식 API 무료, 한국 주식 MCP, DART 공시 JSON, 코스피 종가 CSV*
