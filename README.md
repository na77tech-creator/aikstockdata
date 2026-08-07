# aikstockdata — 한국 주식 공시·시세를 AI가 바로 읽는 무료 JSON + MCP 서버

**KOSPI·KOSDAQ 약 1,500종목의 확정 종가·지수, DART 공시, 종목당 1년치 일별 시세를
매 거래일 저녁 AI가 읽을 수 있는 JSON으로 발행합니다.
가입도, API 키도, 요청 제한도 없습니다.**

🔗 **사이트** https://aikstockdata.com · **MCP 주소** `https://mcp.aikstockdata.com/mcp`

[공식 MCP 레지스트리](https://registry.modelcontextprotocol.io/v0.1/servers?search=com.aikstockdata/mcp)에
**`com.aikstockdata/mcp`** 로 등재돼 있습니다(도메인 확인 완료).

[![Hugging Face](https://img.shields.io/badge/%F0%9F%A4%97%20dataset-korea--equity--daily-yellow)](https://huggingface.co/datasets/aikstockdata/korea-equity-daily)
[![Kaggle](https://img.shields.io/badge/Kaggle-dataset-20BEFF)](https://www.kaggle.com/datasets/aikstokdata/korean-equity-daily-prices-dart-filing-impact)
[![MCP](https://img.shields.io/badge/MCP-server-blue)](https://modelcontextprotocol.io)
[![Auth](https://img.shields.io/badge/auth-none-brightgreen)]()
[![License](https://img.shields.io/badge/data-public%20domain%20derived-brightgreen)]()

> English documentation is in the [second half of this page](#english).

---

## 30초 만에 AI에 붙이기

### Claude · ChatGPT — MCP 커넥터

설정의 **커스텀 커넥터**에 아래 주소를 붙여넣으면 끝입니다. 인증이 없습니다.

```
https://mcp.aikstockdata.com/mcp
```

도구 6개가 생깁니다 — `get_today` · `search_stock` · `get_stock` · `get_rankings` ·
`get_market_summary` · `get_data_urls`.

그다음엔 그냥 물어보면 됩니다: *"오늘 한국 시장 어땠어?"* · *"삼성전자 최근 공시 정리해줘"*

### MCP 없이 — 주소만 붙여넣기

```
https://aikstockdata.com/data/public/today.json 을 읽고 오늘 한국 시장을 요약해줘.
```

### Python

```python
import urllib.request, json

def get(path):
    url = "https://aikstockdata.com/data/public/" + path
    return json.load(urllib.request.urlopen(url))

today = get("today.json")            # 오늘 하루 요약 (7KB)
samsung = get("s/005930.json")       # 한 종목 (5KB)
hist = get("s/005930_history.json")  # 1년치 [날짜, 종가, 거래량] (7KB)
```

> ★**종목코드는 여섯 자리 문자열입니다.** 정수로 읽으면 `000020`이 `20`이 됩니다.
> pandas 를 쓴다면 `dtype={"code": str}` 를 반드시 주세요.

### curl

```bash
curl -s https://aikstockdata.com/data/public/s/005930.json
```

---

## 왜 만들었나

한국 시장 데이터는 AI가 쓰기 어렵습니다. 공식 출처(금융위원회 공공데이터포털,
금융감독원 DART)는 **API 키를 먼저 받아야 하고**, 한글 필드명이 그대로인 XML·JSON을 주며,
값이 **없는 것인지 0인 것인지 구분할 방법을 주지 않습니다.**

이 프로젝트는 그것을 LLM이 그대로 읽는 자기설명형 JSON으로 정규화하고, 주소 하나만
붙여넣으면 되는 MCP 서버를 얹었습니다.

**실질적인 차이는 자격증명입니다.** 한국 주식 MCP 서버 대부분은 DART·증권사 API를 실시간으로
중계하기 때문에 첫 호출 전에 키 발급이 필요합니다. 이 서버는 **미리 만들어 둔 공개 파일**을
내보내므로 주소를 붙여넣는 순간부터 동작합니다.

---

## 여기서만 무료로 얻는 것

### 1. ★공시 접수 시각 (HH:MM) — 공개 API 어디에도 없습니다

DART 공시검색 API가 주는 접수 정보는 **날짜(YYYYMMDD)뿐**입니다. 개별 공시 뷰어에도,
공시검색 화면에도 시:분이 없습니다. 그런데 같은 날짜의 공시라도 **장중에 나온 것**과
**장 마감 후에 나온 것**은 그날 종가에 대해 정반대를 뜻합니다 — 앞의 것은 이미 주가에
반영됐고, 뒤의 것은 아직 반영되지 않았습니다.

저희는 시:분이 남아 있는 유일한 곳에서 이 값을 따로 모아 붙입니다.

```
https://aikstockdata.com/data/public/disclosures.json          # 18:10 발행 · events[].receipt_time · session
https://aikstockdata.com/data/public/disclosures_intraday.json # 15:00 발행 · 그날 접수 전건
https://aikstockdata.com/data/public/dart_receipt_times.json   # 접수번호 ↔ 시각 대조표
```

`session` 은 정규장(09:00~15:30) 기준 세 갈래입니다.

| 값 | 뜻 | 그날 종가 움직임은 |
|---|---|---|
| `pre_open` | ~09:00 접수 | 전체가 공시 **뒤** — 반응으로 읽을 수 있는 유일한 경우 |
| `intraday` | 09:00~15:30 | 앞부분은 공시 이전 — 섞여 있습니다 |
| `after_close` | 15:30~ | 전체가 공시 **앞** — 공시 반응이 아닙니다 |

```python
d = get("disclosures.json")
late = [e for e in d["events"] if e["session"] == "after_close"]
# 오늘 장 마감 뒤에 나온 공시 — 아직 종가에 반영되지 않았다
```

실측으로 **접수 건의 40% 안팎이 장 마감 후**입니다. 시각이 없으면 그 40%를 그날 종가의
반응으로 잘못 읽게 됩니다.

### 2. 공시 유형별로 그 뒤에 실제로 무슨 일이 있었나

공시마다 그 종목의 일별 종가와 소속 지수를 붙여 두었습니다. *"이런 종류의 공시 뒤에
시장은 어떻게 움직였나"* 를 **기록으로서** 물을 수 있습니다 — 예측이 아닙니다.

```
https://aikstockdata.com/data/public/disclosure_impact.json
```

유형별로 +1 / +5 / +20거래일 뒤의 **시장조정 수익률 중앙값**(종목 수익률 − 같은 기간
소속 지수 수익률)과 시장을 이긴 비율을 함께 냅니다. 개별 값은 DART 접수번호를 열쇠로
싣기 때문에 원문과 대조할 수 있습니다.

표본이 20건 미만인 유형에는 **숫자를 넣지 않습니다.** 몇 건짜리 중앙값은 우연을 통계로
둔갑시킵니다. 95% 구간도 함께 싣는데, **현재 숫자가 있는 18칸 중 17칸의 구간이 0을 포함합니다.**
그 사실을 감추지 않는 것이 이 표의 요점입니다.

### 3. 종목당 1년 시세가 한 파일 7KB

`s/{종목코드}_history.json` — 최대 250거래일의 `[날짜, 종가, 거래량]`.
행을 객체가 아니라 배열로 둡니다. 여섯 개 키 이름을 250번 반복하면 정보 없이 파일만
두 배가 됩니다(실측 14.3KB → 6.8KB).

### 4. 지수와 상승 종목 수를 따로 줍니다 — 둘이 어긋나기 때문에

`today.json` 은 KOSPI·KOSDAQ 종가와 상승·하락 종목 수를 **둘 다** 싣습니다. 이 둘은
자주 반대를 가리킵니다. 2026-08-03 에는 코스피가 5.12% 내렸는데 855종목이 오르고
518종목이 내렸습니다 — 지수는 시총 가중이고 종목 수는 한 종목 한 표이기 때문입니다.
대부분의 출처는 둘 중 하나만 주고 나머지는 같으려니 하게 만듭니다.

### 5. 거래일마다 영구 주소가 남습니다

`https://aikstockdata.com/market/{YYYY-MM-DD}` — 주소의 날짜는 발행일이 아니라
**종가 기준일**입니다. (한 번 틀린 적이 있습니다. 폭락한 날 페이지가 몇 시간 동안
+17.9% 머리기사를 달고 있었습니다. 지금은 날짜와 데이터가 어긋날 수 없습니다.)

---

## 통짜로 받고 싶다면

발행일에 고정된 스냅샷입니다. 매 거래일 갱신되는 원본은 위 주소들입니다.

| 어디 | 무엇 |
|---|---|
| [Hugging Face](https://huggingface.co/datasets/aikstockdata/korea-equity-daily) | JSON Lines · 종목 마스터 · 일별 종가 · 공시 유형별 이후 주가 |
| [Kaggle](https://www.kaggle.com/datasets/aikstokdata/korean-equity-daily-prices-dart-filing-impact) | CSV 4개 · **공시 접수 시각 열 포함** |

인용용 **월간 동결본**은 허깅페이스의 `korea-equity-daily-YYYY-MM` 에 따로 있습니다.
`main` 은 매 거래일 덮어쓰이므로 인용에 쓸 수 없습니다.

---

## 설계 원칙

- **`null` 은 0이 아닙니다.** 결측은 `null`, `0` 은 실제로 측정된 0입니다(거래 없음 등,
  `has_trade: false` 로 표시).
- **'기준일'이 두 개입니다.** `quote_as_of`(시세 기준일, T+1 확정 종가)와
  `disclosure_through`(공시 수록일)는 따로 움직입니다. 하나의 "오늘"로 합치지 마세요.
- **신선도는 주장이 아니라 계산값입니다.** `index.json → freshness.status` 는 실제 경과일에서
  나옵니다(`fresh` 4일 이내 / `delayed` 5~7일 / `stale` 8일 이상). `quote_as_of_age_days` 를
  같이 실어 직접 검산할 수 있게 했습니다.
- **회계 항등식을 어기는 수치는 게시하지 않고 철회합니다.** 순이익이 매출액을 넘는 등의
  파싱 결과는 숫자를 지우고 공시 제목과 DART 원문 링크만 남깁니다
  (`value_status: "withdrawn_inconsistent"`).
- **랭킹 산식은 전부 공개돼 있습니다** — `rankings.json` 안에 성분별 점수까지 들어 있어
  누구나 재계산할 수 있습니다.
- **실패도 공개합니다.** `notices.json` 에 파이프라인 실패와 정정을 기록합니다. 실행이
  실패하면 반쯤 만든 것을 내보내지 않고 마지막 정상 스냅샷을 유지합니다.
- **투자 권유가 아닙니다.** 공개 공시에 대한 기계적 집계이며 목표주가·투자의견·매수매도
  추천은 제공하지 않습니다. 설계상 그렇습니다.

---

## 없는 것

실시간·분봉 시세가 없습니다(전 영업일 확정 종가, T+1). 증권사 유래의 PER·PBR·컨센서스·
목표주가가 없습니다. 주문 실행 기능이 없습니다. **의도된 것입니다** — 재배포할 권리가
분명한 데이터만 다룹니다.

---

## 출처와 라이선스

- **금융감독원 전자공시시스템(DART)** — 공시
- **금융위원회 공공데이터포털** — 일별 확정 종가

발행 파일은 공공데이터 가공물이며 **출처를 표기하면 영리 목적을 포함해 자유롭게** 쓸 수 있습니다.

> 자료: 한국주식데이터(aikstockdata.com) — 원천: 금융감독원 DART · 금융위원회 공공데이터포털

이 저장소의 코드는 MIT 라이선스입니다(`LICENSE` 참조). 위 데이터 라이선스는 발행되는
JSON·CSV 파일에 적용되며 이 저장소의 코드에는 적용되지 않습니다.

---

## 저장소 구성

```
mcp/worker.js      MCP 서버 (Cloudflare Worker · 상태 없는 JSON-RPC over HTTP)
examples/          바로 돌아가는 Python · JavaScript · 셸 예제
```

발행 파일을 만드는 데이터 파이프라인은 별도로 관리합니다.

---
<a id="english"></a>

# English

*The Korean documentation above is the primary reference. This section mirrors it.*

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
| `disclosures_intraday.json` | **Today's filings with receipt times (HH:MM)** — published 15:00 KST, before the close | 60 KB |
| `dart_receipt_times.json` | **Receipt number → HH:MM lookup** — not available from any public API | 110 KB |
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

### 0. Filing receipt times (HH:MM) — not in any public Korean source

The DART search API returns a receipt **date**, never a time. Neither does the filing viewer,
nor the search screen. But an intraday filing and an after-close filing mean opposite things
for that day's close: the first is already in the price, the second is not.

```
/data/public/disclosures.json           # 18:10 KST · events[].receipt_time and .session
/data/public/disclosures_intraday.json  # 15:00 KST · every filing received that day
/data/public/dart_receipt_times.json    # receipt number to time lookup
```

`session` splits on the Korean regular session (09:00-15:30): `pre_open` (the whole day
follows the filing — the only identifiable case), `intraday` (mixed), `after_close` (the whole
day precedes it — not a reaction at all). Measured: roughly 40% of filings arrive after the
close. Without the minute, that 40% gets read as same-day reaction.

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

---

*Keywords: Korean stock market API, KOSPI JSON, KOSDAQ data, DART disclosures API, MCP server Korea,
free Korean stock data, 한국 주식 API 무료, 한국 주식 MCP, DART 공시 JSON, 코스피 종가 CSV*
