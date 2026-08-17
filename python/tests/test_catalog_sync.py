# -*- coding: utf-8 -*-
"""test_catalog_sync.py — SDK 가 아는 파일과 라이브 카탈로그를 대조한다.

★왜 (P6-7). SDK 메서드는 정의상 **손목록**이다. 이 프로젝트는 같은 병을 이미 두 번
  앓았다: `index.json` 의 endpoints 가 실물 28파일 중 6개를 빠뜨렸고(그중 하나는
  MCP 응답이 스스로 출처로 인용하던 소형본이다), `openapi.json` 은 아직 손목록이라
  실제 소비되는 4개가 빠져 있다. SDK 를 손목록으로 내면 **세 번째**가 된다.

  그래서 목록을 손으로 지키는 대신, 어긋남을 기계가 말하게 한다.

판정 기준 (틀린 값만 실패 — 미설명은 경고)
  · **실패**: SDK 가 참조하는데 카탈로그에 없는 경로. 소비자를 404 로 보내는 틀린 값이다.
  · **경고**: 카탈로그에 있는데 SDK 가 아직 안 감싼 파일. 미설명이지 오류가 아니다.
    다만 **이름을 전부 출력**한다 — 침묵하면 '없는 것'으로 읽힌다.
  · **실패**: 양쪽 중 하나라도 0. 0↔0 통과는 대조가 안 이뤄진 것이다.
  · 네트워크 불가: **크게 출력하고 exit 0.** 조용한 skip 금지.

실행:
    python tests/test_catalog_sync.py
    python tests/test_catalog_sync.py --sdk <다른 패키지 디렉터리>   # 결함 주입용(사본)
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

PKG_ROOT = Path(__file__).resolve().parent.parent
BASE = "https://aikstockdata.com"
CATALOG = f"{BASE}/data/public/index.json"
UA = {"User-Agent": "aikstockdata-catalog-sync/1.0 (+https://aikstockdata.com)"}

# SDK 소스에서 공개 경로를 뽑는다. fetch("/data/public/x.json") · f-string 조립 둘 다.
_PATH_RE = re.compile(r"""["'](/(?:data/public|)[\w./{}-]*\.(?:json|csv|txt|xml))["']""")
# 종목별 파일은 코드로 조립된다 — 이름이 종목마다 달라 카탈로그의 개별 항목과
# 1:1 로 맞출 수 없다. 카탈로그는 url_pattern 으로 낸다. 템플릿은 대조에서 뺀다.
_TEMPLATE_MARK = ("{", "}")


def fetch_catalog():
    """(파일이름 집합, 사유). 못 받으면 (None, 사유)."""
    try:
        req = urllib.request.Request(CATALOG, headers=UA)
        with urllib.request.urlopen(req, timeout=30) as r:
            doc = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return None, f"{type(e).__name__}: {str(e)[:70]}"
    names = set()
    for e in (doc.get("endpoints") or []):
        if not isinstance(e, dict):
            continue
        for key in ("url", "path", "url_pattern"):
            v = str(e.get(key) or "")
            if "/" in v and "." in v.rsplit("/", 1)[-1]:
                names.add(v.rsplit("/", 1)[-1])
    # file_bytes 는 디렉터리를 훑어 만든 것이라 endpoints 보다 정직하다 — 있으면 합친다.
    for k in (doc.get("file_bytes") or {}):
        names.add(str(k))
    return names, f"endpoints {len(doc.get('endpoints') or [])}개 · " \
                  f"file_bytes {len(doc.get('file_bytes') or {})}개"


def sdk_paths(pkg_dir: Path):
    """SDK 소스가 실제로 참조하는 공개 파일 이름 집합 + 템플릿(제외한 것)."""
    names, templates = set(), set()
    srcs = sorted(pkg_dir.glob("*.py"))
    for p in srcs:
        for m in _PATH_RE.findall(p.read_text(encoding="utf-8", errors="replace")):
            leaf = m.rsplit("/", 1)[-1]
            if any(c in leaf for c in _TEMPLATE_MARK):
                templates.add(leaf)
            else:
                names.add(leaf)
    return names, templates, len(srcs)


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    pkg = Path(argv[argv.index("--sdk") + 1]) if "--sdk" in argv \
        else PKG_ROOT / "aikstockdata"
    print(f"[sync] SDK 소스: {pkg}")

    sdk, templates, n_src = sdk_paths(pkg)
    print(f"[sync] SDK .py {n_src}개에서 경로 {len(sdk)}종 수집 "
          f"· 템플릿 {len(templates)}종 제외 {sorted(templates)}")
    if n_src == 0:
        print("[sync] ★SDK 소스를 하나도 못 읽었다 — 경로가 틀렸다")
        return 1

    cat, why = fetch_catalog()
    if cat is None:
        # 조용한 skip 금지. 크게 말하고 exit 0.
        print("=" * 66)
        print(f"[sync] ★★건너뜀 — 라이브 카탈로그를 못 받았다({why}).")
        print("[sync]    네트워크가 되는 곳에서 다시 돌려야 대조가 이뤄진다.")
        print("[sync]    이번 실행은 **아무것도 검증하지 않았다**(exit 0).")
        print("=" * 66)
        return 0
    print(f"[sync] 카탈로그: {why} → 파일 이름 {len(cat)}종")

    # ★템플릿은 **양쪽에서 같게** 뺀다. 처음엔 SDK 쪽만 뺐더니 카탈로그의
    #  `{code6}.json` 이 'SDK 미지원'으로 잡혀 거짓 경고가 났다 — SDK 는 그 경로를
    #  f-string 으로 조립하므로 이름이 리터럴로 남지 않는다. 비대칭이 원인이었다.
    cat_templates = {n for n in cat if any(c in n for c in _TEMPLATE_MARK)}
    if cat_templates:
        print(f"[sync] 카탈로그 템플릿 {len(cat_templates)}종 제외 {sorted(cat_templates)} "
              f"— 종목별 파일은 코드로 조립되어 1:1 대조가 성립하지 않는다")
    cat = cat - cat_templates

    missing_in_catalog = sorted(sdk - cat)      # SDK 가 가리키는데 카탈로그에 없다
    not_wrapped = sorted(cat - sdk)             # 카탈로그에 있는데 SDK 가 안 감쌌다

    print(f"[sync] 카탈로그 {len(cat)} · SDK {len(sdk)} · "
          f"SDK 미지원 {len(not_wrapped)} · 카탈로그에 없는 SDK 경로 "
          f"{len(missing_in_catalog)}")

    fails = []
    if not cat or not sdk:
        fails.append(f"한쪽이 0이다(카탈로그 {len(cat)} · SDK {len(sdk)}) — "
                     f"대조가 이뤄지지 않았다")
    if missing_in_catalog:
        fails.append("SDK 가 참조하는데 카탈로그에 없다: " + ", ".join(missing_in_catalog))

    # 경고는 이름을 전부 낸다 — 개수만 내면 무엇이 빠졌는지 알 수 없다.
    if not_wrapped:
        print(f"[sync] (경고) SDK 가 아직 안 감싼 카탈로그 파일 {len(not_wrapped)}종 "
              f"— 오류가 아니라 미설명이다:")
        for n in not_wrapped:
            print(f"[sync]        {n}")

    print("-" * 66)
    if fails:
        print(f"[sync] ★실패 {len(fails)}건")
        for f in fails:
            print("  -", f)
        return 1
    print("[sync] 통과 — SDK 가 가리키는 경로가 전부 카탈로그에 있다")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
