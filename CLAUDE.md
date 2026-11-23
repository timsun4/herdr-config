# CLAUDE.md — developing herdr recipes

This repo is a **packaged copy** of a [herdr-app](https://herdr.dev) recipe: a customized
layout, mods, keybindings, and the `/edit-herdr` command. The files here mirror two live
locations and are meant to be copied into them (see `install.ps1`):

| Repo path | Live location |
|---|---|
| `config/*` | `~/.config/herdr-app/` |
| `claude/commands/edit-herdr.md` | `~/.claude/commands/` |

## How herdr recipes work

herdr's entire UI is a folder of files under `~/.config/herdr-app/` that **hot-reload within
~1s of saving** — no build, no restart for layouts/mods/keys/settings.

| File | Decides |
|---|---|
| `layouts/<name>.json` | the window: regions, sizes, colors, fonts, pane frames, which mod goes where |
| `mods/<name>/main.js` | a panel's code — JS describing native GPUI elements via gpui-kit (no HTML/DOM/CSS) |
| `mods/<name>/mod.json` | where a mod first docks: `{ "place": "left\|right\|top\|bottom\|none", "title": ... }` |
| `keys.json` | keybindings (`global`, `layout:<name>`, `terminal`, `mod:<name>` sections) |
| `settings.json`, `themes/<name>.json`, `programs.json` | person/zoom/fonts, colors, program display |

**`~/.config/herdr-app/AGENTS.md`** is the authoritative, version-matched reference (layout node
tree, cascade rules, every CLI command, mod API, types in `gpui-kit.d.ts` / `herdr.d.ts`). It's
rewritten on every app start. Read the section you need there before editing.

### The rule that bites: clone before editing shipped things
Shipped layouts (`main`, `terminals`, `win98`) and their mods are herdr's, **read-only, and
replaced whole on every app start.** Editing them in place gets your work moved aside to
`<name>-edited` on next launch. Clone first, then edit the clone:

```powershell
herdr-app do layout.clone --name main --as <my-layout>   # also switches to it
herdr-app do mod.clone    --name <mod>  --as <my-mod>     # then point the layout's content.mod at it
```

This recipe's clones: layout **`tim-test`** (from `main`), mods **`tim-spaces`** (from `spaces`),
**`tim-tabs`** (from `tabs`). It still references herdr's shipped mods (`workspace-chrome`, `pane`,
`files`, `changes`, `workspace-status`), which exist on every device and aren't bundled here.

## Dev loop

Edit the **live** files (hot-reload gives instant feedback), then copy the changed ones back into
this repo to commit. (Editing the repo copy does nothing until `install.ps1` copies it live.)

1. Edit under a cloned name in `~/.config/herdr-app/`. Save = live in ~1s.
2. Verify:
   - A bad save is ignored silently; the reason goes to `<name>.error` (`layout.error`,
     `<mod>.error`). Scan for `*.error` after editing.
   - Mod syntax: `herdr-app check ~/.config/herdr-app/mods/<name>` (exit 0 = ok; a
     `WARN ... mod called hc` is fine).
   - See the window: `herdr-app shot <file.png>` writes a PNG of the live frame; read it.
3. Copy the changed files back here and commit.

## gpui-kit essentials (mods)
- Imports: `View, div, svg, image` from `"gpui-kit"`; `h_flex, v_flex, ScrollHandle, InputState,
  Input` from `"gpui-base"` (**Input/InputState live in gpui-base, not gpui-kit**); `spaces, panes,
  agents, run, openOverlay, closeOverlay, props, exec, theme, shared, setShared, window, layout,
  settings` from `"herdr"`.
- A mod is a `View` subclass with `init(cx)` and `render(cx)`; layout via chainable methods on
  `div()/h_flex()/v_flex()`. `cx.open_url(url)`, `cx.spawn(async cx => …)`, `cx.notify()`,
  `cx.stop_propagation()`.
- **shared state** (`shared(key)` / `setShared(key, val)`) persists in `shared.json` and is shared
  across mod instances by key. This recipe uses it for Tasks (`tim-spaces.tasks`), rename state,
  and per-task Jira links.
- **Overlays**: `openOverlay({ mod, kind:"popup", width, height, props })` opens a mod instance;
  `props().overlay` is the id for `closeOverlay`. Menus/popups here are self-overlays (a mod opens
  itself with different `props`, and `render` branches on them).

## PowerShell gotchas on this machine
- Pass CLI args as `--flags`, NOT inline JSON: `herdr-app do X --key val` (inline `'{"k":"v"}'`
  gets mangled by the shell).
- Don't assign `$HOME` (read-only); use another name like `$hd`.
- `herdr-app commands` lists every command and its args; `herdr-app status` shows what's on screen;
  `herdr-app ls` shows spaces/tabs/terminals.

## Scope note
`config/keys.json` is the **full** keybindings file, not just this recipe's additions — installing
it replaces a device's keybindings (the installer backs up first). Only the `terminal`
`ctrl-left`/`ctrl-right` word-jump entries are recipe-specific.
