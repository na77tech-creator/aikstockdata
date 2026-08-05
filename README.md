# aikstockdata — Korean Stock Data for AI (MCP + free JSON)

**KOSPI / KOSDAQ closing prices, KOSPI·KOSDAQ index levels, DART regulatory filings and
1‑year daily price history for ~1,500 stocks — published every trading day as AI‑readable
JSON. No signup. No API key. No rate limit.**

🔗 **Site:** https://aikstockdata.com · **MCP endpoint:** `https://mcp.aikstockdata.com/mcp`

Listed in the [official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=com.aikstockdata/mcp)
as **`com.aikstockdata/mcp`** (domain-verified).

[![Hugging Face](https://img.shields.io/badge/%F0%9F%A4%97%20dataset-korea--equity--daily-yellow)](https://huggingface.co/datasets/aikstockdata/korea-equity-daily)
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
https://mcp.aikstockdata.com/mcp
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

**Why the User-Agent header?** The CDN's bot filter rejects the default `Python-urllib` user agent with a 403. `requests`, `curl`, `httpx` and browser `fetch` work without it. Sending any UA string is enough.

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

## Prefer a bulk download? Hugging Face

The live API below is republished every trading evening. If you would rather pull one file and
work offline, a dated snapshot is mirrored there:

**<https://huggingface.co/datasets/aikstockdata/korea-equity-daily>**

```python
from datasets import load_dataset

px = load_dataset("aikstockdata/korea-equity-daily", "daily_prices", split="train")
# 361,111 rows across 1,463 stocks, up to 250 trading days each (close and volume)
```

Four configs: `daily_prices`, `stocks`, `filing_impact_summary`, and `filing_price_impact` —
the individual filings behind the summary, one row each, so the published medians can be
recomputed rather than taken on trust.

The loadable files are JSON Lines, not CSV. A Korean ticker is six digits *including leading
zeros*, and type inference on CSV turns `000020` into `20`, at which point it joins to nothing.
The snapshot is frozen at its upload date — the endpoints below are the ones that stay current.

---

## Endpoints

Start at the catalog — it lists every file with its size, freshness and archive dates:

```
https://aikstockdata.com/data/public/index.json
```

| Endpoint | What it is | Size |
|---|---|---|
| `today.json` | One‑day digest — **KOSPI/KOSDAQ index close**, breadth, top filings, rankings | 7 KB |
| `s/{code6}.json` | **One stock** — quote, financials, recent filings, signals | ~5 KB |
| `s/{code6}_history.json` | **One stock, 250 trading days** — `[date, close, volume]` | ~7 KB |
| `disclosure_impact.json` | **What happened after each filing type** — market‑adjusted median return at +1/+5/+20 trading days | 60 KB |
| `earnings_recent60.json` | Earnings scoreboard, latest 60 (truncation‑safe) | 40 KB |
| `daily/today_{YYYYMMDD}.json` | Archived daily digest (30‑day window) | 7 KB |
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

Also: [**`/openapi.json`**](https://aikstockdata.com/openapi.json) (OpenAPI 3.1 — drop it into a
ChatGPT custom GPT as an Action, or generate an SDK) ·
[`/llms.txt`](https://aikstockdata.com/llms.txt) ·
[`/llms-full.txt`](https://aikstockdata.com/llms-full.txt) ·
[`/feed.xml`](https://aikstockdata.com/feed.xml) ·
JSON Schemas under `/data/public/schemas/`

### ⚠️ Large files get truncated by AI fetch tools

Most AI fetch tools cut responses at 50–150 KB, and a truncated JSON is **unparseable** — which
produces silently wrong answers rather than an error. `index.json` carries a machine‑readable
`fetch_guide` block with the small alternative for every large file. Rule of thumb: if you need
one stock, always use `s/{code}.json`.

---

## What you can't get anywhere else for free

### 1. What actually happened after each filing type

Every filing is joined to that stock's daily closes and to its market index, so you can ask
*"what did the market do after this kind of filing, historically?"* — as a record, not a forecast.

```
https://aikstockdata.com/data/public/disclosure_impact.json
```

For each filing type: the **median market‑adjusted return** at +1 / +5 / +20 trading days
(stock return minus its own index over the same window), plus how often it beat the market.
Per‑filing values are keyed by DART receipt number, so you can join back to the original document.
(`배당 결정` = dividend decision. Real values as of 2026‑08‑05.)

```json
{ "label": "배당 결정",
  "h5": { "n": 27, "enough": true, "median_excess_pct": 3.91, "up_ratio_pct": 74.1 } }
```

Types with fewer than 20 samples are **not** given a number — a median over a handful of cases
turns coincidence into a statistic. This is a record of what happened, not a claim about cause,
and not a prediction.

### 2. One year of daily prices per stock, as one small file

`s/{code6}_history.json` — up to 250 trading days of `[date, close, volume]`, ~7 KB.
Rows are arrays, not objects: repeating six key names 250 times doubles the file for no
information (measured: 14.3 KB → 6.8 KB).

### 3. Index and breadth are kept separate — because they disagree

`today.json` carries both the KOSPI/KOSDAQ close **and** the advance/decline count, because they
routinely point opposite ways. On 2026‑08‑03 KOSPI fell 5.12% while 855 stocks rose and 518 fell:
the index is cap‑weighted, the count is one vote per stock. Most sources give you only one of the
two and let you assume they agree.

### 4. A dated page per trading day, permanently

`https://aikstockdata.com/market/{YYYY-MM-DD}` — the URL date is the **closing‑price date**, not
the publish date. (We got that wrong once and a crash day carried a +17.9% headline for a few
hours. Now the date and the data cannot disagree.)

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
- **한 종목 1년 시세**: `.../s/005930_history.json` — 250거래일 `[날짜, 종가, 거래량]` (약 7KB)
- **공시 뒤 무슨 일이 있었나**: `.../disclosure_impact.json` — 공시 유형별로 접수일 종가 대비
  1·5·20거래일 뒤 **시장조정 수익률 중앙값**(종목 − 소속 지수). 과거 기록이며 예측이 아닙니다.
- **개발자용 명세**: https://aikstockdata.com/openapi.json (OpenAPI 3.1 — GPT Actions·SDK 생성)
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
