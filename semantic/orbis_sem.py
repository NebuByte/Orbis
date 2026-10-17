"""Orbis descriptive search: multilingual-e5-small on the Intel NPU (OpenVINO).

  orbis_sem.py devices          the AI devices OpenVINO can use here (JSON)
  orbis_sem.py bench            time the NPU against the CPU
  orbis_sem.py index [root...]  extract text, embed new/changed files (idle priority, incremental)
  orbis_sem.py serve            JSON lines on stdin/stdout: {"q": "...", "k": 30} -> {"hits": [...]}
                               exits by itself after IDLE_EXIT seconds without a query
"""
import ctypes, json, os, re, sys, threading, time, zipfile

# numpy's BLAS reserves buffers for every CPU thread (~750 MB of commit on 24 threads) - this program
# never uses BLAS, so one thread is plenty. Must be set before numpy is imported.
for _v in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ.setdefault(_v, '1')
from pathlib import Path

import numpy as np
import openvino as ov
from tokenizers import Tokenizer

HERE = Path(__file__).resolve().parent
MODEL = HERE / 'model'
DATA = Path(os.environ['LOCALAPPDATA']) / 'Orbis' / 'semantic'
SEQ, BATCH, DIM = 256, 1, 384   # batch 1: batched static shapes on the NPU gave wrong vectors (checked against CPU)
IDLE_EXIT = 120
# with no folders given: the user's Desktop, Documents and Downloads
ROOTS = [str(Path.home() / d) for d in ('Desktop', 'Documents', 'Downloads')]
# where it runs: ORBIS_DEVICE = auto | NPU | GPU | CPU (auto: NPU, else the Intel GPU, else CPU)
DEVICE = os.environ.get('ORBIS_DEVICE', 'auto').upper()
EXT = {'.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.txt', '.md', '.csv', '.rtf'}
SKIP = {'node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', 'dist', 'build', 'target', 'bin', 'obj',
        'vendor', '.gradle', '.idea', 'site-packages', 'appdata', '$recycle.bin', 'system volume information'}
MAX_BYTES = 200 * 1024 * 1024   # skip giant files
CHUNK = 900                     # characters of body text per vector


# ---------------------------------------------------------------- model
def ir_model(core, batch, seq):
    """The model with a fixed input shape, saved once as FP16 OpenVINO IR (half the size of the ONNX).
    Compiling from this file lets OpenVINO load its cached NPU blob without reading the model at all."""
    ir = MODEL / 'ir' / f'e5_b{batch}_s{seq}.xml'
    if not ir.exists():
        m = core.read_model(str(MODEL / 'onnx' / 'model.onnx'))
        m.reshape({i.get_any_name(): [batch, seq] for i in m.inputs})
        ir.parent.mkdir(exist_ok=True)
        ov.save_model(m, str(ir), compress_to_fp16=True)
        del m
    return str(ir)


def pick_device(core, want='AUTO'):
    """The device to run on: the one asked for if present, else NPU, then an Intel GPU (never a
    gaming card - it would wake up a power-hungry dGPU for a tiny model), then the CPU."""
    avail = core.available_devices
    gpus = [d for d in avail if d.startswith('GPU')]
    intel_gpu = next((d for d in gpus if 'intel' in core.get_property(d, 'FULL_DEVICE_NAME').lower()), None)
    for d in ([want] if want in ('NPU', 'GPU', 'CPU') else []) + ['NPU', 'GPU', 'CPU']:
        if d == 'GPU' and intel_gpu:
            return intel_gpu
        if d != 'GPU' and d in avail:
            return d
    return 'CPU'


def devices():
    core = ov.Core()
    names = {d: core.get_property(d, 'FULL_DEVICE_NAME') for d in core.available_devices}
    print(json.dumps({'devices': names, 'best': pick_device(core, DEVICE)}), flush=True)


class Encoder:
    def __init__(self, device=None, batch=BATCH, seq=SEQ):
        DATA.mkdir(parents=True, exist_ok=True)
        core = ov.Core()
        core.set_property({'CACHE_DIR': str(DATA / 'ovcache')})
        ir = ir_model(core, batch, seq)
        self.batch = batch
        device = pick_device(core, (device or DEVICE).upper())
        try:
            self.cm = core.compile_model(ir, device)
            self.device = device
        except Exception:
            self.cm = core.compile_model(ir, 'CPU', {'INFERENCE_NUM_THREADS': 2})
            self.device = 'CPU'
        self.names = [i.get_any_name() for i in self.cm.inputs]
        self.req = self.cm.create_infer_request()
        self.tok = Tokenizer.from_file(str(MODEL / 'tokenizer.json'))
        self.tok.enable_truncation(seq)
        self.tok.enable_padding(length=seq)

    def encode(self, texts):
        out = []
        for i in range(0, len(texts), self.batch):
            part = texts[i:i + self.batch]
            enc = self.tok.encode_batch(part + [''] * (self.batch - len(part)))
            ids = np.array([e.ids for e in enc], dtype=np.int64)
            mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
            feed = {'input_ids': ids, 'attention_mask': mask}
            if 'token_type_ids' in self.names:
                feed['token_type_ids'] = np.zeros_like(ids)
            h = self.req.infer(feed)[0]                       # [B, seq, DIM]
            mk = mask[..., None].astype(np.float32)
            v = (h * mk).sum(1) / np.maximum(mk.sum(1), 1)    # mean pooling
            v /= np.linalg.norm(v, axis=1, keepdims=True) + 1e-9
            out.append(v[:len(part)])
        return np.vstack(out) if out else np.zeros((0, DIM), np.float32)


