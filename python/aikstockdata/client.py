# -*- coding: utf-8 -*-
"""aikstockdata — 한국주식데이터 공개 JSON 을 위한 얇은 클라이언트.

설계 규칙(P6-6). 이 파일이 지키려는 것은 '기능'이 아니라 **아는 것을 기본값으로
만드는 것**이다. 예제는 복사되는 순간부터 낡지만, 패키지는 한 곳에 산다.

  · **의존성 0.** urllib.request + json 만 쓴다. requests 조차 쓰지 않는다 —
    설치 장벽이 곧 사용 장벽이다. pandas 는 extras 이고 없으면 친절히 말한다.
  · **UA 는 항상 붙인다.** 표준 urllib 의 기본 UA(Python-urllib/x.y)는 CDN 봇
    필터에 403 을 받는다. 우리가 그 사실을 아는데 소비자가 다시 알아낼 이유가 없다.
  · **as_of 를 감추지 않는다.** 이 데이터는 실시간이 아니다(매 거래일 18:10 KST
    발행, 시세는 T+1 확정 종가). 그것을 감추는 SDK 는 오답의 원인이 된다.
    모든 반환값에 as_of·as_of_iso·snapshot_id·generated_kst 를 그대로 싣는다.
  · **종목코드는 언제나 문자열.** 정수가 오면 6자리로 채우되 **경고를 찍는다** —
    조용히 고치면 소비자가 자기 버그를 모른다.
  · **캐시는 메모리에만.** 파일 캐시는 만들지 않는다(디스크 정책은 소비자마다 다르다).

이 데이터는 정보 제공이며 투자 자문이 아니다. 랭킹은 공개 재무제표로부터의
기계적 계산이지 종목 추천이 아니다.
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request

__all__ = ["Client", "Response", "ApiError", "BASE"]

BASE = "https://aikstockdata.com"

# ── 봉투 키 ────────────────────────────────────────────────────────────────
# 발행물이 모든 공개 JSON 에 같은 자리로 붙이는 13키 중, 소비자가 '언제 것인가'를
# 판단할 때 쓰는 것들. 손으로 고른 목록이므로 Response 는 **없으면 없는 대로** 둔다
# (여기 이름이 늘어도 원본 dict 는 그대로 살아 있어 소비자가 직접 볼 수 있다).
_ASOF_KEYS = ("as_of", "as_of_iso", "generated_kst", "generated_at",
              "snapshot_id", "code_rev", "quote_basis_date")


class ApiError(RuntimeError):
    """HTTP·네트워크·JSON 파싱 실패. status 가 있으면 HTTP 상태 코드."""

    def __init__(self, msg: str, *, status: int | None = None, url: str = ""):
        super().__init__(msg)
        self.status = status
        self.url = url


class Response(dict):
    """받은 JSON 그대로인 dict. + as_of 계열을 속성으로도 노출한다.

    dict 를 그대로 상속하는 이유: 우리가 이름을 붙이지 않은 필드를 소비자가
    못 보게 되면 안 된다. 편의는 더하되 원본은 가리지 않는다.
    """

    #: 이 응답을 받아 온 URL
    url: str = ""

    def __init__(self, payload, url: str = ""):
        if isinstance(payload, dict):
            super().__init__(payload)
        else:
            # 최상위가 리스트인 파일도 있다(예: 일부 소형판). dict 계약을 지키려고
            # items 로 감싸되, 원본이 리스트였다는 사실을 남긴다.
            super().__init__({"items": payload, "_toplevel_was_list": True})
        self.url = url

    def __getattr__(self, name):
        if name in _ASOF_KEYS:
            return self.get(name)
        raise AttributeError(name)

    @property
    def as_of_info(self) -> dict:
        """'언제 것인가' 한 줌 — 없는 키는 빼지 않고 None 으로 남긴다.

        빼 버리면 '그런 필드가 없는 파일'과 '값이 안 실린 파일'이 구분되지 않는다.
        """
        return {k: self.get(k) for k in _ASOF_KEYS}

    def to_frame(self, key: str | None = None):
        """pandas.DataFrame 으로. pandas 는 extras 다."""
        try:
            import pandas as pd
        except ImportError:
            raise ImportError(
                "to_frame() 는 pandas 가 필요합니다. "
                "설치: pip install aikstockdata[pandas]\n"
                "(pandas 없이 쓰려면 이 객체는 그냥 dict 이므로 그대로 다루면 됩니다)"
            ) from None
        if key is not None:
            return pd.DataFrame(self.get(key) or [])
        for cand in ("items", "rows", "data", "stocks", "events", "list"):
            v = self.get(cand)
            if isinstance(v, list):
                return pd.DataFrame(v)
        raise KeyError(
            "표로 만들 리스트를 못 찾았습니다. key= 로 직접 지정하세요. "
            f"최상위 키: {sorted(self)[:12]}")


def _normalize_code(code) -> str:
    """종목코드를 6자리 문자열로. 정수가 오면 고쳐 주되 **말한다.**"""
    if isinstance(code, int):
        fixed = f"{code:06d}"
        print(f"[aikstockdata] 종목코드는 문자열이어야 합니다 — {code!r} 를 "
              f"'{fixed}' 로 봤습니다. 앞자리 0 이 이미 사라진 뒤일 수 있으니 "
              f"원본을 확인하세요(예: 5930 -> '005930').", file=sys.stderr)
        return fixed
    s = str(code).strip()
    if not s:
        raise ValueError("종목코드가 비었습니다")
    return s.zfill(6) if s.isdigit() and len(s) < 6 else s


class Client:
    """공개 JSON 을 읽는 얇은 층. 인증 없음 — 이 데이터는 100% 공개다."""

    def __init__(self, base: str = BASE, *, timeout: float = 30.0,
                 min_interval: float = 0.2, user_agent: str | None = None,
                 cache: bool = True):
        from . import __version__
        self.base = base.rstrip("/")
        self.timeout = timeout
        self.min_interval = min_interval    # 공정 이용 — 이 데이터는 하루 1회 바뀐다
        self.user_agent = user_agent or f"aikstockdata-python/{__version__} (+{BASE})"
        self._cache: dict[str, Response] = {} if cache else None
        self._last_req = 0.0

    # ── 하부 ────────────────────────────────────────────────────────────
    def fetch(self, path: str) -> Response:
        """공개 경로 하나를 읽는다. 같은 프로세스 안 같은 URL 은 메모리 캐시."""
        url = path if path.startswith("http") else f"{self.base}/{path.lstrip('/')}"
        if self._cache is not None and url in self._cache:
            return self._cache[url]
        gap = self.min_interval - (time.monotonic() - self._last_req)
        if gap > 0:
            time.sleep(gap)
        req = urllib.request.Request(url, headers={
            # ★이 한 줄이 이 패키지가 존재하는 이유의 절반이다. 기본 UA 는 403 이다.
            "User-Agent": self.user_agent,
            "Accept": "application/json, text/plain, */*",
        })
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                raw = r.read()
        except urllib.error.HTTPError as e:
            hint = ""
            if e.code == 403:
                hint = (" — User-Agent 가 비었거나 기본 urllib UA 로 보입니다. "
                        "이 패키지는 항상 UA 를 붙이므로, 직접 헤더를 덮어썼는지 보세요.")
            raise ApiError(f"HTTP {e.code} {url}{hint}", status=e.code, url=url) from None
        except Exception as e:
            raise ApiError(f"{type(e).__name__}: {e} ({url})", url=url) from None
        self._last_req = time.monotonic()
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception as e:
            raise ApiError(f"JSON 파싱 실패({type(e).__name__}) {url}", url=url) from None
        out = Response(payload, url)
        if self._cache is not None:
            self._cache[url] = out
        return out

    # ── 공개 메서드 ──────────────────────────────────────────────────────
    def get_catalog(self) -> Response:
        """데이터 카탈로그. **여기서 시작한다** — 무엇이 있는지 이 파일이 말한다."""
        return self.fetch("/data/public/index.json")

    def get_today(self) -> Response:
        """오늘의 시장 다이제스트(하루 요약)."""
        return self.fetch("/data/public/today.json")

    def get_snapshot(self, code) -> Response:
        """종목별 소형 JSON."""
        return self.fetch(f"/data/public/s/{_normalize_code(code)}.json")

    def get_history(self, code) -> Response:
        """종목별 1년 일별 종가·거래량."""
        return self.fetch(f"/data/public/s/{_normalize_code(code)}_history.json")

    def get_rankings(self, kind: str | None = None) -> Response:
        """랭킹(성장·조용한 실적주·신고저). kind 를 주면 그 절만 골라 준다.

        ★기계적 계산이지 종목 추천이 아니다.
        """
        doc = self.fetch("/data/public/rankings.json")
        if kind is None:
            return doc
        if kind not in doc:
            raise KeyError(f"랭킹 '{kind}' 가 없습니다. 있는 것: "
                           f"{[k for k in doc if not k.startswith('_')][:20]}")
        out = Response({kind: doc[kind]}, doc.url)
        out.update({k: doc.get(k) for k in _ASOF_KEYS if k in doc})
        return out

    def get_disclosures(self, top100: bool = False) -> Response:
        """공시 브리핑. top100=True 면 중요도순 상위 100건(잘림 안전)."""
        return self.fetch("/data/public/disclosures_top100.json" if top100
                          else "/data/public/disclosures.json")

    def get_intraday_disclosures(self) -> Response:
        """장중 공시 목록 — 매 거래일 15:00 수집, 접수 시각(HH:MM) 포함.

        ★공개 API 에는 접수 '날짜'만 있고 시:분이 없다. 그 한 칸이 '장중 공시'와
        '장 마감 후 공시'를 가른다 — 그 둘은 그날 종가에 대해 정반대를 뜻한다.
        """
        return self.fetch("/data/public/disclosures_intraday.json")

    def get_earnings_calendar(self) -> Response:
        """실적 캘린더(이번 분기 접수 완료 / 아직 없음 + 법정 마감 D-day)."""
        return self.fetch("/data/public/earnings_calendar.json")

    def list_stocks(self) -> Response:
        """종목 인덱스 경량판(코드·이름·시장)."""
        return self.fetch("/data/public/search_index_min.json")

    def search(self, name: str) -> list:
        """이름으로 종목 찾기 — 부분 일치, 대소문자·공백 무시.

        인덱스를 통째로 받아 로컬에서 거른다(검색 API 가 따로 없다. 이 데이터는
        하루 1회 바뀌므로 한 번 받아 두고 쓰는 것이 옳다).
        """
        q = "".join(str(name).split()).lower()
        if not q:
            return []
        doc = self.list_stocks()
        rows = doc if isinstance(doc, list) else (
            doc.get("items") or doc.get("stocks") or doc.get("rows") or [])
        out = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            nm = str(r.get("n") or r.get("name") or "")
            if q in "".join(nm.split()).lower():
                out.append(r)
        return out
