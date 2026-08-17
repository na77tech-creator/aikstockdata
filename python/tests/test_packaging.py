# -*- coding: utf-8 -*-
"""test_packaging.py — 패키지가 설치 가능하고, 문서가 낡지 않고, 배포가 실수로 안 나가는가.

★왜 이 셋인가 (P6-8)
  ① **의존성 0 이 설계다.** urllib + json 만 쓴다 — 설치 장벽이 곧 사용 장벽이다.
     한 번 dependencies 에 뭔가 들어가면 되돌리기 어렵다.
  ② **README 에 숫자를 적으면 그 순간부터 낡는다.** 루트 README 가 이미 그 병을
     앓고 있다(2026-08-17 실측: '500종목'·'855종목'·'518종목' 3건 하드코딩).
     P2 가 전 상장(~2,800)으로 확대하면 그 문장들이 거짓이 된다. 새 README 에서
     같은 실수를 반복하지 않는다 — 수록 범위는 get_catalog() 가 말한다.
  ③ **배포는 사람이 결정한다.** 태그 푸시·릴리스 트리거가 있으면 누군가 태그를
     다는 순간 세상에 나간다. 수동 트리거 하나만 남긴다.

검사
  [1] pyproject 의 dependencies 가 빈 리스트다
  [2] 버전이 한 곳에만 있다(pyproject 는 dynamic 으로 읽어 간다)
  [3] python/README.md 에 하드코딩된 종목 수가 0건 · 카탈로그가 말한다고 적혀 있다
  [4] publish.yml 트리거가 workflow_dispatch 뿐이다(push·release 0건)
  [5] 배포 전 검사 셋이 워크플로에 들어 있다
  [6] 예제가 둘이고, 각자 왜 둘인지 머리에 적었다
  [7] 패키지 파일이 실제로 다 있다(census — 0개면 대조가 안 된 것)

실행: python tests/test_packaging.py
"""
from __future__ import annotations

import io
import re
import sys
from pathlib import Path

