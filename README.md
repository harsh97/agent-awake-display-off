# Agent Awake, Display Off

Keeps the computer from suspending while it should stay awake, but lets the
display turn off. The status bar shows the current mode (`Awake: On`,
`Awake: Agent`, `Awake: Off`), accented while it holds the inhibitor.

## Modes (same choices as Orca's own control)

| Mode | Behaviour |
| --- | --- |
| `On` | Always hold a sleep inhibitor, even with no agents. |
| `Agent` | Hold it only while an agent's state is `working` (the default). |
| `Off` | Never hold it; the computer sleeps as normal. |

**Click the status bar item to cycle On → Agent → Off → On.** The tooltip names
the next mode. Each mode is also a palette command (`Agent Awake: Switch Mode`,
plus direct `… (On)`, `… (Agent)`, `… (Off)` entries), and the same `Keep awake
mode` picker appears under this plugin in **Settings → Plugins**. The setting is
stored by Orca and survives restarts.

The click is optimistic: the item switches mode immediately, even before the
setting write or the `systemd-inhibit` spawn has finished. Three seconds later
the worker reads the ground truth — the mode Orca actually stored and whether
`systemd-inhibit --list` really has this plugin's row — and switches the item to
what the system actually has if either differs, logging why. That check is
read-only: the next regular sync retries the mode. Failed spawns and leftover
inhibitors show as `Awake: Failed` in the danger tone.

The display is allowed to turn off in every mode. `On` and `Agent` only add a
logind sleep inhibitor; they never block idle or DPMS.

## Why Orca's built-in keeps the display on

Orca's **Keep computer awake** setting (On / Agent / Off) calls Electron's
`powerSaveBlocker.start('prevent-display-sleep')`. That blocks display sleep by
design, and on Linux Orca also spawns:

```sh
systemd-inhibit --what=sleep:handle-lid-switch --who=Orca \
  --why="Agents are working" --mode=block cat
```

The `systemd-inhibit` part is exactly what is wanted — it blocks system suspend
and lid-close suspend without touching the screen. The `prevent-display-sleep`
blocker is the part that keeps the laptop's display lit.

This plugin holds only the logind inhibitor:

```sh
systemd-inhibit --what=sleep:handle-lid-switch --who=orca-agent-awake \
  --why="Orca agents are working; the display may turn off" --mode=block cat
```

It never asks for `idle`, never uses `handle-suspend-key`, and never calls a
display blocker. GNOME's blank-screen timer (`org.gnome.desktop.session
idle-delay`) and DPMS keep working normally, so the screen turns off while the
machine stays awake.

## Setup

1. Install and enable the plugin.
2. Set **Settings → Keep computer awake → Off**.

Step 2 matters: with the built-in on *Agent* or *On*, Orca still holds
`prevent-display-sleep`, so the display stays on even though this plugin has
released its own inhibitor. The plugin checks `systemd-inhibit --list` every
five minutes; when it sees the built-in's `Orca` row it logs a warning and adds
one to its status bar tooltip.

## Behaviour

- `On` holds the inhibitor regardless of agents. `Agent` holds it only while an
  agent's state is `working`; `blocked`, `waiting` and `done` let the machine
  sleep. `Off` never holds it.
- Agent states come from `agent.status.changed` events. Because Orca does not
  replay status to a newly started worker, the worker also reads `agents.list`
  at startup and every 30 seconds (the focused workspace) to catch an agent
  that was already running when the plugin was enabled.
- `cat` runs on a stdin pipe: if Orca or the worker dies, stdin closes, `cat`
  exits, and logind releases the inhibitor. `deactivate()` also releases it.
- `systemd-inhibit` failures retry every 30 seconds; a missing binary is logged
  once and disabled.
- Linux only. On other platforms the item shows `Awake: n/a` and nothing runs.

## Verify it

```sh
systemd-inhibit --list | grep orca-agent-awake   # while an agent works
gsettings get org.gnome.desktop.session idle-delay
```

`--what` must read `sleep:handle-lid-switch` — no `idle`, no display entry.
With `idle-delay` at 180 seconds the screen still blanks after three idle
minutes; the inhibitor only stops suspend.

## Develop

```sh
orca plugin validate . --json
orca plugin test . --json
orca plugin check . --json
orca plugin dev load .            # first run prints the approval fingerprint
npx tsc -p .                      # type-check against .orca/types
```
