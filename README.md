# Clickmate

Record, edit and replay input macros on GNOME/Wayland — with loops, and with
conditions that can look at the screen.

![Clickmate Extension Screenshot](docs/screenshot.png)

A macro is a tree of steps: clicks, key presses, typed text, scrolls, waits and
recorded event trains. Around them you can put `repeat`, `while`, `if` and `gate`
blocks, and every block — plus every individual step — can be guarded by a
condition:

- **pixel / region colour** — "the pixel at 840,512 is green ±24". Sub-5 ms,
  deterministic, no network.
- **ask a local vision model** — a screenshot plus your own prompt ("Is the button
  on the left green?"), answered yes/no by an OpenAI-compatible endpoint running
  on your machine.
- **and / or / not** over the above.

The macro that ships on first run is the one this was built for:

```
repeat forever:
    only continue if the model says the left button is green   → otherwise skip to the wait
    click at x,y
    press E                                                    → only when a pixel check passes
    wait 10s
```

## Features

- **Recording** of real mouse and keyboard input, coalesced into readable steps
  (clicks carry their absolute screen position, idle gaps become waits), or
  verbatim event trains for games.
- **A step editor in the panel popup** — plain-language summaries, inline editing,
  per-step *run this one* buttons, per-condition *test now* buttons, and
  enable/disable so you can bisect a macro instead of deleting from it.
- **A full tree editor in preferences** — nested conditions, every field, JSON
  import/export.
- **Emergency stop** that aborts mid-macro and releases every held key.

## How it fits together

| Piece | Role |
|---|---|
| `clickmate.c` | Root daemon. Grabs the real input devices, mirrors them to uinput clones, injects event trains on request, and streams observed events while recording. **No macro logic.** |
| `gnome-shell/` | The extension. Owns the macro model, the editor UI, all control flow, screenshots and the model calls. |

The split is deliberate: the daemon is the only thing that can see and synthesise
input below the compositor, and the shell is the only thing that knows where the
pointer actually is and can screenshot without a portal prompt. Because the
extension sends one step at a time, stopping a macro is immediate.

### Absolute positioning

uinput only speaks *relative* motion. To click at a fixed coordinate the extension
nudges the pointer, re-reads `global.get_pointer()` and repeats until it lands, so
it converges whatever the acceleration curve is doing. While a macro runs the mouse
acceleration profile is temporarily flattened (restored afterwards, and also on the
next login if the shell died mid-run), which makes it land on the first try.

If the target application grabs the pointer — games with mouse look — absolute
moves cannot converge. Record those with **Record verbatim** enabled; they replay
as raw relative event trains instead.

## Requirements

- Linux with `uinput`, GCC, `libjson-c`, `libmicrohttpd`
- GNOME Shell 50 on Wayland
- optional: any OpenAI-compatible vision endpoint, for the `llm` condition

## Installation

### Daemon

```bash
make
sudo make install
```

`clickmate.service` captures a keyboard and a mouse by default; edit the two `-d`
paths to match your hardware (`ls /dev/input/by-id/`). `-d` may be repeated.

The daemon takes an exclusive grab on those devices. The kernel drops a grab when
the process dies, so a crash self-heals — but while changing the C code, run it
from an **SSH session or a second TTY** and wrap it in `timeout 60`, so a mistake
cannot lock you out of your own keyboard.

### Extension

```bash
cd gnome-shell
pnpm install
pnpm run build
pnpm run install     # symlinks dist/ into ~/.local/share/gnome-shell/extensions
```

Log out and back in (Wayland has no `Alt+F2 r`), then enable *Clickmate*.

### A local vision model

Only needed for `llm` conditions. For example:

```bash
ollama serve
ollama pull qwen2.5vl:7b
```

then point *Preferences → Model → Endpoint* at
`http://localhost:11434/v1/chat/completions`. Preferences warns when the endpoint
is not on this machine, because every check uploads a picture of your screen to it.

## Usage

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+F5` | Open the popup |
| `Ctrl+Shift+F6` | Run / stop the selected macro |
| `Ctrl+Shift+R` | Start / stop recording into the selected macro |
| `Ctrl+Shift+P` | Capture the pointer position into the selected step |
| `Super+Escape` | Emergency stop |

Build a macro by recording it, then open the popup and adjust: click a step to
edit its fields in place, press `▶` to try just that step, press **Test now** on a
condition to see how it answers against the current screen.

### Daemon HTTP API

Over the unix socket at `/var/run/click-socket`:

```bash
curl --unix-socket /var/run/click-socket http://localhost/status

# left click: press, then release 50 ms later
curl --unix-socket /var/run/click-socket -X POST \
  -d '{"events":[{"dt":0,"type":1,"code":272,"value":1},{"dt":50000,"type":1,"code":272,"value":0}]}' \
  http://localhost/play

curl --unix-socket /var/run/click-socket -X POST -d '{"on":true}'  http://localhost/record
curl --unix-socket /var/run/click-socket -X POST -d '{}'           http://localhost/stop
socat - UNIX-CONNECT:/var/run/clickmate-events   # observed events, while recording
```

`dt` is microseconds to wait *before* the event; `type`/`code`/`value` are raw
evdev. `/play` answers once the train has finished playing. `/stop` aborts it and
releases anything still held down.

## Development

```bash
cd gnome-shell
pnpm run dev      # rebuild on change
pnpm test         # build, then run the logic smoke tests under gjs
journalctl -f -o cat /usr/bin/gnome-shell
```

`./run.sh` starts a nested shell, useful for UI work only: injected uinput events
go to the *host* session, so end-to-end runs must be tested in the real session.
Cross-check injected input with `sudo libinput debug-events` and `sudo evtest`.

### Known limits

- The control socket is mode 0666, so any local process can synthesise input
  through it. Fine for a single-user desktop; tighten it with a `RuntimeDirectory`
  and a dedicated group if that matters to you.
- `type text` assumes a US keyboard layout. For other layouts, record the typing.
- X11 is not supported.

## Uninstallation

```bash
sudo make uninstall
rm ~/.local/share/gnome-shell/extensions/clickmate@tbocek.github.com
```

### Resolving a boot delay

A boot delay after installing is usually `systemd-udev-settle.service`. It is
deprecated; mask it:

```bash
systemctl mask systemd-udev-settle.service
```

## Troubleshooting

- **Popup says it cannot reach the daemon** — `systemctl status clickmate`, and
  check the socket path in *Preferences → Input*.
- **"The clickmate daemon is out of date"** — the extension needs API v2; rerun
  `sudo make install`.
- **Clicks land in the wrong place** — leave *Flatten pointer acceleration* on, or
  check whether the target grabs the pointer (see *Absolute positioning*).
- **Daemon will not start** — check permissions on `/dev/uinput` and that
  `libjson-c` and `libmicrohttpd` are installed.

## Contributing

Contributions are welcome! Please fork the repository, make your changes, and
submit a pull request.

## Related links

- https://www.kernel.org/doc/html/v4.12/input/uinput.html
- https://stackoverflow.com/questions/20943322/accessing-keys-from-linux-input-device