if getattr(sys.stdout, "encoding", "").lower() not in ("utf-8", "utf8"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

PKG_ROOT = Path(__file__).resolve().parent.parent          # .../python
REPO = PKG_ROOT.parent

FAILS: list[str] = []
SEEN = 0


def chk(label, cond, detail=""):
    global SEEN
    SEEN += 1
    print(("  OK   " if cond else "  FAIL ") + label + ("" if cond else f"  {detail}"))
    if not cond:
        FAILS.append(label)


def main():
    print("[7] 패키지 파일 census")
    want = {
        "pyproject.toml": PKG_ROOT / "pyproject.toml",
        "README.md": PKG_ROOT / "README.md",
        "CHANGELOG.md": PKG_ROOT / "CHANGELOG.md",
        "aikstockdata/__init__.py": PKG_ROOT / "aikstockdata" / "__init__.py",
        "aikstockdata/client.py": PKG_ROOT / "aikstockdata" / "client.py",
        "examples/quickstart_sdk.py": PKG_ROOT / "examples" / "quickstart_sdk.py",
        "publish.yml": REPO / ".github" / "workflows" / "publish.yml",
    }
    have = {k: p for k, p in want.items() if p.is_file()}
    print(f"      {len(have)}/{len(want)}개 존재 · 없는 것: "
          f"{sorted(set(want) - set(have)) or '없음'}")
    chk("[7] 필요한 파일이 전부 있다", len(have) == len(want),
        str(sorted(set(want) - set(have))))
    if "pyproject.toml" not in have:
        print("\n(중단) pyproject.toml 이 없어 나머지를 대조할 수 없다")
        return 1

    pyp = want["pyproject.toml"].read_text(encoding="utf-8")
    print("[1] 의존성 0")
    m = re.search(r"^dependencies\s*=\s*\[(.*?)\]", pyp, re.M | re.S)
    inner = (m.group(1).strip() if m else "★선언 없음")
    print(f"      dependencies = [{inner}]")
    chk("[1] dependencies 선언이 있다", m is not None)
    chk("[1] ★비어 있다(설치 장벽 = 사용 장벽)", bool(m) and not inner)
    om = re.search(r"\[project\.optional-dependencies\](.*?)(\n\[|\Z)", pyp, re.S)
    chk("[1] pandas 는 extras 로만 있다",
        bool(om) and "pandas" in om.group(1), (om.group(1)[:60] if om else "없음"))

    print("[2] 버전이 한 곳에만 있다")
    lit = re.search(r'^\s*version\s*=\s*"[\d.]+"', pyp, re.M)
    chk("[2] ★pyproject 가 버전을 베끼지 않는다", lit is None,
        lit.group(0) if lit else "")
    chk("[2] dynamic 으로 __init__.py 에서 읽어 간다",
        "dynamic" in pyp and 'path = "aikstockdata/__init__.py"' in pyp)

    print("[3] README 가 낡지 않게 쓰여 있는가")
    rd = want["README.md"].read_text(encoding="utf-8")
    hard = re.findall(r"\d{3,4}\s*종목", rd)
    # 대조군 — 루트 README 는 실제로 그 병을 앓고 있다. 검사가 도는지 그것으로 확인한다.
    root_rd = (REPO / "README.md")
    root_hard = re.findall(r"\d{3,4}\s*종목",
                           root_rd.read_text(encoding="utf-8")) if root_rd.is_file() else []
    print(f"      python/README.md 하드코딩 {len(hard)}건 {hard} · "
          f"(대조군) 루트 README {len(root_hard)}건 {root_hard}")
    chk("[3] ★python/README.md 에 하드코딩된 종목 수가 없다", not hard, str(hard))
    chk("[3] 이 정규식이 실제로 잡는다(대조군이 0이면 검사가 무동작)",
        len(root_hard) >= 1, "루트 README 에서도 0건 — 패턴을 의심하라")
    chk("[3] 수록 범위는 카탈로그가 말한다고 적혀 있다",
        "get_catalog()" in rd)
    chk("[3] 실시간이 아님을 먼저 말한다", "실시간이 아닙니다" in rd)
    chk("[3] 릴리스 절차에 카탈로그 대조가 들어 있다",
        "test_catalog_sync" in rd and "릴리스 절차" in rd)

    print("[4][5] 배포 워크플로 — 실수로 나가지 않는가")
    wf = want["publish.yml"].read_text(encoding="utf-8") if "publish.yml" in have else ""
    on_blk = re.search(r"^on:\s*\n((?:\s+.*\n)+)", wf, re.M)
    on_txt = on_blk.group(1) if on_blk else ""
    trig = re.findall(r"^\s{2}(\w+):", on_txt, re.M)
    print(f"      트리거 {trig}")
    chk("[4] on: 블록을 찾았다", bool(on_blk))
    chk("[4] ★수동 트리거뿐이다(태그 푸시·릴리스로 자동 배포되지 않는다)",
        trig == ["workflow_dispatch"], str(trig))
    chk("[4] 시크릿이 없으면 실패가 정상임을 파일이 밝힌다",
        "PYPI_API_TOKEN" in wf and "정상" in wf)
    for t in ("test_client.py", "test_catalog_sync.py", "test_packaging.py"):
        chk(f"[5] 배포 전에 {t} 를 돌린다", t in wf)

    print("[6] 예제가 둘인 이유가 양쪽에 적혀 있다")
    sdk_ex = want["examples/quickstart_sdk.py"].read_text(encoding="utf-8")
    std_ex_p = REPO / "examples" / "quickstart.py"
    std_ex = std_ex_p.read_text(encoding="utf-8") if std_ex_p.is_file() else ""
    chk("[6] SDK 판이 표준 라이브러리 판을 가리킨다", "quickstart.py" in sdk_ex)
    chk("[6] 표준 라이브러리 판이 SDK 판을 가리킨다", "quickstart_sdk.py" in std_ex)
    chk("[6] ★기존 예제를 지우지 않았다(설치 못 하는 환경이 있다)", std_ex_p.is_file())

    print("-" * 62)
    print(f"검사 {SEEN}건 · 실패 {len(FAILS)}건")
    for f in FAILS:
        print("  -", f)
    return 1 if FAILS else 0


if __name__ == "__main__":
    raise SystemExit(main())
