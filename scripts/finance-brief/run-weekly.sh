#!/usr/bin/env bash
# 매주 첫 개장일 아침 브리핑. launchd가 월~금 08:00 호출, 내부에서 자체 게이트(공휴일 순연).
# 게이트 통과 시: 파이프라인(U1-U3) → write-brief(U4) → finance 봇 HTTP 트리거 → 주간 마커 갱신.
set -uo pipefail
cd "$(dirname "$0")"
REPO="$(cd ../.. && pwd)"
# launchd(비대화형)엔 fnm/node가 PATH에 없다 → 로그인 셸처럼 주입(node·tsx용).
# 여기서 export한 PATH는 자식 run-pipeline.sh에도 상속된다.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
command -v fnm >/dev/null && eval "$(fnm env)"
if [ -f "$REPO/.env" ]; then set -a; . "$REPO/.env"; set +a; fi
MARKER="$REPO/data/finance-brief/.last-week"

# 공휴일/주간 게이트: 실행이면 stdout에 주차, exit 0.
if ! WEEK="$(node --import tsx should-run-weekly.mjs)"; then
  echo "[run-weekly] 게이트 스킵"
  exit 0
fi

echo "[run-weekly] 파이프라인 + 브리핑 렌더 (week $WEEK)"
bash run-pipeline.sh
node --import tsx write-brief.mjs

# finance 봇을 로컬 트리거 서버로 깨운다(POST /trigger/finance). 브리지가 떠 있어야 함.
# BUTLER_HTTP_PORT/BUTLER_TRIGGER_TOKEN은 위 .env source로 로드됨(server.ts와 동일).
PORT="${BUTLER_HTTP_PORT:-8787}"
for b in finance; do
  echo "[run-weekly] trigger $b"
  curl -fsS -m 20 -X POST -H "X-Butler-Token: ${BUTLER_TRIGGER_TOKEN:-}" \
    "http://127.0.0.1:${PORT}/trigger/${b}" >/dev/null \
    || echo "[run-weekly] WARN: trigger $b 실패(브리지 다운/토큰 누락?)"
done

# 성공 시에만 주간 마커 갱신(같은 주 다음 개장일 중복 실행 방지).
printf '%s' "$WEEK" > "$MARKER"
echo "[run-weekly] 완료 (마커 $WEEK)"
