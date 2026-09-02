# 이 서버는 **원격 전용**입니다 — 직접 돌릴 것이 없습니다.
#
#   https://mcp.aikstockdata.com/mcp   (streamable-http · 인증 없음)
#
# 그런데 서버 디렉터리 몇 곳은 "컨테이너가 떠서 introspection 에 답하는가"로
# 품질을 잽니다. 원격 서버에는 그럴 이미지가 없어서, 우리는 그 점수가 계속
# `?`(미평가)로 남아 있었습니다 — 그 하나 때문에 awesome-mcp-servers 병합이
# 2026-08-03 부터 멈춰 있습니다.
#
# 그래서 **다리**를 하나 놓습니다. 이 이미지는 서버를 새로 구현하지 않습니다.
# 표준 stdio↔HTTP 다리(`mcp-remote`)를 띄워 위 주소로 그대로 넘깁니다.
# 데이터도, 도구 12개도, 갱신 시각(매 거래일 18:10 KST)도 전부 같은 한 곳에서 옵니다.
#
# 실측(2026-09-02): `npx mcp-remote@0.8.3 https://mcp.aikstockdata.com/mcp` 로
#   "Connected to remote server using StreamableHTTPClientTransport" ·
#   "Proxy established successfully" 를 확인했고 initialize·tools/list 가 넘어갔습니다.
#
# 쓰는 법 (원격 주소를 그냥 쓰는 편이 언제나 낫습니다 — 이건 컨테이너가 필요할 때만):
#   docker build -t aikstockdata .
#   docker run --rm -i aikstockdata
#
FROM node:22-alpine

# 판을 박아 둡니다. 다리의 동작이 조용히 바뀌면 그것이 우리 서버 탓으로 읽힙니다.
RUN npm install -g mcp-remote@0.8.3

# 주소는 하나뿐이고 바뀌지 않습니다. 그래도 인자로 덮어쓸 수 있게 CMD 에 둡니다.
ENTRYPOINT ["mcp-remote"]
CMD ["https://mcp.aikstockdata.com/mcp"]
