"""Orbis voice: speech to text on this PC (Whisper small, OpenVINO GenAI). Nothing leaves the PC.

  serve   JSON lines on stdin/stdout:
          {"pcm": "<base64, 16 kHz mono 16-bit>", "prompt": true} -> {"text": "...", "lang": "en", "ms": 380}
          prompt: the person is talking to Orbis (push-to-talk, or right after "Orbis"), so the name is
          primed and comes out as "Orbis" rather than "Orbus". It is left out while only waiting for
          the name, where a primed model could hear "Orbis" in plain noise.
  setup   installs OpenVINO GenAI (matching the OpenVINO already here) and the model; STEP / ERROR lines

Runs on the CPU: about 0.4 s for a sentence, loads in a second, and the name priming works there.
"""
import base64
import json
import os
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, 'whisper', 'small')
CACHE = os.path.join(HERE, 'whisper', 'cache')
REPO = 'OpenVINO/whisper-small-int8-ov'
PROMPT = 'Orbis.'
IDLE_SECS = 15 * 60


def say(*a):
    print(*a, flush=True)


def setup():
    try:
        import openvino
        ver = openvino.__version__.split('-')[0]
        say('STEP 5 Installing speech recognition')
        r = subprocess.run([sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check', '-q', f'openvino-genai=={ver}.*'],
                           capture_output=True, text=True, creationflags=0x08000000)
        if r.returncode:
            say('ERROR could not install OpenVINO GenAI: ' + (r.stderr.strip().splitlines() or ['pip failed'])[-1])
            return 1
        say('STEP 35 Downloading the speech model (about 250 MB, once)')
        from huggingface_hub import snapshot_download
        snapshot_download(REPO, local_dir=MODEL)
        say('STEP 90 Checking it works')
        import numpy as np
        import openvino_genai as og
        og.WhisperPipeline(MODEL, 'CPU', CACHE_DIR=CACHE).generate(np.zeros(16000, np.float32).tolist())
        say('STEP 100 Ready')
        return 0
    except Exception as e:  # noqa: BLE001 - the message goes to the settings panel
        say('ERROR ' + str(e).splitlines()[0][:300])
        return 1


def latin_or_arabic(t):
    letters = [c for c in t if c.isalpha()]
    return all(c.isascii() or '؀' <= c <= 'ۿ' for c in letters)


def serve():
    import numpy as np
    import openvino_genai as og
    pipe = og.WhisperPipeline(MODEL, 'CPU', CACHE_DIR=CACHE)
    say(json.dumps({'ready': True}))
    last = [time.time()]

    def watchdog():
        while True:
            time.sleep(30)
            if time.time() - last[0] > IDLE_SECS:
                os._exit(0)
    threading.Thread(target=watchdog, daemon=True).start()

    def run(a, prompt, lang=None):
        kw = {'task': 'transcribe'}
        if prompt:
            kw['initial_prompt'] = PROMPT
        if lang:
            kw['language'] = lang
        return pipe.generate(a.tolist(), **kw).texts[0].strip()

    for line in sys.stdin:
        last[0] = time.time()
        try:
            req = json.loads(line)
            a = np.frombuffer(base64.b64decode(req['pcm']), np.int16).astype(np.float32) / 32768
            t0 = time.time()
            text = run(a, req.get('prompt', True))
            if not latin_or_arabic(text):      # English or Arabic only: anything else was a misread accent
                text = run(a, req.get('prompt', True), '<|en|>')
            lang = 'ar' if any('؀' <= c <= 'ۿ' for c in text) else 'en'
            out = {'text': text, 'lang': lang, 'ms': round((time.time() - t0) * 1000)}
        except Exception as e:  # noqa: BLE001
            out = {'error': str(e).splitlines()[0][:300]}
        say(json.dumps(out, ensure_ascii=False))
        last[0] = time.time()


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stdin.reconfigure(encoding='utf-8')
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'serve'
    sys.exit(setup() if cmd == 'setup' else serve() or 0)