# ---------------------------------------------------------------- text extraction
TAG = re.compile(r'<[^>]+>')
WS = re.compile(r'\s+')


def _xml_text(z, names):
    parts = []
    for n in names:
        try:
            parts.append(TAG.sub(' ', z.read(n).decode('utf-8', 'ignore')))
        except KeyError:
            pass
        if sum(map(len, parts)) > CHUNK * 3:
            break
    return ' '.join(parts)


def _decode(b):
    if b[:2] in (b'\xff\xfe', b'\xfe\xff'):
        return b.decode('utf-16', 'ignore')
    try:
        return b.decode('utf-8')
    except UnicodeDecodeError:
        return b.decode('cp1256', 'ignore')       # Arabic Windows code page


def extract(p: Path):
    ext = p.suffix.lower()
    try:
        if ext == '.pdf':
            from pypdf import PdfReader
            r = PdfReader(str(p))
            return ' '.join((pg.extract_text() or '') for pg in r.pages[:3])
        if ext in ('.docx', '.pptx', '.xlsx'):
            with zipfile.ZipFile(p) as z:
                if ext == '.docx':
                    return _xml_text(z, ['word/document.xml'])
                if ext == '.pptx':
                    slides = sorted((n for n in z.namelist() if re.match(r'ppt/slides/slide\d+\.xml$', n)),
                                    key=lambda n: int(re.findall(r'\d+', n)[-1]))
                    return _xml_text(z, slides)
                return _xml_text(z, ['xl/workbook.xml', 'xl/sharedStrings.xml'])
        if ext in ('.txt', '.md', '.csv', '.rtf'):
            with open(p, 'rb') as f:
                t = _decode(f.read(8192))
            if ext == '.rtf':
                t = re.sub(r'\\[a-z]+-?\d* ?|[{}]', ' ', t)
            return t
    except Exception:
        pass
    return ''                                   # .doc/.xls and unreadable files: name and folder only


def passages(p: Path, text: str):
    title = re.sub(r'[_\-.]+', ' ', p.stem)
    where = ' / '.join(p.parent.parts[-2:])
    body = WS.sub(' ', text).strip()
    head = f'passage: {title}. {where}. '
    chunks = [head + body[:CHUNK]]
    if len(body) > CHUNK * 1.3:
        chunks.append(head + body[CHUNK:CHUNK * 2])
    return chunks, body[:220]


def walk(roots):
    for root in roots:
        for d, dirs, files in os.walk(root):
            dirs[:] = [x for x in dirs if x.lower() not in SKIP and not x.startswith('.')]
            for f in files:
                if os.path.splitext(f)[1].lower() in EXT:
                    fp = os.path.join(d, f)
                    try:
                        st = os.stat(fp)
                    except OSError:
                        continue
                    if st.st_size <= MAX_BYTES:
                        yield fp, int(st.st_mtime), st.st_size


# ---------------------------------------------------------------- store
def load_store():
    try:
        meta = json.loads((DATA / 'meta.json').read_text('utf-8'))
        vec = np.load(DATA / 'vectors.npy')
        if len(vec) == sum(len(m['rows']) for m in meta['files']):
            return meta, vec
    except Exception:
        pass
    return {'files': []}, np.zeros((0, DIM), np.float16)


def write_status(**kw):
    kw['ts'] = int(time.time())
    (DATA / 'status.tmp.json').write_text(json.dumps(kw), 'utf-8')
    os.replace(DATA / 'status.tmp.json', DATA / 'status.json')


def save_store(files, vec):
    DATA.mkdir(parents=True, exist_ok=True)
    np.save(DATA / 'vectors.tmp.npy', vec.astype(np.float16))
    (DATA / 'meta.tmp.json').write_text(json.dumps({'files': files, 'built': int(time.time())}, ensure_ascii=False), 'utf-8')
    os.replace(DATA / 'vectors.tmp.npy', DATA / 'vectors.npy')
    os.replace(DATA / 'meta.tmp.json', DATA / 'meta.json')


