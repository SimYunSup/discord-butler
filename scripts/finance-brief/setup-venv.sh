#!/usr/bin/env bash
# discord-butler finance-brief Python 환경. 서버에서 1회 실행.
# 함정(PoC 실측): pyqlib은 py3.11(3.13 불가) · LightGBM은 libomp 필요 · dump_bin은
# pip wheel에 없어 vendored(dump_bin.py). qlib 실행 시 MLFLOW_ALLOW_FILE_STORE=true 필요
# (run_model.py가 내부에서 설정) · qlib.init(kernels=1) + 파일 실행(macOS spawn 회피).
# uv 필요(https://docs.astral.sh/uv/). uv 대신 python3.11 -m venv도 가능(그 경우 pip 사용).
set -euo pipefail
cd "$(dirname "$0")"

# libomp: LightGBM 런타임 의존. brew 권한 문제 대비 — 이미 있으면 건너뛰고, brew는 best-effort.
LIBOMP=""
for p in /opt/homebrew/opt/libomp/lib/libomp.dylib /usr/local/opt/libomp/lib/libomp.dylib; do
  [ -f "$p" ] && LIBOMP="$p" && break
done
if [ -z "$LIBOMP" ] && command -v brew >/dev/null; then
  brew install libomp 2>/dev/null || echo "[setup-venv] WARN: brew install libomp 실패(권한?) — libomp 수동 필요할 수 있음."
  [ -f /opt/homebrew/opt/libomp/lib/libomp.dylib ] && LIBOMP=/opt/homebrew/opt/libomp/lib/libomp.dylib
fi
[ -n "$LIBOMP" ] && echo "[setup-venv] libomp: $LIBOMP" || echo "[setup-venv] WARN: libomp 미발견 — LightGBM(U3) 실패 가능."

uv venv --python 3.11 .venv
VIRTUAL_ENV="$PWD/.venv" uv pip install -r requirements.txt
if [ ! -f dump_bin.py ]; then
  curl -fsSL https://raw.githubusercontent.com/microsoft/qlib/v0.9.7/scripts/dump_bin.py -o dump_bin.py
fi
# LightGBM 로드 확인(libomp 문제 조기 발견)
.venv/bin/python -c "import lightgbm; print('[setup-venv] lightgbm OK', lightgbm.__version__)" \
  || echo "[setup-venv] WARN: lightgbm import 실패 — libomp 경로 확인 필요."
echo "OK: .venv (py3.11) 준비 + dump_bin.py vendored."
