# herdr-config

My [herdr-app](https://herdr.dev) recipe — a customized layout, two mods, keybindings,
and the `/edit-herdr` Claude Code command — packaged so I can reuse it on any device.

## What's in it

| File | What it does |
|---|---|
| `config/layouts/Tim-Herdr.json` | Working layout (clone of the default `main`). Sidebar uses `tim-spaces`; top bar uses `tim-tabs`. |
| `config/mods/tim-spaces/` | Left sidebar. Adds a **Task** concept above spaces (collapsible, renamable via right-click, drag + right-click to assign spaces, space-count badge); nests each space's agents under it; collapsible subtrees. |
| `config/mods/tim-tabs/` | Top bar. Adds **GitHub** (opens the space's repo from its git remote) and **Jira** (opens the parent Task's card, prompts once, right-click to edit) buttons beside Files/Changes. |
| `config/keys.json` | Keybindings. Includes the terminal Ctrl+Left / Ctrl+Right word-jump fix for PowerShell (PSReadLine). |
| `claude/commands/edit-herdr.md` | `/edit-herdr` slash command — loads context for editing this recipe. |

The layout also references herdr's **shipped** mods (`workspace-chrome`, `pane`, `files`,
`changes`, `workspace-status`). Those come with herdr on every device, so they aren't bundled here.

## Install on a new device

```powershell
git clone https://github.com/timsun4/herdr-config.git
cd herdr-config
.\install.ps1
```

`install.ps1` backs up anything it would overwrite (to `~/.config/herdr-app/_backup-<timestamp>`),
then copies the files into `~/.config/herdr-app/` and `~/.claude/commands/`. herdr hot-reloads,
so no restart is needed. Then switch to the layout:

```powershell
herdr-app do layout.switch --name Tim-Herdr
```

(or press **Ctrl+Shift+L** in herdr and pick `Tim-Herdr`).

### Manual install
Copy `config/*` into `~/.config/herdr-app/` and `claude/commands/edit-herdr.md` into
`~/.claude/commands/`.

## Caveats
- **`keys.json` is my full keybindings file**, not just the recipe's additions — installing it
  replaces the device's existing keybindings (the installer backs the old one up first). If you
  only want the terminal word-jump fix, copy just the `terminal` section's `ctrl-left` / `ctrl-right`
  entries instead.
- The mods were cloned from herdr **0.1.16**. On a very different herdr version the mod API may have
  shifted; if a mod misbehaves, re-clone the current shipped mod and re-apply the changes.
- The `gpui-kit.d.ts` / `herdr.d.ts` editor type stubs are gitignored (~800 KB each, editor-only).
  herdr writes them into each mod folder itself; the mods run without them.
