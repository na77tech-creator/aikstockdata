# 변경 이력

날짜는 KST 입니다. 아직 PyPI 에 올리지 않았습니다 — 업로드는 발주자 몫입니다.

## 0.1.0 (미배포)

첫 판. 이 데이터를 쓰려면 소비자가 URL 을 조립하고, UA 헤더를 붙이고, 어느 파일이
잘림 안전한지 판단해야 했습니다. 그 지식을 예제 하나에 담아 뒀었는데 예제는
복사되는 순간부터 낡습니다. 패키지로 만들면 지식이 한 곳에 삽니다.

- `Client` — `get_catalog` · `get_today` · `get_snapshot` · `get_history` ·
  `get_rankings` · `get_disclosures` · `get_intraday_disclosures` ·
  `get_earnings_calendar` · `list_stocks` · `search`
- **의존성 0.** `urllib.request` + `json` 만 씁니다. `pandas` 는 extras 이고,
  없으면 `.to_frame()` 이 설치 방법을 알려 줍니다.
- **User-Agent 를 항상 붙입니다.** 표준 `urllib` 기본 UA 는 CDN 봇 필터에 403 을
  받습니다. 우리가 아는 사실이므로 기본값이 돼야 합니다 — 검사가 라이브로 확인합니다.
- **`as_of` 를 감추지 않습니다.** 모든 응답에 `as_of` · `as_of_iso` · `snapshot_id` ·
  `generated_kst` 를 그대로 싣고, `as_of_info` 는 **없는 키를 지우지 않고 `None` 으로
  남깁니다**(‘필드가 없는 파일’과 ‘값이 안 실린 파일’은 다른 사건입니다).
- `Response` 는 `dict` 를 그대로 상속합니다. 우리가 이름 붙이지 않은 필드도 보입니다.
- 종목코드에 정수가 오면 6자리로 채우되 **stderr 에 경고**합니다 — 조용히 고치면
  소비자가 자기 버그를 모릅니다(`5930` 은 이미 앞자리 0 을 잃은 뒤일 수 있습니다).
- 같은 프로세스 안 같은 URL 은 메모리 캐시. 파일 캐시는 만들지 않습니다
  (디스크 정책은 소비자마다 다릅니다). 요청 사이 최소 간격을 둡니다 —
  이 데이터는 거래일마다 한 번 바뀝니다.

검사

- `tests/test_client.py` — 21건. UA·as_of·캐시·정수 코드·pandas 안내,
  그리고 **UA 없이 실제 요청을 보내 403 을 확인**하는 회귀.
- `tests/test_catalog_sync.py` — 라이브 카탈로그와 SDK 경로 대조.
  SDK 가 가리키는데 카탈로그에 없으면 **실패**(소비자를 404 로 보냄),
  카탈로그에 있는데 SDK 가 안 감쌌으면 **경고**(미설명이지 오류가 아님).
- `tests/test_packaging.py` — 의존성 0 · README 에 하드코딩 숫자 없음 ·
  배포 워크플로가 수동 트리거뿐.
