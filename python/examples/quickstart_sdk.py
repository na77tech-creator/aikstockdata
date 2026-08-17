# -*- coding: utf-8 -*-
"""30초 예제 — SDK 판.

★예제가 두 개인 이유: 이것은 `pip install aikstockdata` 를 한 사람용이고,
  `../../examples/quickstart.py` 는 **아무것도 설치하지 않고** 표준 라이브러리만으로
  같은 일을 하는 판입니다. 사내망·에어갭·CI 처럼 설치가 곤란한 곳이 있어서
  그 경로를 지웁니다 않고 남겨 둡니다. 둘은 같은 데이터를 봅니다.

    pip install aikstockdata
    python examples/quickstart_sdk.py
"""
import aikstockdata as a


def main():
    c = a.Client()

    # ① 언제 것인지 먼저 본다. 이 데이터는 실시간이 아니다 —
    #    매 거래일 18:10 KST 발행, 시세는 T+1 확정 종가.
    today = c.get_today()
    info = today.as_of_info
    print(f"기준일 {info['as_of_iso']} · 발행 {info['generated_kst']} "
          f"· 스냅샷 {info['snapshot_id']}")
    print("  (인용할 때는 snapshot_id 를 함께 적으세요 — latest 는 매 거래일 덮어쓰입니다)")

    # ② 종목 하나. 코드는 **문자열**이다(앞자리 0 이 살아 있어야 한다).
    #    ★필드 이름을 외우지 마세요 — 이 파일은 field_definitions 를 함께 싣습니다.
    #     (이 예제도 처음엔 s["close"] 로 썼다가 틀렸습니다. 종가는 quote 안에 있습니다.)
    s = c.get_snapshot("005930")
    q = s.get("quote") or {}
    print(f"\n{s.get('name_ko')} ({s.get('code')}) {s.get('market')} "
          f"종가 {q.get('close'):,}원  기준 {s.get('as_of')}")
    print(f"  필드 뜻은 이 파일 안에 있습니다 — field_definitions "
          f"{len(s.get('field_definitions') or {})}개")

    # ③ 이름으로 찾기 — 인덱스를 한 번 받아 로컬에서 거른다.
    for row in c.search("하이닉스")[:3]:
        print(f"  검색: {row.get('n')} {row.get('c')} {row.get('m')}")

    # ④ 무엇이 더 있는지는 **카탈로그가 말한다.** 여기에 목록을 적어 두면 낡는다.
    cat = c.get_catalog()
    eps = cat.get("endpoints") or []
    print(f"\n공개 데이터셋 {len(eps)}종 — 전체 목록은 get_catalog() 가 알려 줍니다")
    for e in eps[:5]:
        if isinstance(e, dict):
            print(f"  · {str(e.get('name'))[:56]}")

    # ⑤ 한계는 파일이 스스로 말한다(P6-9 이후 발행분).
    lim = today.get("limitations")
    if lim:
        print("\n이 데이터로 할 수 없는 것:")
        for x in lim:
            print(f"  · {x}")

    print("\n정보 제공이며 투자 자문이 아닙니다.")


if __name__ == "__main__":
    main()
