# -*- coding: utf-8 -*-
"""test_client.py — aikstockdata SDK 코어 계약.

이 SDK 가 존재하는 이유는 '편의'가 아니라 **아는 것을 기본값으로 만드는 것**이다.
그래서 검사도 편의가 아니라 그 지식들을 지킨다:

  [1] 의존성 0 — requests·pandas 최상위 import 가 없다 (정규식 census, 결과를 찍는다)
  [2] URL 조립 — 메서드마다 어느 주소를 부르는지 (가짜 urlopen 으로 전건 기록)
  [3] ★UA 를 항상 붙인다 — 기본 urllib UA 는 CDN 에서 403 이다
  [4] as_of 를 감추지 않는다 — 모든 응답이 '언제 것인가'를 내놓는다
  [5] 종목코드 정수 입력 — 6자리로 고치되 **stderr 에 경고**한다(조용한 교정 금지)
  [6] 메모리 캐시 — 같은 URL 재요청이 네트워크를 두 번 타지 않는다
  [7] pandas 없을 때 to_frame() 이 친절한 메시지를 던진다
  [8] 버전이 한 곳에만 있다 (pyproject.toml 이 생기면 dynamic 이어야 한다)
  [9] ★라이브 결함 주입 — UA 를 빼고 실제로 요청해 403 을 확인한다
      (네트워크가 없으면 **건너뛰었다고 출력**하고 skip 을 센다 — 조용한 continue 금지)

실행: python tests/test_client.py
"""
from __future__ import annotations

import io
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

