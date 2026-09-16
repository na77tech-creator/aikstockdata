# aikstockdata — 한국 주식 공시·시세를 AI가 바로 읽는 무료 JSON + MCP 서버

**KOSPI·KOSDAQ·KONEX 전 종목의 확정 종가와 KOSPI·KOSDAQ 지수, DART 공시, 종목당 전체 일별 시세를
매 거래일 저녁 AI가 읽을 수 있는 JSON으로 발행합니다.
가입도 API 키도 필요 없고, 요청 쿼터도 없습니다.**

<sub>수록 종목 수는 매 거래일 바뀝니다 — 여기에 수를 적어 두면 그 순간부터 낡습니다.
현재 값은 [`index.json`](https://aikstockdata.com/data/public/index.json) 의 `coverage`
(`universe_n` · `published_n` · `excluded_n`)에 있습니다.</sub>

🔗 **사이트** https://aikstockdata.com · **MCP 주소** `https://mcp.aikstockdata.com/mcp`

[공식 MCP 레지스트리](https://registry.modelcontextprotocol.io/v0.1/servers?search=com.aikstockdata/mcp)에
**`com.aikstockdata/mcp`** 로 등재돼 있습니다(도메인 확인 완료).

[![Hugging Face](https://img.shields.io/badge/%F0%9F%A4%97%20dataset-korea--equity--daily-yellow)](https://huggingface.co/datasets/aikstockdata/korea-equity-daily)
[![Kaggle](https://img.shields.io/badge/Kaggle-dataset-20BEFF)](https://www.kaggle.com/datasets/aikstokdata/korean-equity-daily-prices-dart-filing-impact)
[![MCP](https://img.shields.io/badge/MCP-server-blue)](https://modelcontextprotocol.io)
[![Auth](https://img.shields.io/badge/auth-none-brightgreen)]()
[![License](https://img.shields.io/badge/data-non--commercial%2C%20attribution-orange)](https://aikstockdata.com/licenses/aiksd-public-1.1.txt)

> English documentation is in the [second half of this page](#english).

---

## 30초 만에 AI에 붙이기

### Claude · ChatGPT — MCP 커넥터

설정의 **커스텀 커넥터**에 아래 주소를 붙여넣으면 끝입니다. 인증이 없습니다.

```
https://mcp.aikstockdata.com/mcp
```

**Claude Code** 는 한 줄입니다.

```bash
claude mcp add --transport http aikstockdata https://mcp.aikstockdata.com/mcp
```

설정 파일을 직접 쓰는 도구라면(`claude_desktop_config.json` 등):

```json
{
  "mcpServers": {
    "aikstockdata": {
      "type": "http",
      "url": "https://mcp.aikstockdata.com/mcp"
    }
  }
}
```

도구 12개가 생깁니다.

| 도구 | 무엇을 |
|---|---|
| `get_today` | 오늘 시장 한 방에 — 등락·상승하락 종목 수·주요 공시 |
| `search_stock` · `get_stock` | 종목 찾기 · 종목 상세(시세·재무·공시) |
| `get_rankings` · `get_market_summary` | 순위표 · 시장 요약 |
| `get_disclosures` | **무슨 공시가 몇 시에 났나** — 접수 시각(HH:MM)과 장 구분(장전·장중·장마감후). 공개 API 어디에도 없는 값입니다 |
| `list_stocks` | **조건에 맞는 종목 목록** — 흑자전환·52주 신고저에 시총÷연환산영업이익 배수 상한까지 |
| `get_earnings` | **잠정 실적 포함** — 정기보고서보다 2주 빠릅니다 |
| `get_earnings_calendar` | **누가 냈고 누가 아직인가** — 법정 마감 D-day, 직전 발행 대비 신규 목록. 상태를 못 들고 다니는 에이전트에겐 이게 웹훅을 대신합니다 |
| `get_history` | 종목별 일별 시세(쌓인 전 구간) + 52주 고저·고점 대비 낙폭·거래량 배수 |
| `get_disclosure_impact` | 공시 유형별로 그 뒤 1·5거래일 주가(시장 등락을 뺀 값). 20거래일은 그 유형의 표본이 차면 나옵니다 — 응답의 h20_status 를 보세요 |
| `get_data_urls` | 원자료 주소 카탈로그 — 도구에 없는 것도 JSON 으로 다 있습니다 |

그다음엔 그냥 물어보면 됩니다: *"오늘 한국 시장 어땠어?"* · *"삼성전자 최근 공시 정리해줘"* ·
*"흑자전환한 종목 중에 시총이 영업이익의 10배 안 되는 것만"*

### MCP 없이 — 주소만 붙여넣기

```
https://aikstockdata.com/data/public/today.json 을 읽고 오늘 한국 시장을 요약해줘.
```

### Python

```python
import urllib.request, json

def get(path):
    url = "https://aikstockdata.com/data/public/" + path
    # User-Agent 를 반드시 준다. CDN 봇 필터가 파이썬 기본 UA 를 403 한다.
    req = urllib.request.Request(url, headers={"User-Agent": "my-app"})
    return json.load(urllib.request.urlopen(req))

today = get("today.json")            # 오늘 하루 요약 (7KB)
samsung = get("s/005930.json")       # 한 종목 (5KB)
hist = get("s/005930_history.json")  # 전 구간 [날짜, 종가, 거래량] · 길이는 count·period 에
```

> ★**종목코드는 여섯 자리 문자열입니다.** 정수로 읽으면 `000020`이 `20`이 됩니다.
> pandas 를 쓴다면 `dtype={"code": str}` 를 반드시 주세요.

### curl

```bash
curl -s https://aikstockdata.com/data/public/s/005930.json
```

---

## 이렇게 물어보세요

MCP 를 붙였거나 주소를 붙여넣었다면, 아래는 **그대로 복사해 쓰는 질문**입니다.
전부 우리 데이터로 답할 수 있는 것만 골랐습니다.

### 오늘 무슨 일이 있었나

```
오늘 한국 시장 어땠어? 지수랑 오른 종목 수를 같이 알려줘.
```
> 지수와 상승 종목 수는 자주 반대를 가리킵니다. 둘 다 봐야 합니다.

```
오늘 접수된 공시 중 중요도 높은 것 10건만 쉬운 말로 풀어줘.
```

```
오늘 장 마감 후에 나온 공시만 골라줘. 아직 종가에 반영되지 않은 것들이야.
```
> 공개 API(OpenDART)에는 접수 **날짜**만 있어서, 이 질문에는 따로 모은 접수 시각이 필요합니다.

### 한 종목을 파고들 때

```
삼성전자 최근 공시랑 분기 실적 정리해줘. 전년 동기 대비도.
```

```
005930 의 종가 흐름에서 최고가 대비 지금 몇 % 지점인지 계산해줘.
```
> `s/005930_history.json` 한 파일로 끝납니다.

```
SK하이닉스가 최근에 낸 공시 중에 자기주식 관련된 게 있어?
```

### 여러 종목을 훑을 때

```
시가총액 상위 20개 종목의 오늘 등락률을 표로 만들어줘.
```

```
최근 120일 안에 실적을 발표한 종목 중 영업이익이 전년 대비 늘어난 곳을 찾아줘.
```

```
52주 신고가를 찍은 종목이 오늘 몇 개야?
```

### 공시가 나온 뒤에 무슨 일이 있었는지

```
배당 결정 공시 뒤 5거래일 동안 시장 대비 수익률이 어땠는지 알려줘.
신뢰구간도 같이 보여주고, 0을 포함하는지 판단해줘.
```
> **숫자만 받아 오지 말고 구간을 같이 물어보세요.** 현재 숫자가 있는 18칸 중
> 15칸의 95% 구간이 0을 포함합니다. 그 사실을 감추지 않는 것이 이 표의 요점입니다.

```
공시 접수 시각이 장 시작 전인 건과 장 마감 후인 건을 나눠서,
공시 당일 수익률 중앙값을 각각 계산해줘.
```
> 접수 시각이 없으면 이 질문 자체가 불가능합니다.

### 데이터를 검증하고 싶을 때

```
https://aikstockdata.com/data/public/index.json 을 읽고
지금 데이터가 며칠 전 것인지, 신선도 상태가 뭔지 알려줘.
```
> 신선도는 저희 주장이 아니라 계산값입니다. 오래되면 스스로 `stale` 이라고 밝힙니다.

```
disclosure_impact.json 의 per_event 를 받아서 배당 결정 유형의 +5일
중앙값을 직접 다시 계산해줘. cluster 로 중복을 먼저 제거하고.
```
> **집계를 반박하라고 개별 값을 싣습니다.** 같은 `cluster` 는 한 번만 세야 합니다
> — 안 그러면 저희가 저질렀던 중복 계산이 재현됩니다.

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

## 공개 API 로는 바로 안 나오는 것

### 1. ★공시 접수 시각 (HH:MM) — 공개 API 어디에도 없습니다

DART 공시검색 API가 주는 접수 정보는 **날짜(YYYYMMDD)뿐**입니다. 개별 공시 뷰어에도,
공시검색 화면에도 시:분이 없습니다. 그런데 같은 날짜의 공시라도 **장중에 나온 것**과
**장 마감 후에 나온 것**은 그날 종가에 대해 정반대를 뜻합니다 — 앞의 것은 이미 주가에
반영됐고, 뒤의 것은 아직 반영되지 않았습니다.

저희는 시:분이 나오는 DART 최근공시 목록에서 이 값을 따로 모아 붙입니다.

```
https://aikstockdata.com/data/public/disclosures.json          # 저녁 발행(18:30 전후) · events[].receipt_time · session
https://aikstockdata.com/data/public/disclosures_intraday.json # 15:00 발행 · 그날 접수분 중 우리가 분류하는 유형(label)
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

유형별로 +1 / +5거래일 뒤의 **시장조정 수익률 중앙값**(종목 수익률 − 같은 기간
소속 지수 수익률)과 시장을 이긴 비율을 함께 냅니다. +20거래일은 그 유형의 표본이
차면 유형별로 나옵니다 — 응답의 `h20_status` 를 보세요(없다고 결론내지 말 것).
개별 값은 DART 접수번호를 열쇠로 싣기 때문에 원문과 대조할 수 있습니다.

표본이 20건 미만인 유형에는 **숫자를 넣지 않습니다.** 몇 건짜리 중앙값은 우연을 통계로
둔갑시킵니다. 95% 구간도 함께 싣는데, **현재 숫자가 있는 18칸 중 17칸의 구간이 0을 포함합니다.**
그 사실을 감추지 않는 것이 이 표의 요점입니다.

### 3. 종목당 일별 시세가 한 파일

`s/{종목코드}_history.json` — 쌓인 전 구간의 `[날짜, 종가, 거래량]`(2026-09-14 발행부터 250거래일에서 자르지 않고 매 거래일 한 행씩 늘어난다 — `count`·`period`·`max_days`(null)·`retention` 이 그 사실을 말한다).
행을 객체가 아니라 배열로 둡니다. 여섯 개 키 이름을 250번 반복하면 정보 없이 파일만
두 배가 됩니다(실측 14.3KB → 6.8KB).

### 4. 지수와 상승 종목 수를 따로 줍니다 — 둘이 어긋나기 때문에

`today.json` 은 KOSPI·KOSDAQ 종가와 상승·하락 종목 수를 **둘 다** 싣습니다. 이 둘은
자주 반대를 가리킵니다. 2026-08-03 에는 코스피가 5.12% 내렸는데 855종목이 오르고
518종목이 내렸습니다 — 지수는 시총 가중이고 종목 수는 한 종목 한 표이기 때문입니다.
대부분의 출처는 둘 중 하나만 주고 나머지는 같으려니 하게 만듭니다.

### 5. 거래일마다 날짜별 주소가 남습니다

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

인용용 **월간 동결본**은 허깅페이스의 `korea-equity-daily-YYYY-MM` 에 따로 있습니다 —
한 번 올리고 다시 고치지 않으므로 이름만 적으면 됩니다(리비전 해시 불필요).
`main` 은 **갱신될 때마다 통째로 덮어쓰이는 자리**라 인용에 쓸 수 없습니다.
그 스냅샷이 언제 것인지는 데이터셋 카드 첫 줄이 날짜로 밝힙니다 —
매 거래일 갱신되는 것은 미러가 아니라 [사이트의 원본](https://aikstockdata.com/data/public/index.json)입니다.

---

## 파일로 직접 받기 — 무엇이 얼마나 큰가

MCP 없이 주소만 쓸 때 필요한 표입니다. **크기는 정확한 수가 아니라 띠**입니다 —
파일은 매 거래일 커지므로 여기 수를 박아 두면 그날 저녁부터 거짓이 됩니다.
2026-09-16 19:30 KST 기준이고, 현재 값은 언제나
[`index.json`](https://aikstockdata.com/data/public/index.json) 의 `file_bytes` 에 있습니다.

> ⚠️ **대부분의 AI fetch 도구는 응답을 150 KB 안팎에서 자릅니다. 잘린 JSON 은
> 파싱되지 않습니다.** 지금 34개 중 **12개가 그 문턱을 넘습니다** —
> 표에서 ★큼 으로 표시된 것은 소형 대체본을 쓰세요. 대체본 목록은 카탈로그의
> `fetch_guide.small_alternatives` 에 있습니다.

| 파일 | 무엇이 들었나 | 크기 |
|---|---|---|
| [`earnings.json`](https://aikstockdata.com/data/public/earnings.json) | 어닝 스코어보드(실적 공시 롤링 120일 — rankings 에서 분리) | ★큼 (~2,960 KB) — 직접 받지 말고 `earnings_recent60.json` |
| [`disclosure_impact.json`](https://aikstockdata.com/data/public/disclosure_impact.json) | 공시 유형별 이후 주가 경로(시장조정 중앙값) | ★큼 (~1,939 KB) — 직접 받지 말고 `disclosure_impact_summary.json` |
| [`quotes.json`](https://aikstockdata.com/data/public/quotes.json) | 시세 전체(T+1 종가) | ★큼 (~731 KB) — 직접 받지 말고 `quotes_top300.json` |
| [`screen.json`](https://aikstockdata.com/data/public/screen.json) | ★조건 검색 재료(전 종목 한 줄 — 흑자전환·시총/영업이익 배수·52주 신고저) | ★큼 (~599 KB) — 직접 받지 말고 `screen_top300.json` |
| [`disclosures.json`](https://aikstockdata.com/data/public/disclosures.json) | 공시 브리핑 전체(쉬운 풀이·점수·접수 시각·재무원장) | ★큼 (~509 KB) — 직접 받지 말고 `disclosures_top100.json` |
| [`search_index.json`](https://aikstockdata.com/data/public/search_index.json) | 종목 인덱스(전 종목 code·이름·개별 JSON URL 리터럴 — 476KB, URL 조립 못 하는 환경용) | ★큼 (~476 KB) — 직접 받지 말고 `search_index_rows.json` |
| [`earnings_calendar.json`](https://aikstockdata.com/data/public/earnings_calendar.json) | ★실적 캘린더(이번 분기 접수 완료 / 아직 없음 + 법정 마감 D-day) | ★큼 (~439 KB) — 직접 받지 말고 `earnings_calendar_summary.json` |
| [`quotes_slim.json`](https://aikstockdata.com/data/public/quotes_slim.json) | 시세 경량판(핵심 6필드 · 374KB · 잘림 문턱 초과 — 전 종목이 필요할 때) | ★큼 (~374 KB) — 직접 받지 말고 `quotes_min.json` |
| [`dart_receipt_times.json`](https://aikstockdata.com/data/public/dart_receipt_times.json) | ★DART 공시 접수 시각(HH:MM) — 공개 API 에는 날짜만 있고 시:분이 없다 | ★큼 (~354 KB) — 직접 받지 말고 `dart_receipt_times_min.json` |
| [`quotes_en.csv`](https://aikstockdata.com/data/public/quotes_en.csv) | 시세 CSV(영문 헤더) | ★큼 (~286 KB) — 도구로 직접 받지 마세요 |
| [`quotes.csv`](https://aikstockdata.com/data/public/quotes.csv) | 시세 CSV | ★큼 (~286 KB) — 도구로 직접 받지 마세요 |
| [`search_index_min.json`](https://aikstockdata.com/data/public/search_index_min.json) | 종목 인덱스 경량판(코드·이름·시장 + URL 패턴 · 163KB · 잘림 문턱 초과 — 객체판) | ★큼 (~163 KB) — 직접 받지 말고 `search_index_rows.json` |
| [`disclosures.csv`](https://aikstockdata.com/data/public/disclosures.csv) | 공시 브리핑을 표로(엑셀·판다스로 바로 여는 열 구조) | 보통 (~121 KB) |
| [`earnings_recent60.json`](https://aikstockdata.com/data/public/earnings_recent60.json) | ★어닝 스코어보드 소형판(시총 상위 80종목 + 최근 70건 · 압축 재무 포함 — AI 잘림 안전) | 보통 (~112 KB) |
| [`search_index_rows.json`](https://aikstockdata.com/data/public/search_index_rows.json) | ★종목 인덱스 행 배열판(전 종목 — 잘림 안전 110KB · 별칭은 옆 파일) | 보통 (~110 KB) |
| [`quotes_min.json`](https://aikstockdata.com/data/public/quotes_min.json) | ★시세 최소판(전 종목 행 배열 — 잘림 안전 · 이름은 search_index_rows 와 조인) | 보통 (~107 KB) |
| [`quotes_top300.json`](https://aikstockdata.com/data/public/quotes_top300.json) | 시총 상위 300(내림차순 정렬 보장 — '시총 상위 N' 질문용) | 보통 (~84 KB) |
| [`disclosures_top100.json`](https://aikstockdata.com/data/public/disclosures_top100.json) | ★주요 공시 TOP100(중요도순 — 잘림 안전 71KB) | 보통 (~71 KB) |
| [`screen_top300.json`](https://aikstockdata.com/data/public/screen_top300.json) | 조건 검색 재료 소형판(시총 상위 300 — 잘림 안전) | 보통 (~69 KB) |
| [`notices.json`](https://aikstockdata.com/data/public/notices.json) | 정정·공지 로그(기계가독) | 보통 (~66 KB) |
| [`disclosure_impact_summary.json`](https://aikstockdata.com/data/public/disclosure_impact_summary.json) | ★'이 유형 공시 뒤 주가가 어땠나'의 정답 경로(유형별 요약만 — 대형본의 1/15) | 보통 (~61 KB) |
| [`disclosures_intraday.json`](https://aikstockdata.com/data/public/disclosures_intraday.json) | ★장중 공시 목록 — 매 거래일 15:00 수집, 접수 시각(HH:MM) 포함. 저녁 본 발행(18:30 전후)을 기다리지 않고 종가 전에 쓰라고 따로 낸다 | 보통 (~55 KB) |
| [`dart_receipt_times_min.json`](https://aikstockdata.com/data/public/dart_receipt_times_min.json) | ★공시가 장중에 나왔나 마감 뒤에 나왔나(접수 시각 최근분 소형판) | 보통 (~49 KB) |
| [`disclosures_intraday_min.json`](https://aikstockdata.com/data/public/disclosures_intraday_min.json) | ★종가 전에 오늘 공시를 보고 싶을 때(장중 15:00 수집분 경량판) | 작음 (~31 KB) |
| [`rankings.json`](https://aikstockdata.com/data/public/rankings.json) | 랭킹(성장·조용한 실적주·신고저) | 작음 (~28 KB) |
| [`press_turnaround.csv`](https://aikstockdata.com/data/public/press_turnaround.csv) | 기자용 — 흑자전환 표(CSV) — 전년 동기 영업적자 → 당기 흑자(DART 실측) 종목. 기준일 열 내장, 시가총액 내림차순. screen.json 의 is_turnaround 와 같은 판정. | 작음 (~25 KB) |
| [`search_index_aliases.json`](https://aikstockdata.com/data/public/search_index_aliases.json) | 종목 한글 별칭(코드 → 한글로 읽은 이름 — 이름 검색용) | 작음 (~16 KB) |
| [`market_index_history.json`](https://aikstockdata.com/data/public/market_index_history.json) | ★지수 시계열(코스피·코스닥 일별 종가 — 시장조정의 기준선) | 작음 (~16 KB) |
| [`today.json`](https://aikstockdata.com/data/public/today.json) | 오늘의 시장 다이제스트(하루 요약 — 등락·주요공시·성장·실적·집계) | 작음 (~11 KB) |
| [`earnings_calendar_summary.json`](https://aikstockdata.com/data/public/earnings_calendar_summary.json) | ★'이번 분기 실적, 몇 곳이 냈고 마감까지 며칠 남았나' | 작음 (~9 KB) |
| [`excluded.json`](https://aikstockdata.com/data/public/excluded.json) | 제외 종목 목록 | 작음 (~5 KB) |
| [`new_since_yesterday.json`](https://aikstockdata.com/data/public/new_since_yesterday.json) | ★직전 발행 이후 신규 실적 공시(폴링을 알림으로 — 무상태 클라이언트용) | 작음 (~3 KB) |
| [`press_owl_filings.csv`](https://aikstockdata.com/data/public/press_owl_filings.csv) | 기자용 — 올빼미 공시 통계(CSV) — 날짜별 DART 접수 건수를 장전·장중·장후·시각미확보로 나눈 표와 장후 비율(%). 범위는 dart_receipt_times.json 과 같다(전건 아님). | 작음 (~2 KB) |

<sub>이 표 33행은 카탈로그에서 **생성**됩니다 — 사이트에 파일이 늘면
여기 자동으로 실립니다. 폴더 단위(종목별 `s/`, 날짜별 `daily/`)의 파일 수와 총량은
`index.json` 의 `subtrees` 에 있습니다.</sub>

### 필드가 무슨 뜻인지 — 사람 말고 기계에게 물어보세요

각 파일의 필드 이름·자료형·단위는 **JSON Schema 9개**로 따로 나갑니다.
여기 표로 옮겨 적지 않은 이유가 있습니다 — 표는 낡고 스키마는 파일과 함께 갱신됩니다.

```
https://aikstockdata.com/data/public/schemas/       ← 스키마가 있는 곳
https://aikstockdata.com/data/public/index.json     ← `schemas` 배열이 전 목록
```

그래서 `index.json` 하나만 읽으면 **무슨 파일이 있고 · 얼마나 크고 · 언제 것이고 ·
각 필드가 무슨 뜻인지**까지 기계가 스스로 알아냅니다. 사람에게 물어볼 것이 없습니다.

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

실시간·분봉 시세가 없습니다(전 영업일 확정 종가, T+1). 증권사 유래의 컨센서스·목표주가·
선행 PER 이 없습니다 — PER(TTM)·PBR 은 **공공 원천만으로**(DART 정기보고서 + 확정 종가) 계산해 싣고,
못 내는 자리는 null 과 이유(`pe_note`·`pb_note`)를 적습니다. 주문 실행 기능이 없습니다.
**의도된 것입니다.**

---

## 출처와 라이선스

- **금융감독원 전자공시시스템(DART)** — 공시
- **금융위원회 공공데이터포털** — 일별 확정 종가

발행 파일(`/data/public/*`)의 이용 조건은 [`aiksd-public-1.1`](https://aikstockdata.com/licenses/aiksd-public-1.1.txt) 입니다.
**출처를 표기하면 비영리 목적으로 인용·이용할 수 있고, 상업적 재배포는 허용하지 않습니다.**

본 사이트가 공개하는 데이터(/data/public/*)는 출처를 표기하면 비영리 목적으로 인용·이용할 수 있습니다. 상업적(영리) 목적의 재배포는 어떤 경우에도 허용하지 않습니다. 시세(종가·거래량·시가총액 등)는 금융위원회 공공데이터포털이 원천이며 원천의 이용허락범위(공공누리 제4유형: 출처표시·상업적 이용금지·변경금지)와 제공기관 안내도 함께 따라야 하고, 공시 내용은 금융감독원 전자공시시스템(DART)의 이용 조건을 따릅니다. 다만 증권사 실시간 시세 등 원천의 실시간 정보를 그대로 재배포하는 것은 허용되지 않습니다.

인용할 때는 아래처럼 출처를 적어 주세요.

> 자료: 한국주식데이터(aikstockdata.com) — 원천: 금융감독원 DART · 금융위원회 공공데이터포털

이 저장소의 코드는 MIT 라이선스입니다(`LICENSE` 참조). 위 데이터 라이선스는 발행되는
JSON·CSV 파일에 적용되며 이 저장소의 코드에는 적용되지 않습니다.

발행 데이터는 정보 제공 목적이며 **투자 조언이 아닙니다**. 기계가 집계한 과거 기록이고
어떤 종목의 매수·매도를 권하지 않습니다.

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

**Claude Code** — one line:

```bash
claude mcp add --transport http aikstockdata https://mcp.aikstockdata.com/mcp
```

Or, for tools that take a config file (`claude_desktop_config.json` and friends):

```json
{
  "mcpServers": {
    "aikstockdata": {
      "type": "http",
      "url": "https://mcp.aikstockdata.com/mcp"
    }
  }
}
```

Twelve tools become available.

| Tool | What it does |
|---|---|
| `get_today` | Whole market in one call — breadth, tone, top filings |
| `search_stock` · `get_stock` | Find a ticker · full detail (price, financials, filings) |
| `get_rankings` · `get_market_summary` | Ranking tables · market digest |
| `get_disclosures` | **What was filed, and when exactly** — receipt time (HH:MM) and session (pre-open / intraday / after-close). Not exposed by any public Korean API |
| `list_stocks` | **The list, not just the count** — turnaround to profit, 52-week high/low, with a cap÷annualised-operating-income ceiling |
| `get_earnings` | **Preliminary results included** — filed ~2 weeks before the regular report |
| `get_earnings_calendar` | **Who has filed, who hasn't** — statutory deadline D-day plus a diff of what's new since the previous publish. For stateless agents, polling this replaces a webhook |
| `get_history` | Daily prices for one stock (its full stored span) + 52w high/low, drawdown, volume ratio |
| `get_disclosure_impact` | Market-adjusted price path at +1/+5 trading days after each filing type; +20 appears per type once it has enough samples — read `h20_status` |
| `get_data_urls` | Catalogue of raw JSON — the tool list is not the extent of the data |

Then just ask: *"오늘 한국 시장 어땠어?"* or *"Samsung Electronics latest disclosures?"* or
*"Which stocks turned profitable and trade under 10× operating income?"*

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
# 691,010 rows across 2,791 stocks (2025-09-01 → 2026-09-09) — a dated snapshot. The live
# per-stock files keep growing. Counts come from the dataset card and change every
# trading day — index.json's `coverage` has the live universe size.
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
| `today.json` | One‑day digest — **KOSPI/KOSDAQ index close**, breadth, top filings, rankings | small (~11 KB) |
| `s/{code6}.json` | **One stock** — quote, financials, recent filings, signals | small (~6 KB × 2,837 files) |
| `s/{code6}_history.json` | **One stock, full stored history** — `[date, close, volume]`; `count`/`period`/`retention` say how much | small (~11 KB × 2,796 files) |
| `disclosure_impact.json` | **What happened after each filing type** — market‑adjusted median return at +1/+5 trading days (+20 once that type's sample is full — see `h20_status`) | ★large (~1,939 KB) — fetch `disclosure_impact_summary.json` instead |
| `disclosures_intraday.json` | **Today's filings with receipt times (HH:MM)** — published 15:00 KST, before the close | medium (~55 KB) |
| `dart_receipt_times.json` | **Receipt number → HH:MM lookup** — not available from any public API | ★large (~354 KB) — fetch `dart_receipt_times_min.json` instead |
| `earnings_recent60.json` | Earnings scoreboard, latest 60 (truncation‑safe) | medium (~112 KB) |
| `daily/today_{YYYYMMDD}.json` | Archived daily digest (30‑day window) | small (~10 KB × 30 files) |
| `search_index_min.json` | Name → code lookup (URL patterns declared once) | ★large (~163 KB) — fetch `search_index_rows.json` instead |
| `disclosures_top100.json` | Top 100 filings by importance score, plain‑Korean explanation | medium (~71 KB) |
| `quotes_top300.json` | Top 300 by market cap, sort order guaranteed | medium (~84 KB) |
| `rankings.json` | Growth top 8, quiet performers, 52‑week highs/lows, movers | small (~28 KB) |
| `earnings.json` | Earnings filings, 120‑day rolling scoreboard | ★large (~2,960 KB) — fetch `earnings_recent60.json` instead |
| `quotes_slim.json` | All stocks, 6 core fields | ★large (~374 KB) — fetch `quotes_min.json` instead |
| `quotes.json` | All stocks, all fields | ★large (~731 KB) — fetch `quotes_top300.json` instead |
| `disclosures.json` | All filings from the last 7 days, with financial detail | ★large (~509 KB) — fetch `disclosures_top100.json` instead |
| `excluded.json` | Stocks in the universe with no quote, and why | small (~5 KB) |
| `notices.json` | Machine‑readable incident and correction log | medium (~66 KB) |
| `quotes.csv` | All stocks as CSV (Korean headers) | ★large (~286 KB) — do not fetch directly |
| `quotes_en.csv` | All stocks as CSV (English headers) | ★large (~286 KB) — do not fetch directly |

<sub>**Sizes are bands, not fixed numbers.** Files grow every trading day, so a number
written here is stale the next evening. Measured 2026-09-16 19:30 KST from
[`index.json`](https://aikstockdata.com/data/public/index.json) — its `file_bytes` always
has the current byte count, and `fetch_guide.small_alternatives` names the smaller file to
use instead. Right now 12 of 34 files are over the 150 KB
truncation threshold.</sub>

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

## What the public APIs don't give you directly

### 0. Filing receipt times (HH:MM) — not in the public DART API

The DART search API returns a receipt **date**, never a time. Neither does the filing viewer,
nor the search screen. But an intraday filing and an after-close filing mean opposite things
for that day's close: the first is already in the price, the second is not.

```
/data/public/disclosures.json           # around 18:30 KST · events[].receipt_time and .session
/data/public/disclosures_intraday.json  # 15:00 KST · filings received that day, for the types we classify (label)
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

For each filing type: the **median market‑adjusted return** at +1 / +5 trading days
(stock return minus its own index over the same window), plus how often it beat the market.
+20 trading days appears per type once that type's sample is full — read `h20_status`
in the response before concluding it's missing.
Per‑filing values are keyed by DART receipt number, so you can join back to the original document.
(`배당 결정` = dividend decision. Live values as of 2026.09.16; they change every trading evening — always read the interval from the file, not from this page. This block is generated from the live summary, not typed here.)

```json
{
  "label": "배당 결정",
  "h5": {
    "n": 112,
    "enough": true,
    "median_excess_pct": -1.12,
    "median_ci95": [
      -4.01,
      0.16
    ],
    "ci_includes_zero": true,
    "up_ratio_pct": 42.9
  }
}
```

**Read `median_ci95` before `median_excess_pct`.** Of the cells currently carrying a
number, most have an interval spanning zero — those values are not distinguishable
from zero. The interval ships in the same object so you cannot take the median alone
by accident.

Types with fewer than 20 samples are **not** given a number — a median over a handful of cases
turns coincidence into a statistic. This is a record of what happened, not a claim about cause,
and not a prediction.

### 2. One year of daily prices per stock, as one small file

`s/{code6}_history.json` — the stock's full stored history of `[date, close, volume]`; since the 2026-09-14 publish it is not cut at 250 days and gains one row every trading day.
Rows are arrays, not objects: repeating six key names 250 times doubles the file for no
information (measured: 14.3 KB → 6.8 KB).

### 3. Index and breadth are kept separate — because they disagree

`today.json` carries both the KOSPI/KOSDAQ close **and** the advance/decline count, because they
routinely point opposite ways. On 2026‑08‑03 KOSPI fell 5.12% while 855 stocks rose and 518 fell:
the index is cap‑weighted, the count is one vote per stock. Most sources give you only one of the
two and let you assume they agree.

### 4. A dated page per trading day

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

No real‑time quotes (data is the previous trading day's settled close, T+1). No analyst consensus,
target prices or forward PER from brokerage sources — trailing PER (TTM) and PBR *are* published, computed
from public filings (DART) and settled closes only, with `null` plus a reason (`pe_note`/`pb_note`) where
they cannot be computed. No order execution. These are deliberate.

---

## Data sources & license

Data derives from Korean public sources:

- **금융감독원 전자공시시스템 (DART)** — regulatory filings
- **금융위원회 공공데이터포털** — daily settled closing prices

The published files (`/data/public/*`) are licensed under [`aiksd-public-1.1`](https://aikstockdata.com/licenses/aiksd-public-1.1.txt).
**Non-commercial use with attribution; commercial redistribution is not permitted.**

Data published here (/data/public/*) may be quoted and used for non-commercial purposes with attribution. Commercial redistribution is not permitted in any form. Market prices come from the Financial Services Commission's public data portal and are also subject to that source's licence (KOGL Type 4: attribution, non-commercial, no derivatives) and notices; disclosure content follows FSS DART's terms. Real-time quotes are never redistributed here.

Cite as:

> 자료: 한국주식데이터(aikstockdata.com) — 원천: 금융감독원 DART · 금융위원회 공공데이터포털

The code in this repository is MIT licensed (see `LICENSE`). The data license above applies to the
published JSON/CSV files, not to this repository's code.

The data is provided for information purposes and is **not investment advice**. It is a machine
aggregation of past records and does not recommend buying or selling any security.

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
