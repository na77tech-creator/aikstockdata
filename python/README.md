# aikstockdata — 파이썬 클라이언트

한국주식데이터(aikstockdata.com)의 공개 JSON 을 읽는 **의존성 0** 클라이언트입니다.
`urllib` + `json` 만 씁니다. 가입도 API 키도 없습니다.

```python
import aikstockdata as a

c = a.Client()
t = c.get_today()
print(t["as_of_iso"], t.as_of_info)          # ← 언제 것인지 먼저 본다
print(c.get_snapshot("005930")["name"])
print(c.search("삼성")[:3])
```

## 먼저 알아야 할 것

- **실시간이 아닙니다.** 매 거래일 18:10 KST 발행이고 시세는 T+1 확정 종가입니다.
  모든 응답의 `as_of_info` 에 `as_of` · `as_of_iso` · `snapshot_id` · `generated_kst` 가
  그대로 실려 있습니다. 인용할 때는 `snapshot_id` 를 함께 적으세요 — `latest` 는
  매 거래일 덮어쓰입니다.
- **종목코드는 문자열**입니다. `get_snapshot(5930)` 처럼 정수를 주면 6자리로 채워
  주지만 **stderr 에 경고를 찍습니다** — 앞자리 0 이 이미 사라진 뒤일 수 있어서입니다.
- **pandas 는 선택**입니다: `pip install aikstockdata[pandas]` 를 하면
  `.to_frame()` 을 쓸 수 있습니다. 없어도 응답은 그냥 `dict` 이라 그대로 다루면 됩니다.
- 정보 제공이며 투자 자문이 아닙니다. 랭킹은 공개 재무제표로부터의 기계적 계산이지
  종목 추천이 아닙니다.

## 검사

```
python tests/test_client.py          # 계약 — UA·as_of·캐시·정수 코드·pandas 안내
python tests/test_catalog_sync.py    # 라이브 카탈로그 ↔ SDK 경로 대조
```

`test_client.py` 는 **UA 없이 실제 요청을 보내 403 을 확인**합니다(이 패키지가
UA 를 기본값으로 넣는 이유). 네트워크가 없으면 그 항목을 건너뛰었다고 출력합니다.

## 릴리스 절차

버전을 올리기 **전에** 아래를 순서대로 통과시킵니다.

1. `python tests/test_client.py` → exit 0
2. **`python tests/test_catalog_sync.py` → exit 0** ← 이것 없이 버전을 올리지 마세요.
   SDK 가 가리키는 경로가 라이브 카탈로그에 없으면 실패합니다. 소비자를 404 로
   보내는 것은 틀린 값이라 릴리스를 막습니다.
   (카탈로그에 있는데 SDK 가 아직 안 감싼 파일은 **경고**입니다 — 오류가 아니라
   미설명이고, 그 목록이 다음에 무엇을 감쌀지 알려 줍니다.)
3. `__version__` 은 `aikstockdata/__init__.py` **한 곳**에만 있습니다.
   패키징 파일이 생기면 그 값을 읽어 가야 하고, 두 곳에 적으면 언젠가 갈라집니다
   (`test_client.py` [8] 이 그것을 강제합니다).

## 라이선스

MIT (코드). 데이터는 공공데이터 가공물이며 출처 표기 후 자유롭게 이용할 수 있습니다 —
자세한 조건은 사이트의 라이선스 안내를 따릅니다.
