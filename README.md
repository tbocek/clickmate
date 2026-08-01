# Clickmate

Record, edit and replay input macros on GNOME/Wayland — with loops, and with
conditions that can look at the screen.

![Clickmate Extension Screenshot](docs/screenshot.png)

A macro is a tree of steps: clicks, key presses, typed text, scrolls, waits and
recorded event trains. Around them you can put `loop` and `if` blocks. A loop
only counts — forever, or a fixed number of times; you leave it with `break`
inside an `if`, which keeps every condition in one place:

- **screen colour** — "the pixel at 840,512 is green ±24", or "60% of this
  40×40 area is green". Sub-5 ms, deterministic, no network.
- **ask a local vision model** — a screenshot plus your own prompt ("Is the button
  on the left green?"), answered yes/no by an OpenAI-compatible endpoint running
  on your machine.
- **and / or / not** over the above.

The macro that ships on first run is the one this was built for:

```
repeat forever:
    if the model says the left button is green:
        click at x,y
        if a colour check passes:
            press E
    wait 10s
```

## Features

- **Recording** of real mouse and keyboard input, coalesced into readable steps:
  clicks carry their absolute screen position, pointer movement becomes a move
  step wherever it comes to rest, and idle gaps become waits.
- **A full tree editor in preferences** — every step and condition, nested
  loops and `and`/`or`/`not`, plain-language summaries, and JSON import/export
  to a file you choose.
- **A panel popup that stays out of the way** — a switch, a stop, what is
  running, and a way into the settings.
- **Several macros at once** — a switch per macro says which ones **Run**
  starts, and they run side by side, interleaving a step at a time over the one
  pointer and keyboard.
- **Pause and continue** — halting a run remembers the step it was on, and
  selecting a step is what says where the next run starts.
- **Record straight into a loop body** — click the row a recording should land
  on, and watch it go red while the recording runs. The same selection is where
  a run continues from: one mark for “here”.
- **Emergency stop** that aborts mid-macro and releases every held key.

## How it fits together

| Piece | Role |
|---|---|
| `clickmate.c` | Root daemon. Grabs the real input devices, mirrors them to uinput clones, injects event trains on request, and streams observed events while recording. Always forwards real input. **No macro logic.** |
| `gnome-shell/` | The extension. Owns the macro model, the editor UI, all control flow, screenshots and the model calls. |

The split is deliberate: the daemon is the only thing that can see and synthesise
input below the compositor, and the shell is the only thing that knows where the
pointer actually is and can screenshot without a portal prompt. Because the
extension sends one step at a time, stopping a macro is immediate.

### Absolute positioning

uinput only speaks *relative* motion. To click at a fixed coordinate the extension
nudges the pointer, re-reads `global.get_pointer()` and repeats until it is within
a pixel — up to a dozen passes, each one daemon round trip. It converges whatever
the acceleration curve is doing, which is why nothing has to touch your mouse
settings to make it work. With the acceleration profile left on `default` the
compositor scales each nudge, so the walk takes several passes and you can watch
it happen; `flat` lands it in one.

The walk and the click that follows it hold the daemon between them
(`DaemonClient.exclusive`), so nothing else plays in the middle of a
measurement — the pointer being read back has to be the one the last nudge
moved.

If the target application grabs the pointer — a game with mouse-look — the
reported position never changes and absolute moves cannot converge. The status
line says so rather than silently clicking the wrong place. Use `move` steps with
a relative offset for those.

## Requirements

- Linux with `uinput`, GCC, `libjson-c`, `libmicrohttpd`
- GNOME Shell 50 on Wayland
- optional: any OpenAI-compatible vision endpoint, for the `llm` condition

## Installation

```bash
./deploy.sh
```

Rebuilds and installs the daemon, rebuilds the extension, and prints what the
daemon captured. Run it as yourself — it asks for sudo only for the daemon. Then
log out and back in.

The two halves separately:

### Daemon

```bash
make
sudo make install
```

`clickmate.service` names the devices to capture. List yours with:

```bash
grep '^N: Name' /proc/bus/input/devices
```

and edit the `-n` lines to match. Names rather than paths, because anything
paired through a wireless receiver gets no entry under `/dev/input/by-id` at all,
and bare `/dev/input/eventN` numbers move around between boots. `-d PATH` still
works if you prefer it. A name that matches nothing is only a warning, so an
unplugged device does not stop the rest from being captured.

**Capture every device you intend to record from.** A keyboard-with-touchpad and
a separate mouse are two devices; if the mouse is not listed, the daemon never
sees it and nothing it does is recorded or observed.

Devices do not have to exist when the daemon starts. `/dev/input` is watched, so
anything matching is captured when it appears and reattached when it comes back
after being unplugged. That matters more than it sounds: a wireless mouse often
pairs a second or two into boot, and a remapper upstream of clickmate rebuilds
its virtual keyboard every time it is restarted. Both used to leave the daemon
running against devices that no longer existed, with nothing but a line in the
journal to say so. `journalctl -u clickmate -f` shows `captured`, `reattached`
and `detached` as they happen.

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

Endpoint, model and timeout are global — conditions carry only the prompt, the
screen area, and what to do on a failure. Each condition is asked for a single
JSON object, `{"match": true|false, "reason": "…"}`, and `response_format:
json_object` is sent so servers that support constrained decoding enforce it
(the field is dropped automatically if the server rejects it). Small models
still wander, so the reply parser also accepts fenced JSON, `"true"` as a
string, `1`/`0`, alternate keys like `answer` or `result`, trailing chatter, and
a bare YES/NO. If a prompt misbehaves, the popup's status line shows what the
model actually said.

Reasoning models get `chat_template_kwargs: {enable_thinking: false}`, because a
model that deliberates over every screenshot answers seconds late — or, once its
token budget runs out mid-thought, not at all. Templates that do not know the
field ignore it, and a server that rejects it is retried without it. Thinking
that arrives anyway is dropped: it is prose full of braces and the words *true*
and *no*, and reading a verdict out of half a thought would be worse than
reporting that none was found.

## Usage

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+F5` | Emergency stop |
| `Ctrl+Shift+F6` | Run the macros that are switched on / pause them / continue |
| `Ctrl+Shift+R` | Start / stop recording into the selected macro |
| `Ctrl+Shift+M` | Capture one click or move, appended to the selected macro |

The panel popup holds only a run switch, a **Stop**, what is running, and a
**Settings** button. It is also where progress shows up: the current step, the
last condition verdict, "Recorded 3 steps". That text is kept after the fact,
because most of it happens while the menu is closed — click the panel icon to
read it. Everything else — macros, steps, conditions, which macros run — lives
in the preferences window.

### Switched on, and running several at once

Each macro has a switch next to its name in the editor, and **Run** starts every
macro that is switched on — all of them, at the same time. They are independent:
each keeps its own place in its own steps, and one finishing or failing does not
touch the others. What they share is the machine, so their steps interleave,
taking turns at the pointer and keyboard one step each. A step is the unit: a
click at a fixed position holds the pointer for its whole walk *and* the click
at the end of it, so no other macro can land a nudge in the middle and leave it
clicking somewhere else. Two macros both moving the mouse still take it in turns
and will end up somewhere neither meant; two watching different corners of the
screen and clicking different buttons will not.

Beside the switch is a **▶** that runs that one macro, on or off, right now —
and turns into a **■** while it runs, which is also how the editor shows you
which macros are going without your having to look at the panel.

A macro that is switched off is still yours to edit, record into and step
through; it just does not join in when you press Run.

The macro is the only thing there is a switch for. Steps have none: a step that
is in a macro runs when that macro runs. Something you want out of the way for
now is either deleted or put behind an `if` that says when it applies. (Steps
used to carry a switch each; documents saved with one lose it on first load, and
those steps run.)

Macros can also drive each other. A `start` step names a macro and starts it; if
that macro is already going it is stopped first and begins again from the top,
which is the whole point — a watcher that notices the screen has gone back to its
starting state can put the macro that works it back at the beginning. A `stop`
step names one and ends it. Both offer **This macro** as the first choice, so a
`start` with nothing named is "go round again from the top" and a `stop` with
nothing named ends the run it is in, the way a `break` ends a loop. Delete a
macro something points at and the step falls back to meaning this one next time
the editor draws it; reach it in a run before that and the run stops with an
error rather than carrying on quietly.

### Pause, continue, stop

`Ctrl+Shift+F6` — and the switch in the popup — starts the macros that are
switched on, and halts running ones. With one macro running, halting writes down
the step it was on, so the switch reads **Continue** and the next press picks up
there rather than at the top. Several at once are in several places and there is
only one mark, so rather than be wrong about which, the next press starts them
all from the top. **Stop** in the popup, and the emergency shortcut, throw the
place away too.

You can also choose the step yourself: select it. The selected row is the one
mark the editor has — a recording lands there, and a run starts there — so
picking up in the middle of a macro is the same gesture as recording into the
middle of one. There is one selection across the whole page, in whichever macro
you last clicked; that macro is the one recordings go into, and the one that
starts at the selected step. Only a step counts for running; selecting a body,
or the end of a macro, starts at the top, and so do the other macros. A run that
fails selects the step that failed, so you can fix it and press the shortcut
again instead of replaying everything before it, and a run that reaches the end
puts the selection back at the end of its own macro.

The mark is taken at face value: continuing into the `then` or `else` of a
condition runs that branch without asking the condition again, since asking
could send the run down the other one and skip the very step you picked. A loop
you continue into is only shortened for that one pass — the next time round it
runs its whole body.

Separately from all this, while a macro is running, opening the menu and putting
the pointer on it holds the run between steps — otherwise a macro clicking at
fixed coordinates could click its own menu. It carries on as soon as you move
off the menu or close it.

Build a macro by recording it (`Ctrl+Shift+R`), then open Settings to adjust it.
Recorded steps go on the row you selected. Click any row in any macro and it is
tinted to show it: a step, and the recording is dropped in right after it; an
**Add a step here** row inside a loop, or a **Yes** or **No** header, and the
recording goes at the end of that
body. Selecting nothing leaves **The end of the macro**, which is where a
recording goes by default. Choose the body of a loop and a recording lands inside
the loop instead of after it — which is what you want in a macro that is one
endless loop, and until now meant recording at the end and moving every step in
by hand. Appending to the end of a macro that never gets there still tells you
so; a body has no such trap.

While a recording is running, the selected row turns a stronger red, so you can
see where the next click will land without looking at the panel.

Recording always resumes from wherever the macro already leaves the pointer.
Between two sessions the mouse gets used for other things, and moving it back to
that spot is not a step worth keeping, so it is not recorded. Anywhere else is,
at its true screen position — coordinates are never shifted.

An `if` draws its **No** block above its **Yes** block. The failure case is the
one you go looking for — the branch that says what happens when the screen is not
what you hoped — and putting it first means it is not buried under a `then` that
has grown. It changes nothing about the run: the condition is still asked once
and the matching branch still runs.

Steps are added from the **Add a step…** dropdown, which is also the button:
picking a kind adds it there, at the end of whichever list the dropdown sits in.
The row it sits on is the last row of that list, under the steps, because that is
where what it adds appears.
Next to it, **Record one** captures a single action, which is the quickest way
to fill in coordinates: the window gets out of the way, and the next click you
make becomes a `click` step at that position. If you move the pointer and hold
still for about a second instead, you get a `move` step. `Ctrl+Shift+M` does the
same thing without opening Settings, into whichever row is selected.

The **▶** on a step does that one step immediately, on the real screen: the
window drops out of the way, the step runs, and the window comes back. It is the
quickest way to check that a click really lands where you meant it to, without
running the macro around it. Steps that only mean something inside a run do not
get one — a loop or an `if` would take its whole body along, and an endless loop
would take the session with it from a window that has no Stop. A step that ran
becomes the selected row, so the insertion point walks down the macro with you:
whatever you record next carries on from where you got to, rather than from
wherever the selection started out.

**Move up** and **Move down** treat the editor as what you see. A folded loop is
one card, so a step passes it in a single press; an open one is a place with an
inside, so the same press moves the step into it — in at the top coming down, in
at the bottom coming up. An `if` is entered by the side you arrive from, in the
order the two blocks are drawn: **No** from above, **Yes** from below, skipping
either if it is folded shut. Pressing on
past the end of a body climbs back out around the loop, so nothing that moved in
is stuck there.

Coordinates are single fields — `100, 200` for a point, `10, 20, 40, 40` for an
area — each with a **Show** button that flashes a red X (or an outline) at that
spot on the real screen for a couple of seconds, so you can check a number
without running anything. Next to it, **Pick** fills the field by pointing: the
window gets out of the way, you click where you mean, and the position lands in
the field — the same gesture as **Record one**, without adding a step, which is
how you correct a coordinate that has moved. On an area it moves the corner and
leaves the size alone. A pick that catches nothing before it times out says so
and leaves the field as it was. A step's title follows its coordinates, so a
click that now goes somewhere else says where.

Where a click or a move goes is one row: the numbers, **Pick**, **Show**, and a
button for not using coordinates at all. On a click that button means "wherever
the pointer already is", and the numbers go away with it; on a move it means "by
this much" rather than "to here", and the numbers stay but stop being a place —
so **Pick** and **Show**, which are about a spot on the screen, go instead. It
used to be a dropdown naming the mode with the coordinates on a second row
underneath: a line of prose and a line of numbers to say one thing.

Screen areas for `llm` conditions can also be chosen with **Pick area…**, which
drops the window out of the way and lets you drag a rectangle over the screen.

At the top of the Macros page, **Backup** has an **Export** and an **Import**,
each offering **Macros** or **Settings** — two files, because they move for
different reasons: the steps are the work, the settings are the machine they run
on. Both open a file chooser, so where a backup goes and which one comes back is
yours to say; the names `clickmate-macros.json` and `clickmate-settings.json` are
only what the save dialog starts with. Importing macros replaces every macro you
have. Importing settings skips anything the schema does not know or will not
take, and says which keys it ignored.

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
```

### Checking what is captured

`tools/watch-events` drives the daemon on its own — no shell extension involved.
It lists the captured devices, turns recording on, decodes the stream, and tells
you which devices actually produced anything:

```bash
tools/watch-events 15      # watch for 15 seconds, then summarise
tools/watch-events         # until Ctrl-C
tools/watch-events 15 --raw
```

If a device does not appear here, nothing above the daemon can see it either —
add it to `clickmate.service` with `-n "<its name>"`.

Or by hand (`socat` works too, if you have it):

```bash
curl --unix-socket /var/run/click-socket -X POST -d '{"on":true}' http://localhost/record
python3 -c "
import socket; s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect('/var/run/clickmate-events')
[print(s.recv(4096).decode(), end='') for _ in range(20)]"
curl --unix-socket /var/run/click-socket -X POST -d '{"on":false}' http://localhost/record
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
- **Clicks land in the wrong place** — check whether the target grabs the
  pointer (see *Absolute positioning*); the status line reports a move that
  could not converge.
- **Daemon will not start** — check permissions on `/dev/uinput` and that
  `libjson-c` and `libmicrohttpd` are installed.

## Contributing

Contributions are welcome! Please fork the repository, make your changes, and
submit a pull request.

## Related links

- https://www.kernel.org/doc/html/v4.12/input/uinput.html
- https://stackoverflow.com/questions/20943322/accessing-keys-from-linux-input-device
