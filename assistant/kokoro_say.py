# Dubbi's voice: Kokoro (open-source, runs on this Mac, offline — nothing is sent anywhere).
# Started once by brain.js and kept running, so the voice is loaded only once.
# Reads one JSON request per line on stdin: {"text", "lang": "en"|"fr", "out": "/path.wav"}
# and answers one JSON line on stdout: {"ok": true, "ms": 850} or {"ok": false, "error": "..."}.
# Installed by install-voice.sh into assistant/voice/ (private Python 3.13, model files).
import json, os, sys, time, wave
import numpy as np
import onnxruntime
onnxruntime.set_default_logger_severity(3)   # errors only (the model prints harmless optimizer notes)
from kokoro_onnx import Kokoro

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, 'voice', 'models')
VOICES = {'en': ('af_heart', 'en-us'), 'fr': ('ff_siwis', 'fr-fr')}

kokoro = Kokoro(os.path.join(MODELS, 'kokoro-v1.0.fp16.onnx'), os.path.join(MODELS, 'voices-v1.0.bin'))
print(json.dumps({'ready': True}), flush=True)

for line in sys.stdin:
    try:
        req = json.loads(line)
        voice, lang = VOICES.get(req.get('lang'), VOICES['en'])
        t = time.time()
        samples, rate = kokoro.create(str(req['text'])[:1500], voice=req.get('voice') or voice, speed=float(req.get('speed', 1.0)), lang=lang)
        pcm = (np.clip(samples, -1, 1) * 32767).astype('<i2')
        with wave.open(req['out'], 'wb') as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(pcm.tobytes())
        print(json.dumps({'ok': True, 'ms': int((time.time() - t) * 1000)}), flush=True)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)[:200]}), flush=True)
