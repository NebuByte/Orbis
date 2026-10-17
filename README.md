# Orbis

**A neural file explorer and launcher for Windows.** Orbis draws your drives as a living network of
folders, a slowly turning 3D globe, and finds anything on them by name, or by *describing* it
when you don't remember the name. It also launches your apps, does quick sums and runs Windows
commands, all from one search box.

Everything runs on your PC. Orbis sends nothing anywhere.

## Features

- **Search by name.** Every file and folder on your drives, searched as you type in a few milliseconds.
  Copies of the same item are merged into one result, and build output and AI-agent worktrees rank lower.
- **Search by meaning (optional).** Describe a document, for example *"the order for the fiber cable
  from last year"*, and Orbis finds it by what's inside, in English, Arabic and about 100 other
  languages. It runs on the PC's **NPU** when there is one (Intel AI Boost), otherwise on the Intel
  GPU or the processor.
- **The map.** Your folders form a plexus globe that turns on its own, with each layer turning against
  its neighbours. A search unfolds it into a flat map and draws glowing lines from the core to every
  result.
- **Live activity.** When a file changes, its folder lights up.
- **Launcher.** All Start-menu apps, with your five most-used (from Windows' own usage record) and
  pinned apps on the left. App icons are recoloured to match the theme.
- **Smart search box.**
  - `= 1250*12 + 15% * 200` works as a calculator.
  - `> wifi`, `> lock`, `> restart` run Windows commands from a fixed list.
  - `type:pdf changed:week in:Projects big:500mb` are filters.
- **Screen saver (optional).** When the PC sits idle, Orbis takes over the screen with a big clock and the
  turning globe. It first catches up on indexing, then shows the PC's health: processor, memory, drives
  and battery. Any key, click or mouse movement brings you back.
- **In the tray.** Closing the window hides Orbis in the system tray, where it keeps watching for changes
  and stays ready as the screen saver. Click the tray icon to bring it back. Its menu also has Start with
  Windows, Start quietly in the tray, the screen saver, and Exit.
- **8 themes**, full screen or in a modern frameless window, and keyboard-first.

## Built for every PC

The first time Orbis opens, it looks at the PC and suggests settings. Each suggestion comes with the
reason for it, and you can change any of them later.

| Detected | What Orbis suggests |
|---|---|
| Intel NPU (AI Boost) | Search by meaning runs on the NPU, so the processor stays free |
| No NPU, Intel graphics | Search by meaning runs on the Intel GPU |
| No NPU or Intel GPU | Search by meaning runs on the processor (the first read of documents is slower) |
| ARM processor | Search by meaning is off (its engine has no Windows-on-ARM build yet) |
| Less than 8 GB of RAM | Search by meaning is off by default |
| Modest hardware, or graphics without acceleration | Lite effects only: the map and the core, without glows |
| Laptop | Automatic frame rate: 60 fps plugged in, 30 on battery |

Settings this PC can't run smoothly are switched off and greyed out, with the reason shown. Orbis
also watches its own frame rate. If it keeps falling short while Orbis has the screen and the PC isn't
busy with other work, Orbis steps down by itself, first to 30 fps and then to lite effects. **Try again**
in the settings, or running the setup again, gives the faster settings another chance.

Orbis draws nothing while it is minimised or covered. It maps every fixed drive except Windows' own
folders and app caches, and it watches only your data drives and your user folders for live activity.

## Install

Download the installer from [Releases](../../releases). It installs for the current user and needs no
administrator rights. Windows 10 (1809 or later) and Windows 11 are supported, on 64-bit Intel or AMD.

**Search by meaning** is installed from inside Orbis when you switch it on. It is a one-time download of
about 1.1 GB, placed in `%LOCALAPPDATA%\Orbis\engine`:

- [uv](https://github.com/astral-sh/uv), which sets up a private Python
- [OpenVINO](https://github.com/openvinotoolkit/openvino), the AI runtime
- the [multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small) language model

Nothing is installed system-wide, and no system Python is needed.

## Privacy

Orbis has no telemetry, no account and no cloud service. The only network access is the optional
engine download above, from GitHub, PyPI and Hugging Face. The file index, the document index,
settings and icons stay in `%LOCALAPPDATA%\Orbis`.

## Keys

| Key | Action |
|---|---|
| type | search apps, files and folders, or describe a document |
| ↑ ↓ | move through the results |
| Enter | open or launch, then clear the search |
| Esc | clear |
| F11 | switch between full screen and a window |
| Ctrl+K | jump to the search box |
| Ctrl+Q | quit completely (closing the window only hides Orbis in the tray) |
| right-click an app | pin or unpin it |

## Build from source

You need [Rust](https://rustup.rs) (stable) and the Tauri CLI (`cargo install tauri-cli --version "^2"`).

```
cargo tauri build      # the installer ends up in src-tauri/target/release/bundle/nsis
cargo build --release  # or just the program: src-tauri/target/release/orbis.exe
```

How the code is organised:

| Path | What it holds |
|---|---|
| `src-tauri/src/` | the Rust side: indexing (`index.rs`), the launcher (`apps.rs`), hardware detection (`env.rs`), live activity (`watch.rs`), the search-by-meaning bridge (`sem.rs`) |
| `ui/` | the interface: plain HTML, CSS and JavaScript; WebGL for the map |
| `semantic/orbis_sem.py` | the search-by-meaning helper (built into `orbis.exe` and written out when needed) |

For development, set `ORBIS_ENGINE` to a folder that already has an engine installed.

## Uninstall

Remove Orbis from Windows Settings → Apps. The uninstaller also stops Orbis from starting with Windows
and from being the screen saver. To also delete its data and the search engine, delete
`%LOCALAPPDATA%\Orbis`.

## License

Orbis is free and open source under the [MIT License](LICENSE): use it, change it and share it, as long as the copyright notice stays.