if getattr(sys.stdout, "encoding", "").lower() not in ("utf-8", "utf8"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

PKG_ROOT = Path(__file__).resolve().parent.parent      # .../python
sys.path.insert(0, str(PKG_ROOT))

FAILS: list[str] = []
SEEN = 0
SKIPPED: list[str] = []


def chk(label, cond, detail=""):
    global SEEN
    SEEN += 1
    print(("  OK   " if cond else "  FAIL ") + label + ("" if cond else f"  {detail}"))
    if not cond:
        FAILS.append(label)


def skip(label, why):
    SKIPPED.append(label)
    print(f"  SKIP {label} — {why}")


# ── 가짜 응답 ────────────────────────────────────────────────────────────
# 실물 봉투 모양 그대로다(2026-08-17 라이브 today.json 실측: 13키).
ENVELOPE = {
    "schema_version": "1.1", "name": "표본", "description": "검사용",
    "as_of": "20260813", "as_of_iso": "2026-08-13",
    "generated_kst": "2026-08-17 18:10", "generated_at": "2026-08-17T18:10:00+09:00",
    "snapshot_id": "20260817-181042", "code_rev": "abc1234",
    "source": "금융위·DART", "license": "공공누리",
    "citation": "한국주식데이터", "disclaimer": "투자 자문이 아닙니다",
}


def _canned(url: str) -> bytes:
    doc = dict(ENVELOPE)
    if "search_index_min" in url:
        doc["items"] = [{"c": "005930", "n": "삼성전자", "m": "KOSPI"},
                        {"c": "000660", "n": "SK하이닉스", "m": "KOSPI"},
                        {"c": "035720", "n": "카카오", "m": "KOSPI"}]
    elif "rankings" in url:
        doc["성장"] = [{"code": "005930"}]
        doc["조용한실적주"] = [{"code": "000660"}]
    else:
        doc["items"] = [{"code": "005930", "close": 71500}]
    return json.dumps(doc, ensure_ascii=False).encode("utf-8")


class _FakeResp:
    def __init__(self, body):
        self._b = body

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def main():
    import aikstockdata as A
    from aikstockdata import client as C

    # ── [1] 의존성 census ────────────────────────────────────────────────
    print("[1] 의존성 0 — 최상위 import census")
    srcs = {p.name: p.read_text(encoding="utf-8")
            for p in (PKG_ROOT / "aikstockdata").glob("*.py")}
    # ★정규식으로 세면 안 된다. 처음에 `^\s*import pandas` 로 셌더니 **함수 안의
    #  지연 import 까지 최상위로 잡혀** 거짓 실패했다(들여쓰기를 \s* 가 먹는다).
    #  '최상위'는 들여쓰기가 아니라 **모듈 본문에 있는가**로 정의된다 — AST 로 센다.
    #  이러면 지연 import 를 쓰라는 규칙과 최상위 금지 규칙이 서로 안 싸운다.
    import ast as _ast
    hits = {m: 0 for m in ("requests", "pandas", "numpy", "httpx")}
    lazy = 0
    for name, s in srcs.items():
        tree = _ast.parse(s)
        for node in tree.body:                       # 모듈 본문 = 최상위
            if isinstance(node, _ast.Import):
                for a in node.names:
                    root = a.name.split(".")[0]
                    if root in hits:
                        hits[root] += 1
            elif isinstance(node, _ast.ImportFrom) and node.module:
                root = node.module.split(".")[0]
                if root in hits:
                    hits[root] += 1
        for node in _ast.walk(tree):                 # 전체 - 최상위 = 지연
            if isinstance(node, (_ast.Import, _ast.ImportFrom)) and node not in tree.body:
                lazy += 1
    print(f"      소스 {len(srcs)}개 {sorted(srcs)} · 최상위 서드파티 " +
          " · ".join(f"{k} {v}건" for k, v in hits.items()) +
          f" · 함수 안 지연 import {lazy}건")
    chk("[1] 소스를 찾았다(0개면 census 가 안 돈 것)", len(srcs) >= 2, len(srcs))
    chk("[1] ★서드파티 최상위 import 0건(설치 장벽 = 사용 장벽)",
        sum(hits.values()) == 0, str(hits))
    # pandas 는 함수 안에서만 부른다 — 그것까지 없으면 to_frame 이 거짓말이다
    chk("[1] pandas 는 함수 안에서 지연 import 한다(extras)",
        any("import pandas as pd" in s for s in srcs.values()))

    # ── [2][3][4][6] 가짜 urlopen 으로 전 메서드 ──────────────────────────
    print("[2][3] URL 조립과 UA — 가짜 urlopen 으로 전건 기록")
    calls: list[tuple[str, dict]] = []
    real_urlopen = C.urllib.request.urlopen

    def fake_urlopen(req, timeout=None):
        calls.append((req.full_url, dict(req.headers)))
        return _FakeResp(_canned(req.full_url))

    C.urllib.request.urlopen = fake_urlopen
    try:
        c = A.Client(min_interval=0)
        results = {
            "get_catalog": c.get_catalog(), "get_today": c.get_today(),
            "get_snapshot": c.get_snapshot("005930"),
            "get_history": c.get_history("005930"),
            "get_rankings": c.get_rankings(),
            "get_rankings(kind)": c.get_rankings("성장"),
            "get_disclosures": c.get_disclosures(),
            "get_disclosures(top100)": c.get_disclosures(top100=True),
            "get_intraday_disclosures": c.get_intraday_disclosures(),
            "get_earnings_calendar": c.get_earnings_calendar(),
            "list_stocks": c.list_stocks(),
        }
        found = c.search("삼성")
        print(f"      메서드 {len(results)}개 호출 · 요청 {len(calls)}건")
        for u, _ in calls:
            print(f"        {u}")
        chk("[2] 모든 메서드가 실제로 요청을 냈다(무동작 아님)", len(calls) >= 10, len(calls))
        chk("[2] 종목별 경로가 코드로 조립된다",
            any(u.endswith("/s/005930.json") for u, _ in calls)
            and any(u.endswith("/s/005930_history.json") for u, _ in calls))
        chk("[2] top100 플래그가 다른 파일을 부른다",
            any("disclosures_top100.json" in u for u, _ in calls)
            and any(u.endswith("/disclosures.json") for u, _ in calls))
        chk("[2] search() 가 인덱스를 받아 로컬에서 거른다", len(found) == 1,
            str(found))

        uas = {h.get("User-agent") or h.get("User-Agent") for _, h in calls}
        print(f"      보낸 UA: {uas}")
        chk("[3] ★모든 요청에 UA 가 붙는다(없으면 403)", all(uas) and None not in uas)
        chk("[3] UA 에 패키지 이름·버전이 들어간다",
            all("aikstockdata-python/" in (u or "") for u in uas), str(uas))

        print("[4] as_of 노출")
        bad = [k for k, v in results.items() if not v.as_of_info.get("as_of")]
        chk("[4] ★모든 응답이 as_of 를 내놓는다", not bad, str(bad))
        chk("[4] as_of_info 는 없는 키를 지우지 않고 None 으로 남긴다",
            set(results["get_today"].as_of_info) >= {"as_of", "snapshot_id",
                                                     "generated_kst", "as_of_iso"})
        chk("[4] kind 로 고른 랭킹도 as_of 를 잃지 않는다",
            results["get_rankings(kind)"].get("as_of") == "20260813")
        chk("[4] 원본 dict 를 가리지 않는다(우리가 안 붙인 키도 보인다)",
            results["get_today"].get("disclaimer") == "투자 자문이 아닙니다")

        print("[6] 메모리 캐시")
        n_before = len(calls)
        c.get_today(); c.get_today()
        chk("[6] 같은 URL 재요청이 네트워크를 안 탄다", len(calls) == n_before,
            f"{len(calls) - n_before}건 더 나감")
        c2 = A.Client(min_interval=0, cache=False)
        n2 = len(calls); c2.get_today(); c2.get_today()
        chk("[6] cache=False 면 매번 나간다(대조군)", len(calls) - n2 == 2,
            f"{len(calls)-n2}건")

        # ── [5] 정수 코드 ────────────────────────────────────────────────
        print("[5] 정수 종목코드 — 고치되 말한다")
        err = io.StringIO()
        real_err, sys.stderr = sys.stderr, err
        try:
            c3 = A.Client(min_interval=0)
            c3.get_snapshot(5930)
        finally:
            sys.stderr = real_err
        msg = err.getvalue()
        chk("[5] 6자리로 채워 부른다", any(u.endswith("/s/005930.json")
                                     for u, _ in calls[-1:]), calls[-1][0])
        chk("[5] ★경고를 stderr 에 찍는다(조용한 교정 금지)",
            "005930" in msg and "문자열" in msg, repr(msg[:80]))
    finally:
        C.urllib.request.urlopen = real_urlopen

    # ── [7] pandas 없을 때 ───────────────────────────────────────────────
    print("[7] pandas extras 안내")
    r = C.Response(dict(ENVELOPE, items=[{"a": 1}]))
    real_mods = dict(sys.modules)
    sys.modules["pandas"] = None            # import pandas -> ImportError
    try:
        try:
            r.to_frame()
            chk("[7] pandas 없으면 안내를 던진다", False, "예외가 안 났다")
        except ImportError as e:
            chk("[7] ★설치 방법을 알려 준다",
                "aikstockdata[pandas]" in str(e), str(e)[:60])
        except Exception as e:
            chk("[7] ImportError 여야 한다", False, f"{type(e).__name__}: {e}")
    finally:
        sys.modules.clear()
        sys.modules.update(real_mods)

    # ── [8] 버전 한 곳 ───────────────────────────────────────────────────
    print("[8] 버전이 한 곳에만 있다")
    chk("[8] __version__ 이 있다", bool(A.__version__), A.__version__)
    pyproj = PKG_ROOT / "pyproject.toml"
    if pyproj.exists():
        txt = pyproj.read_text(encoding="utf-8")
        lit = re.search(r'^\s*version\s*=\s*"[\d.]+"', txt, re.M)
        chk("[8] ★pyproject 가 버전을 베끼지 않는다(dynamic 이어야 한다)",
            lit is None and "dynamic" in txt, lit.group(0) if lit else "dynamic 없음")
    else:
        skip("[8] pyproject 대조", "아직 없다(P6-8 이 만든다) — 생기면 이 검사가 잡는다")

    # ── [9] 라이브 결함 주입 — UA 없이 정말 403 인가 ──────────────────────
    print("[9] 결함 주입 — UA 를 빼고 실제로 요청한다")
    url = f"{A.BASE}/data/public/index.json"
    try:
        urllib.request.urlopen(url, timeout=20)      # 기본 urllib UA
        chk("[9] ★UA 없으면 403 이다(이 SDK 의 존재 이유)", False,
            "200 이 왔다 — CDN 정책이 바뀌었을 수 있다. UA 기본값 근거를 재확인하라")
    except urllib.error.HTTPError as e:
        chk("[9] ★UA 없으면 403 이다(이 SDK 의 존재 이유)", e.code == 403, f"HTTP {e.code}")
        # 대조군: 우리 UA 로는 통과해야 한다
        try:
            body = A.Client(min_interval=0).fetch("/data/public/index.json")
            chk("[9] 우리 UA 로는 통과한다(대조군)", bool(body.get("name")),
                sorted(body)[:5])
        except Exception as e2:
            chk("[9] 우리 UA 로는 통과한다(대조군)", False, f"{type(e2).__name__}: {e2}")
    except Exception as e:
        skip("[9] UA 403 회귀", f"네트워크 불가({type(e).__name__}) — 오프라인 환경")

    print("-" * 62)
    print(f"검사 {SEEN}건 · 실패 {len(FAILS)}건 · 건너뜀 {len(SKIPPED)}건")
    for f in FAILS:
        print("  -", f)
    for s in SKIPPED:
        print("  (건너뜀)", s)
    return 1 if FAILS else 0


if __name__ == "__main__":
    raise SystemExit(main())
