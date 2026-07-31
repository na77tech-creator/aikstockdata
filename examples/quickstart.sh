#!/usr/bin/env bash
# aikstockdata quickstart — Korean stock data with curl + jq. No API key.
set -euo pipefail
BASE="https://aikstockdata.com"

echo "── 1. Always check freshness first (status is computed, not asserted) ──"
curl -s "$BASE/data/public/index.json" | jq '.freshness'

echo
echo "── 2. Today's market digest (7 KB) ──"
curl -s "$BASE/data/public/today.json" \
  | jq '{quote_as_of, disclosure_through, breadth: .market_breadth,
         top: [.top_disclosures[]? | {name, label, score, fact}] | .[0:3]}'

echo
echo "── 3. One stock — Samsung Electronics 005930 (~5 KB) ──"
curl -s "$BASE/data/public/s/005930.json" \
  | jq '{name_ko, market, quote: {close: .quote.close, change_pct: .quote.change_pct,
         as_of: .quote.as_of, has_trade: .quote.has_trade},
         revenue: .financials.revenue}'

echo
echo "── 4. Name → code lookup ──"
curl -s "$BASE/data/public/search_index_min.json" \
  | jq -r '.items[] | select(.n | test("카카오")) | "\(.c)  \(.n)  \(.m)"' | head -5

echo
echo "── 5. Top filings by importance (80 KB — the full file is 380 KB) ──"
curl -s "$BASE/data/public/disclosures_top100.json" \
  | jq -r '.items[0:5][] | "[\(.score)] \(.name) — \(.label)"'

echo
echo "── 6. Growth ranking, with the formula components (17 KB) ──"
curl -s "$BASE/data/public/rankings.json" \
  | jq -r '.growth_top8[0:5][] | "\(.name)  score=\(.score)  b1=\(.b1) b2=\(.b2) b3=\(.b3) b4=\(.b4)"'
