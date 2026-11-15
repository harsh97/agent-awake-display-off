# Agent Awake, Display Off

Keeps the computer from suspending while it should stay awake, without keeping the display on. The status bar item shows the current mode (`Awake: On`, `Awake: Agent`, `Awake: Off`), accented while the plugin holds the inhibitor.

**Platform: Linux only.** The worker holds the inhibitor with `systemd-inhibit` and verifies it with `systemd-inhibit --list`. On other platforms it loads, does nothing, and the item shows `Awake: n/a`.

## Modes

The same choices as Orca's own keep-awake control.

| Mode | Behaviour |
| --- | --- |
| `On` | Always hold a sleep inhibitor, even with no agents. |
| `Agent` | Hold it only while an agent's state is `working` (the default). |
| `Off` | Never hold it; the computer sleeps as normal. |

Click the status bar item to cycle On → Agent → Off → On; the tooltip names the next mode. Each mode is also a palette command (`Agent Awake: Switch Mode`, plus direct `… (On)`, `… (Agent)`, `… (Off)` entries), and the same `Keep awake mode` picker appears under this plugin in **Settings → Plugins**. Orca stores the setting, so it survives restarts.

The click is optimistic: the item switches mode immediately, before the setting write or the `systemd-inhibit` spawn has finished. Three seconds later the worker reads the ground truth — the mode Orca actually stored, and whether `systemd-inhibit --list` really has this plugin's row — and shows the system's state if either differs, logging why. That check is read-only; the next regular sync retries the mode. A failed spawn or a leftover inhibitor shows as `Awake: Failed` in the danger tone.

The display may turn off in every mode: `On` and `Agent` add a logind sleep inhibitor only, and neither blocks idle or DPMS.

## Why Orca's built-in keeps the display on

Orca's **Keep computer awake** setting (On / Agent / Off) calls Electron's `powerSaveBlocker.start('prevent-display-sleep')`, which blocks display sleep by design. On Linux Orca also spawns:

```sh
systemd-inhibit --what=sleep:handle-lid-switch --who=Orca \
  --why="Agents are working" --mode=block cat
```

The `systemd-inhibit` call is the part that is wanted: it blocks system suspend and lid-close suspend without touching the screen. The `prevent-display-sleep` blocker is the part that keeps the display lit.

This plugin holds only the logind inhibitor:

```sh
systemd-inhibit --what=sleep:handle-lid-switch --who=orca-agent-awake \
  --why="Orca agents are working; the display may turn off" --mode=block cat
```

## Permissions

The plugin runs one program, `systemd-inhibit`, in two ways:

```sh
systemd-inhibit --what=sleep:handle-lid-switch --who=orca-agent-awake \
  --why="Orca agents are working; the display may turn off" --mode=block cat
systemd-inhibit --list
```

- The first holds the inhibitor. `cat` runs on a stdin pipe, so the kernel releases the inhibitor if the worker exits.
- The second is read-only. It is used to check whether this plugin's inhibitor is really held and whether Orca's built-in keep-awake holds one too. The plugin never releases or changes another program's inhibitor.
- It never requests `idle`, never uses `handle-suspend-key`, and never starts a display blocker. DPMS and GNOME's blank-screen timer keep working; the plugin never reads or writes `org.gnome.desktop.session idle-delay`.
- It makes no network requests: no telemetry, no analytics, no update checks.
- It declares two capabilities: `agent:read`, to know when an agent is working (`agent.status.changed` events and `agents.list`), and `settings:own`, for its own `Keep awake mode` setting. It has no storage, no secrets and no file access.

## Setup

1. Install and enable the plugin.
2. Set **Settings → Keep computer awake → Off**.

Step 2 matters: with the built-in on *Agent* or *On*, Orca still holds `prevent-display-sleep`, so the display stays on even though this plugin has released its own inhibitor. The plugin checks `systemd-inhibit --list` every five minutes; when it sees the built-in's `Orca` row it logs a warning and adds one to its status bar tooltip.

## Behaviour

- `On` holds the inhibitor regardless of agents. `Agent` holds it only while an agent's state is `working`; `blocked`, `waiting` and `done` let the machine sleep. `Off` never holds it.
- Agent states come from `agent.status.changed` events. Orca does not replay status to a newly started worker, so the worker also reads `agents.list` at startup and every 30 seconds (the focused workspace) to catch an agent that was already running when the plugin was enabled.
- `cat` runs on a stdin pipe: if Orca or the worker dies, stdin closes, `cat` exits, and logind releases the inhibitor. `deactivate()` also releases it.
- `systemd-inhibit` failures retry every 30 seconds; a missing binary is logged once and disables the inhibitor for that run.

## Verify it

```sh
systemd-inhibit --list | grep orca-agent-awake   # while an agent works
gsettings get org.gnome.desktop.session idle-delay
```

`--what` must read `sleep:handle-lid-switch` — no `idle`, no display entry. With `idle-delay` at 180 seconds the screen still blanks after three idle minutes; the inhibitor only stops suspend.

## Develop

```sh
orca plugin validate . --json
orca plugin test . --json
orca plugin check . --json
orca plugin dev load .            # first run prints the approval fingerprint
npx tsc -p .                      # type-check against .orca/types
```
