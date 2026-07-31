"""aikstockdata quickstart — Korean stock data, no API key.

    python quickstart.py            # today's market digest
    python quickstart.py 005930     # one stock (Samsung Electronics)
    python quickstart.py 삼성전자    # look up by name, then fetch

Standard library only. No dependencies.
"""
import json
import sys
import urllib.parse
import urllib.request

BASE = "https://aikstockdata.com"


def get(path):
    """Fetch a public JSON file. A User-Agent header is required."""
    req = urllib.request.Request(BASE + path, headers={"User-Agent": "aikstockdata-example"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def market_digest():
    t = get("/data/public/today.json")
    b = t.get("market_breadth") or {}
    print(f"기준일(price) {t.get('quote_as_of')} · 공시 수록 {t.get('disclosure_through')}")
    print(f"상승 {b.get('up')} · 하락 {b.get('down')} · 보합 {b.get('flat')} · 분위기 {b.get('tone')}")
    print("\n주요 공시:")
    for d in (t.get("top_disclosures") or [])[:5]:
        print(f"  [{d.get('score')}] {d.get('name')} — {d.get('label')}")
        if d.get("fact"):
            print(f"        {d['fact']}")


def find_code(name):
    """Name -> 6-digit code. The lightweight index declares URL patterns once."""
    idx = get("/data/public/search_index_min.json")
    for it in idx["items"]:
        if it["n"] == name:
            return it["c"]
    hits = [it for it in idx["items"] if name in it["n"]]
    if hits:
        return hits[0]["c"]
    raise SystemExit(f"'{name}' 를 찾지 못했습니다.")


def _won(v):
    """None stays None — never render a missing value as 0."""
    if v is None:
        return "n/a"
    return f"{v / 1e12:,.2f}조" if abs(v) >= 1e12 else f"{v / 1e8:,.0f}억"


def stock(code):
    s = get(f"/data/public/s/{code}.json")          # ~5 KB per stock
    q = s.get("quote") or {}
    print(f"{s.get('name_ko')} ({s.get('code')}) · {s.get('market')}")
    # null means 'not provided'. 0 means an actual measured zero (see has_trade).
    print(f"  종가 {q.get('close'):,}원 · 등락률 {q.get('change_pct')}% · 거래량 {q.get('volume'):,}")
    print(f"  시가총액 {_won(q.get('market_cap_krw'))} · 기준일 {q.get('as_of')}"
          f" · 거래여부 has_trade={q.get('has_trade')}")

    fin = s.get("financials") or {}
    if fin:
        print(f"  재무 {fin.get('period')} ({fin.get('basis')}) — 단위 {fin.get('unit')}")
        for key, label in (("revenue", "매출액"), ("operating_income", "영업이익"),
                           ("net_income", "순이익")):
            m = fin.get(key) or {}
            yoy = m.get("yoy_pct")
            print(f"    {label} {_won(m.get('current'))}"
                  + (f" (전년 대비 {yoy:+.1f}%)" if yoy is not None else ""))

    for d in (s.get("recent_disclosures") or [])[:3]:
        print(f"  공시 {d.get('rcept_dt')} [{d.get('type')}] {d.get('fact') or d.get('title')}")
        if d.get("dart_url"):
            print(f"        원문 {d['dart_url']}")


def check_freshness():
    """Always check before quoting numbers: status is computed, not asserted."""
    f = get("/data/public/index.json")["freshness"]
    if f["status"] != "fresh":
        print(f"⚠ 데이터 지연: {f['status']} (시세 기준일 {f['quote_as_of']}, "
              f"{f.get('quote_as_of_age_days')}일 경과)")
    return f


if __name__ == "__main__":
    check_freshness()
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    if not arg:
        market_digest()
    elif arg.isdigit() and len(arg) == 6:
        stock(arg)
    else:
        stock(find_code(arg))
