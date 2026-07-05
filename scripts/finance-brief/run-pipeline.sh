#!/usr/bin/env bash
# U1→U2→U3: Toss 백필 → qlib dump → 모델 → signals.json. 서버에서 실행.
# 사전: setup-venv.sh 1회 실행(.venv + dump_bin.py) · .env에 TOSSINVEST_CLIENT_ID/SECRET.
# 비대화형 SSH는 PATH 미주입 → 호출부에서 fnm 주입 필요(run-weekly.sh가 처리).
set -euo pipefail
cd "$(dirname "$0")"
REPO="$(cd ../.. && pwd)"
DATA="$REPO/data/finance-brief"
mkdir -p "$DATA/candles"

# .env 로드(Toss 크리덴셜) — 비대화형 실행은 앱과 달리 .env 자동 로드가 안 됨.
if [ -f "$REPO/.env" ]; then set -a; . "$REPO/.env"; set +a; fi

echo "[1/3] Toss 캔들 fetch (U1)"
node --import tsx fetch-candles.mjs

echo "[2/3] qlib dump (U2)"
.venv/bin/python to_qlib.py "$DATA/candles" "$DATA/qlib_bin"

echo "[3/3] 모델 → signals.json (U3)"
.venv/bin/python run_model.py "$DATA/qlib_bin" universe.kospi200.json "$DATA/signals.json" --top 5

echo "완료: $DATA/signals.json"
