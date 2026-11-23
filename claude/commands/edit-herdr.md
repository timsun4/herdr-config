---
description: Load context for editing the Herdr desktop app's UI (layouts, mods, keys, theme)
argument-hint: [what you want to change]
---

You are editing **Herdr** (`herdr-app`), a desktop app for terminals and coding
agents. Its entire UI is a folder of files that **hot-reload within ~1 second of
saving** — no build, no restart for layouts/mods/keys/settings. Your job: make the
change the user asks for by editing those files, and confirm it took.

The change requested: $ARGUMENTS

## Where things live

Home folder: `C:\Users\tim.sun\.config\herdr-app\`

| Path | Decides |
|---|---|
| `layouts/<name>.json` | the whole window: regions, sizes, colors, theme, fonts, pane frames, which mod goes where |
| `mods/<name>/main.js` | a panel's code (JS describing native GPUI elements via gpui-kit — no HTML/DOM/CSS) |
| `mods/<name>/mod.json` | where a mod first docks: `{ "place": "left|right|top|bottom|none", "size": N }` |
| `keys.json` | keybindings (`global`, `layout:<name>`, `terminal`, `mod:<name>` sections) |
| `settings.json` | the person: zoom, fonts, theme, sounds, worktree dir |
| `themes/<name>.json` | colors only |
| `programs.json` | how programs show (name, icon, tile) |

**`AGENTS.md`** in that folder is the authoritative reference (~1160 lines: layout
node tree, look/cascade rules, every command, mod API, types in `gpui-kit.d.ts` and
`herdr.d.ts`). Read the sections you need before editing; it's rewritten on every app
start so it always matches the installed version.

## The one rule that bites: clone before editing shipped things

The shipped layouts (`main`, `terminals`, `win98`) and their mods are **Herdr's,
read-only, and replaced whole on every app start.** Editing them in place gets your
work moved aside to `<name>-edited` on next launch. So clone first, then edit the clone:

```powershell
herdr-app do layout.clone --name main --as <my-layout>   # also switches to it
herdr-app do mod.clone    --name <mod>  --as <my-mod>     # then point layout's content.mod at it
```

### The user's existing live workspace (edit these for live results, not `main`)
- Layout: **`tim-test`** (clone of `main`) — their working layout.
- Mod: **`tim-spaces`** (clone of `spaces`) — shows each space's agents nested under it.
- Frozen reference copy of the default: `C:\Users\tim.sun\OneDrive - Veterans United Home Loans\herdr`

If the user doesn't name a layout, assume they mean `tim-test`. Ask before touching
`main` or any shipped file.

## Edit loop

1. Read the real file(s) you'll change (and the relevant `AGENTS.md` section).
2. Edit under a cloned name. Save = live in ~1s.
3. Verify:
   - A bad save is ignored silently and the reason goes to `<name>.error`
     (`layout.error`, `<mod>.error`). Scan for `*.error` after editing.
   - For a mod: `herdr-app check C:\Users\tim.sun\.config\herdr-app\mods\<name>`
     (exit 0 = ok; a `WARN ... mod called hc` is fine).
   - See the window: `herdr-app shot <file.png>` writes a PNG of the live frame;
     Read it to inspect the result.

## PowerShell gotchas on this machine
- Pass command args as `--flags`, NOT inline JSON: `herdr-app do X --key val`
  (inline `'{"k":"v"}'` gets mangled by the shell).
- Don't assign `$HOME` (read-only); use another name like `$hd`.
- `herdr-app do <command>` prints what it made or `{"error": ...}` and exits 1 on error.
- `herdr-app commands` lists every command and its args; `herdr-app status` shows
  what's on screen; `herdr-app ls` shows spaces/tabs/terminals.

Make only the change asked. Keep edits in clones. Report what changed, and show a
screenshot when the change is visual.