def index(roots):
    import msvcrt
    ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x40)   # IDLE_PRIORITY_CLASS
    DATA.mkdir(parents=True, exist_ok=True)
    lock = open(DATA / 'index.lock', 'a+')
    try:
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)      # released when this process ends
    except OSError:
        print(json.dumps({'busy': 'another index run is active'}), flush=True)
        return
    meta, vec = load_store()
    prev_built = meta.get('built', 0)
    old = {}
    for m in meta['files']:
        old[m['path']] = m
    keep_files, keep_rows, todo = [], [], []
    for path, mtime, size in walk(roots):
        m = old.get(path)
        if m and m['mtime'] == mtime and m['size'] == size:
            keep_files.append(m)
            keep_rows.extend(m['rows'])
        else:
            todo.append((path, mtime, size))
    print(json.dumps({'kept': len(keep_files), 'todo': len(todo)}), flush=True)
    base = vec[keep_rows] if keep_rows else np.zeros((0, DIM), np.float16)
    files, r = [], 0
    for m in keep_files:                        # kept rows are now 0..len(base) in order
        n = len(m['rows'])
        m['rows'] = list(range(r, r + n))
        r += n
        files.append(m)
    enc = Encoder(DEVICE, BATCH, SEQ)
    new_vecs, t0, step = [], time.time(), 0
    pending_text, pending_meta = [], []

    def flush():
        nonlocal base, new_vecs
        if pending_text:
            v = enc.encode(pending_text).astype(np.float16)
            start = len(base) + sum(len(x) for x in new_vecs)
            new_vecs.append(v)
            i = 0
            for fm, n in pending_meta:
                fm['rows'] = list(range(start + i, start + i + n))
                files.append(fm)
                i += n
            pending_text.clear()
            pending_meta.clear()

    for path, mtime, size in todo:
        p = Path(path)
        chunks, snip = passages(p, extract(p))
        pending_text.extend(chunks)
        pending_meta.append(({'path': path, 'mtime': mtime, 'size': size, 'snip': snip}, len(chunks)))
        if len(pending_text) >= 64:
            flush()
        step += 1
        if step % 500 == 0:
            print(json.dumps({'done': step, 'of': len(todo), 'sec': round(time.time() - t0)}), flush=True)
            save_store(files, np.vstack([base] + new_vecs))
            write_status(running=True, done=step, of=len(todo), files=len(files), built=prev_built)
    flush()
    allv = np.vstack([base] + new_vecs) if new_vecs else base
    save_store(files, allv)
    write_status(running=False, done=len(todo), of=len(todo), files=len(files), built=int(time.time()), device=enc.device)
    print(json.dumps({'files': len(files), 'vectors': len(allv), 'device': enc.device, 'sec': round(time.time() - t0)}), flush=True)


# ---------------------------------------------------------------- serve
QSEQ = 64   # queries are short: a small static shape keeps each one to a few ms on the NPU


def serve():
    st = {}

    def reload():
        try:
            mt = (DATA / 'meta.json').stat().st_mtime
        except OSError:
            mt = 0
        if st.get('mt') == mt:
            return
        meta, vec = load_store()
        owner = np.zeros(len(vec), np.int32)
        for i, m in enumerate(meta['files']):
            owner[m['rows']] = i
        st.update(mt=mt, files=meta['files'], owner=owner, mat=vec.astype(np.float32))

    reload()
    enc = Encoder(DEVICE, 1, QSEQ)
    last = [time.time()]

    def watchdog():
        while time.time() - last[0] < IDLE_EXIT:
            time.sleep(10)
        os._exit(0)

    threading.Thread(target=watchdog, daemon=True).start()
    print(json.dumps({'ready': True, 'device': enc.device, 'files': len(st['files'])}), flush=True)
    for line in sys.stdin:
        last[0] = time.time()
        try:
            req = json.loads(line)
            if req.get('quit'):
                break
            reload()
            files, owner, mat = st['files'], st['owner'], st['mat']
            t = time.time()
            q = enc.encode(['query: ' + req['q']])[0]
            s = mat @ q
            k = int(req.get('k', 30))
            best = {}
            for row in np.argsort(-s)[:k * 3]:
                fi = int(owner[row])
                if fi not in best:
                    best[fi] = float(s[row])
                if len(best) >= k:
                    break
            hits = [{'path': files[i]['path'], 'score': round(sc, 4), 'snip': files[i]['snip']} for i, sc in best.items()]
            print(json.dumps({'id': req.get('id'), 'ms': round((time.time() - t) * 1000, 1), 'hits': hits}, ensure_ascii=False), flush=True)
        except Exception as e:
            print(json.dumps({'id': None, 'error': str(e)}), flush=True)


def bench():
    for dev in ("NPU", "CPU"):
        t = time.time()
        e = Encoder(dev)
        c = time.time() - t
        txt = ['passage: quarterly invoice for the fiber optic project'] * 64
        e.encode(txt[:8])
        t = time.time()
        e.encode(txt)
        print(f'{e.device}: compile {c:.1f}s, 64 passages {time.time() - t:.2f}s')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stdin.reconfigure(encoding='utf-8')
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'serve'
    if cmd == 'devices':
        devices()
    elif cmd == 'bench':
        bench()
    elif cmd == 'index':
        index([r for r in (sys.argv[2:] or ROOTS) if os.path.isdir(r)])
    else:
        serve()
