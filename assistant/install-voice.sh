#!/bin/zsh
# Dubbi's natural voice (Kokoro): free, open-source, runs on this Mac, offline.
# Everything goes into assistant/voice/ — no admin password, nothing system-wide.
#   ./install-voice.sh           install (safe to re-run)
#   ./install-voice.sh remove    delete it all (Dubbi goes back to the iPhone's voice)
# Sources (pinned): uv 0.13.5 and kokoro-onnx 0.6.1 from PyPI; Python 3.13 via uv;
# the Kokoro-82M model (Apache-2.0) from the kokoro-onnx release, checked by SHA-256.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
V="$DIR/voice"
if [[ "$1" == "remove" ]]; then rm -rf "$V"; echo "Removed $V"; exit 0; fi

mkdir -p "$V/models"
[[ -x "$V/tools/bin/uv" ]] || { python3 -m venv "$V/tools" && "$V/tools/bin/pip" install -q --disable-pip-version-check uv==0.13.5; }
export UV_PYTHON_INSTALL_DIR="$V/python" UV_CACHE_DIR="$V/.uv-cache" UV_PYTHON_PREFERENCE=only-managed
"$V/tools/bin/uv" python install 3.13
[[ -x "$V/.venv/bin/python" ]] || "$V/tools/bin/uv" venv -q --python 3.13 "$V/.venv"
"$V/tools/bin/uv" pip install -q --python "$V/.venv/bin/python" kokoro-onnx==0.6.1
"$V/tools/bin/uv" cache clean -q 2>/dev/null || true

B=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1
cd "$V/models"
[[ -f kokoro-v1.0.fp16.onnx ]] || curl -sSfL -o kokoro-v1.0.fp16.onnx "$B/kokoro-v1.0.fp16.onnx"
[[ -f voices-v1.0.bin ]] || curl -sSfL -o voices-v1.0.bin "$B/voices-v1.0.bin"
shasum -a 256 -c - <<'SUMS'
f3a290d384fbb27966d462905c71a46cef9e5fd00516b40df32a0b4afe77ac96  kokoro-v1.0.fp16.onnx
bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d  voices-v1.0.bin
SUMS
launchctl kickstart -k "gui/$(id -u)/com.vapiq.brain" 2>/dev/null || true
echo "Dubbi's voice is installed ($(du -sh "$V" | cut -f1)). Dubbi's brain was restarted to use it."
