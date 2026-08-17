# -*- coding: utf-8 -*-
"""aikstockdata — 한국주식데이터(aikstockdata.com) 공개 데이터 클라이언트.

    pip install aikstockdata
    python -c "import aikstockdata as a; print(a.Client().get_today()['as_of'])"

가입도 API 키도 없다. 100% 공개·공공 데이터(금융위 T+1 확정 종가, DART 공시)이고
자유롭게 재배포할 수 있다. 매 거래일 18:10 KST 에 갱신된다 — **실시간이 아니다.**
모든 응답의 `as_of_info` 를 읽어 언제 것인지 먼저 확인하라.

정보 제공이며 투자 자문이 아니다.
"""
from .client import BASE, ApiError, Client, Response

# ★버전은 여기 한 곳에만 둔다. pyproject.toml 이 이 값을 읽어 가므로(dynamic)
#  두 벌이 되지 않는다 — 두 곳에 적으면 언젠가 갈라지고, 갈라진 쪽이 배포된다.
__version__ = "0.1.0"

__all__ = ["Client", "Response", "ApiError", "BASE", "__version__"]
