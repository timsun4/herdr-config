// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, InputState, Input } from "gpui-base";
import { spaces, machines, panes, agents, run, openOverlay, closeOverlay, props, exec, hc, theme, shared, setShared, watchFolder, window, layout } from "herdr";

// Drops the status glyph/spinner an agent puts before its title ("✦  Working").
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const RAIL_CELL = 32;
// A space's name and its git tail never shrink below this, so a short one ("api")
// stays readable instead of turning into an ellipsis next to a long branch.
const SIDE_MIN = 48;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;
// Places looked at together (two git runs each). All at once, a few hundred spaces
// run out of the app's open files (256 when started from the Dock on macOS) or
// past a machine core's 16 running execs, and those spaces wait for FALLBACK.
const AT_ONCE = 6;

// Both runs, finished: a place isn't done while one of its runs still holds a slot.
async function both(a, b) {
  const done = await Promise.allSettled([a, b]);
  const failed = done.find((d) => d.status === "rejected");
  if (failed) throw failed.reason;
  return done.map((d) => d.value);
}

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    if (props()?.assign != null || props()?.taskMenu != null || props()?.agentMenu != null) return; // bare overlay instances
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Map(); // local repos' pending folder watches
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.renaming = null;       // id of the task whose name is being edited
    this.taskDrag = null;       // id of the task being dragged to reorder
    this.taskOver = null;       // id of the task the drag is currently over
    this.spaceDropTask = null;  // id of the task/"__ungrouped__" a dragged space would drop into
    this.hoveredSpace = null;   // id of the space under the pointer (shows its "add to task" button)
    this.renameState = InputState.new({ placeholder: "Task name" });
    this.renameState.on("submit", (_e, cx) => this.commitRename(cx));
    this.renameState.on("blur", (_e, cx) => this.commitRename(cx));
    this.scroll = ScrollHandle.new(); // the list's position: the active space is brought into view through it
    this.activeAt = -1; // the active space's place among the list's children (headers and rows), -1 when not drawn
    this.machines = [];
    try {
      this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
      if (!this.reconnecting || typeof this.reconnecting !== "object" || Array.isArray(this.reconnecting)) this.reconnecting = {};
      for (const state of Object.values(this.reconnecting)) state.busy = false;
    } catch { this.reconnecting = {}; }
    try { this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]")); } catch { this.folded = new Set(); }
    try { this.foldedSpaces = new Set(JSON.parse(localStorage.getItem("tim-spaces.foldedSpaces") ?? "[]")); } catch { this.foldedSpaces = new Set(); }
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // Refresh only when the refs could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    for (const k of Object.keys(this.git)) if (!keys.has(k)) {
      delete this.git[k];
      delete this.checked[k];
      this.unsure.delete(k);
    }
    const repos = new Set(Object.values(this.git).filter(Boolean).map((g) => g.repo));
    for (const [repo, pending] of this.watching) if (!repos.has(JSON.stringify([null, repo]))) {
      this.watching.delete(repo);
      pending.cancel();
    }
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(AT_ONCE, keys.length) }, async () => {
          while (next < keys.length) await this.check(keys[next++], cx);
        }));
      }
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // Ref-only reads avoid scanning the worktree or waking its index watch.
      // Two reads: a folder name may itself contain a newline.
      const [r, common] = await both(
        exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on }),
        exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }),
      );
      if (r.code !== 0 || common.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.code !== 0 ? r.stderr : common.stderr)) {
          this.unsure.add(key);
          this.git[key] ??= null;
        } else this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = r.stdout.replace(/\n$/, ""), repo = common.stdout.replace(/\n$/, "");
      const [branch, counts] = await both(
        exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd, on }),
        exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd, on }),
      );
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
      const info = { name, branch: branch.code === 0 ? branch.stdout.trim().replace(/^refs\/heads\//, "") : "(detached)", ahead, behind, repo: JSON.stringify([on, repo]), linked: repo !== `${top}/.git` };
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    const pending = watchFolder(repo);
    this.watching.set(repo, pending);
    cx.spawn(async (cx) => {
      let current = pending;
      try {
        for (;;) {
          await current;
          if (this.watching.get(repo) !== current) return;
          const mine = JSON.stringify([null, repo]);
          const keys = Object.keys(this.git).filter((k) => this.git[k]?.repo === mine);
          if (!keys.length) break;
          this.refreshGit(keys, cx);
          current = watchFolder(repo);
          this.watching.set(repo, current);
        }
      } catch {}
      if (this.watching.get(repo) === current) this.watching.delete(repo);
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out.filter(r => this.shown.has(r.w.id));
  }

  toggleFold(id) {
    if (this.foldedSpaces.has(id)) this.foldedSpaces.delete(id);
    else this.foldedSpaces.add(id);
    localStorage.setItem("tim-spaces.foldedSpaces", JSON.stringify([...this.foldedSpaces]));
  }

  agentStatus(t, status) {
    if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900);
    if (status === "blocked") return div().size(13).flex_none().rounded(4).bg(t.blocked + "26").text_size(10).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (status === "idle") return div().size(7).mx(2).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(2).flex_none().rounded(4).bg(status === "done" ? (t[status] ?? t.dim) : t.dim + "00");
  }

  agentRow(a, t, deep = false) {
    const p = a.program;
    const pic = p?.icon ? (p.tint ? svg(p.icon).size(14).flex_none().text_color(t.foreground) : image(p.icon).w(14).h(14).flex_none()) : null;
    const tab = this.tabsById.get(a.tab);
    const name = (tab?.named ? tab.name : null) || clean(a.title) || p?.name || a.address;
    const idle = a.status === "idle" && !a.focused;
    return h_flex()
      .id(`sp-agent-${a.address}`)
      .pl(deep ? 46 : 30).pr(8).h(26).flex_none().gap(8).items_center().rounded(8).text_size(12.5)
      .when(a.focused, (el) => el.bg(t.selected))
      .when(!a.focused, (el) => el.hover((s) => s.bg(t.hover)))
      .cursor_pointer()
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .on_mouse_down("right", () => this.agentMenu(a))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_1().min_w(0).truncate().text_color(idle ? t.muted : t.foreground).child(name))
      .child(this.agentStatus(t, a.status));
  }

  // Space rows interleaved with their agents; returns the active space's flat offset for scroll.
  // A folded space hides its agents; a folded main also hides its worktrees and their agents.
  // Worktree agents indent deeper so they read as the worktree's children. Rail: no folding, no agents.
  drawSpaces(rows, draw, t) {
    const folding = !narrow();
    const items = [];
    let activeOffset = -1;
    for (const r of rows) {
      const parent = this.parentMain.get(r.w.id);
      if (folding && parent && this.foldedSpaces.has(parent)) continue;
      if (r.w.active) activeOffset = items.length;
      items.push(draw(r));
      if (!folding || this.foldedSpaces.has(r.w.id)) continue;
      for (const a of this.agentsBySpace.get(r.w.id) ?? []) items.push(this.agentRow(a, t, Boolean(r.tree)));
    }
    return { items, activeOffset };
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    // A worktree row's main space (for folding), and which mains have worktrees (for the chevron).
    this.parentMain = new Map();
    this.mainHasWorktree = new Set();
    let curMain = null;
    for (const r of rows) {
      if (r.tree) { this.parentMain.set(r.w.id, curMain); this.mainHasWorktree.add(curMain); }
      else curMain = r.w.id;
    }
    const draw = (r) => (collapsed ? this.compact(r, t) : this.row(r, t));
    // Where the active space's row lands among the children this returns: the list scrolls by its direct
    // children, and machine headers, login notes and loading rows count too.
    this.activeAt = -1;
    let before = 0;
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).items_center().when(collapsed, el => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) {
      if (loading(null) && !rows.length) return [loadingRow(null)];
      const { items, activeOffset } = this.drawSpaces(rows, draw, t);
      this.activeAt = activeOffset;
      return items;
    }
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const login = machine?.state === "needs_login" ? `hc machine login ${m}` : null;
      const folded = this.folded.has(m);
      const icon = svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none();
      const badge = div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.chrome).bg(connected ? t.ansi2 : t.dim);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .when(collapsed, el => el.mt(4).w(RAIL_CELL).justify_center().rounded(6).tooltip(login ? `${m} needs a login: run ${login}. Click for Copy.` : m ? `${m} · ${connected ? "connected" : (machine?.state ?? "asleep").replace(/_/g, " ")}` : "This computer"))
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (collapsed && login) { run("app.settings", { section: "machines" }); return; }
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .when(machine?.keeps_running_after_logout === false, el => el.child(div().id(`machine-logout-${m}`)
          .flex_none().text_color(t.blocked).tooltip("Agents stop when you disconnect. Click for the fix.")
          .on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "machine-add", kind: "dialog", width: 560 }); }).child("⚠")))
        .when(!collapsed, el => el.child(icon))
        .when(collapsed, el => el.child(div().relative().flex_none().child(icon).when(Boolean(m), el => el.child(badge))))
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt && !login, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .when(collapsed, el => el.w(RAIL_CELL).rounded(6).justify_center().tooltip(`New space on ${m ?? "this computer"}`)
          .child(h_flex().size(18).rounded(5).border_1().border_color(t.dim).items_center().justify_center()
            .child(svg("mods/workspace-chrome/plus.svg").size(10))))
        .when(!collapsed, el => el.child(svg("mods/workspace-chrome/plus.svg").size(12)).child("New space there"));
      if (!collapsed && rebuilt) { before += 1; return [head]; }
      const cell = collapsed ? railCell : (el) => el;
      const guidance = !collapsed && login ? [v_flex().px(8).pb(6).gap(3).flex_none()
        .child(div().text_size(11).text_color(t.blocked).child("needs a login: run"))
        .child(h_flex().gap(5).items_center()
          .child(div().flex_1().min_w(0).truncate().tooltip(login).text_size(11).text_color(t.muted).child(login))
          .child(div().id(`machine-login-copy-${m}`).flex_none().px(5).py(2).rounded(4)
            .text_size(11).text_color(t.foreground).bg(t.raised).cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(login); this.copiedLogin = login; cx.notify(); })
            .child(this.copiedLogin === login ? "Copied" : "Copy")))] : [];
      const spaceItems = folded ? null : mine.length ? this.drawSpaces(mine, draw, t) : null;
      const body = spaceItems ? spaceItems.items : (folded ? [] : [loading(m) ? loadingRow(m) : cell(empty)]);
      const items = [cell(head), ...guidance, ...body];
      if (spaceItems && spaceItems.activeOffset >= 0) this.activeAt = before + 1 + guidance.length + spaceItems.activeOffset;
      before += items.length;
      return items;
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one. When the row is full, it
  // and the name both start from their text's width and give way in proportion.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_auto()
      .min_w(where ? SIDE_MIN : 0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  row({ w, i, g, tree }, t) {
    const on = w.active;
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    const hasKids = (this.agentsBySpace?.get(w.id)?.length ?? 0) > 0 || (!tree && this.mainHasWorktree?.has(w.id));
    const folded = this.foldedSpaces.has(w.id);
    const chevron = div()
      .id(`fold-${w.id}`)
      .flex_none().p(2).rounded(4).text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { this.toggleFold(w.id); cx.notify(); })
      .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(12).flex_none());
    const assignBtn = div()
      .id(`assign-${w.id}`).flex_none().p(2).rounded(4).text_color(t.dim).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Add to task")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "tim-spaces", kind: "popup", width: 220, height: 280, props: { assign: w.id } }); })
      .child(svg("mods/workspace-chrome/folder-plus.svg").size(13));
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_hover((hovering, cx) => { const id = hovering ? w.id : (this.hoveredSpace === w.id ? null : this.hoveredSpace); if (id !== this.hoveredSpace) { this.hoveredSpace = id; cx.notify(); } })
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(t.dim)))
          .when(!tree, el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .child(div().flex_initial().min_w(SIDE_MIN).truncate().text_color(t.foreground).child(w.name))
          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1())
          .when(!tree && this.hoveredSpace === w.id, (el) => el.child(assignBtn))
          .when(hasKids, (el) => el.child(chevron)),
      );
  }

  compact({ w, i }, t) {
    return railCell(h_flex()
      .id(`space-${w.id}`)
      .relative()
      .w(RAIL_CELL)
      .h(26)
      .rounded(6)
      .justify_center()
      .items_center()
      .when(w.active, (el) => el.bg(t.selected))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().absolute().right(5).text_color(tone(t, w.status)).child(glyph(w.status))));
  }

  // ---- Tasks: a mod-only grouping layer over spaces (Herdr core has no such concept) ----
  tasks() {
    const s = shared("tim-spaces.tasks");
    return Array.isArray(s) ? s.map((task) => ({ ...task, spaces: [...(task.spaces ?? [])] })) : [];
  }
  saveTasks(list) { setShared("tim-spaces.tasks", list); }

  newTask(name = "New task") {
    const id = `task-${Date.now().toString(36)}`;
    this.saveTasks([...this.tasks(), { id, name, spaces: [] }]);
    return id;
  }
  createTask(cx) { this.startRename(this.newTask(), "New task", cx); }
  deleteTask(id) { this.saveTasks(this.tasks().filter((task) => task.id !== id)); }

  // A space lives in at most one task; passing taskId null just unassigns it.
  assignSpaceToTask(spaceId, taskId) {
    const list = this.tasks();
    for (const task of list) task.spaces = task.spaces.filter((id) => id !== spaceId);
    if (taskId) {
      const task = list.find((x) => x.id === taskId);
      if (task && !task.spaces.includes(spaceId)) task.spaces.push(spaceId);
    }
    this.saveTasks(list);
  }

  reorderTask(dragId, beforeId) {
    const list = this.tasks();
    const from = list.findIndex((task) => task.id === dragId);
    if (from < 0) return;
    const [moved] = list.splice(from, 1);
    const to = list.findIndex((task) => task.id === beforeId);
    list.splice(to < 0 ? list.length : to, 0, moved);
    this.saveTasks(list);
  }

  startRename(id, name, cx) {
    this.renaming = id;
    this.renameState.set_value(name);
    this.renameState.focus();
    cx?.notify();
  }
  commitRename(cx) {
    if (this.renaming == null) return;
    const text = (this.renameState.content()?.text ?? "").trim();
    const list = this.tasks();
    const task = list.find((x) => x.id === this.renaming);
    if (task && text && task.name !== text) { task.name = text; this.saveTasks(list); }
    this.renaming = null;
    if (shared("tim-spaces.renaming")) setShared("tim-spaces.renaming", null);
    cx?.notify();
  }

  // The "add to task" picker, opened from a space's hover button as a self overlay.
  assignPopup(t) {
    const spaceId = props().assign;
    const list = this.tasks();
    const current = list.find((x) => x.spaces.includes(spaceId));
    const item = (label, icon, act, on = false) => h_flex()
      .id(`assign-${label}`).h(31).px(8).gap(9).rounded(7).items_center().cursor_pointer()
      .text_color(t.foreground).hover((el) => el.bg(t.hover))
      .on_click((_e, cx) => { act(cx); closeOverlay(props().overlay); })
      .child(svg(`mods/workspace-chrome/${icon}.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().truncate().child(label))
      .when(on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)));
    return v_flex().w_full().p(5).bg(t.popover).text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Add to task"))
      .children(list.map((task) => item(task.name, "layers", () => this.assignSpaceToTask(spaceId, task.id), task.id === current?.id)))
      .child(item("New task…", "folder-plus", () => this.assignSpaceToTask(spaceId, this.newTask())))
      .when(Boolean(current), (el) => el.child(item("Remove from task", "x", () => this.assignSpaceToTask(spaceId, null))));
  }

  taskMenu(id) {
    openOverlay({ mod: "tim-spaces", kind: "popup", width: 180, height: 120, props: { taskMenu: id } });
  }
  taskMenuPopup(t) {
    const id = props().taskMenu;
    const item = (label, icon, act, danger = false) => h_flex()
      .id(`taskmenu-${label}`).h(31).px(8).gap(9).rounded(7).items_center().cursor_pointer()
      .text_color(danger ? t.blocked : t.foreground).hover((el) => el.bg(t.hover))
      .on_click((_e, cx) => { act(); closeOverlay(props().overlay); })
      .child(svg(`mods/workspace-chrome/${icon}.svg`).size(14).flex_none().text_color(danger ? t.blocked : t.muted))
      .child(div().flex_1().truncate().child(label));
    return v_flex().w_full().p(5).bg(t.popover).text_size(12.8)
      .child(item("Rename", "square-pen", () => setShared("tim-spaces.renaming", id)))
      .child(item("New space", "plus", () => { const before = spaces().map((s) => s.id); run("space.new"); setShared("tim-spaces.newInTask", { task: id, before, at: Date.now() }); }))
      .child(div().mx(7).my(4).h(1).bg(t.border))
      .child(item("Delete task", "x", () => this.deleteTask(id)));
  }

  // Right-click an agent: a 2-item menu. Rename acts on the tab (what the row's label shows); Close ends this agent's pane.
  agentMenu(a) {
    openOverlay({ mod: "tim-spaces", kind: "popup", width: 180, height: 92, props: { agentMenu: { tab: a.tab, pane: a.pane } } });
  }
  agentMenuPopup(t) {
    const { tab, pane } = props().agentMenu;
    const item = (label, icon, act, danger = false) => h_flex()
      .id(`agentmenu-${label}`).h(31).px(8).gap(9).rounded(7).items_center().cursor_pointer()
      .text_color(danger ? t.blocked : t.foreground).hover((el) => el.bg(t.hover))
      .on_click((_e, cx) => { closeOverlay(props().overlay); act(); })
      .child(svg(`mods/workspace-chrome/${icon}.svg`).size(14).flex_none().text_color(danger ? t.blocked : t.muted))
      .child(div().flex_1().truncate().child(label));
    return v_flex().w_full().p(5).bg(t.popover).text_size(12.8)
      .child(item("Rename", "square-pen", () => run("tab.rename", { id: tab })))
      .child(div().mx(7).my(4).h(1).bg(t.border))
      .child(item("Close", "x", () => run("pane.close", { pane })));
  }

  // A task's header: fold chevron, name (click to rename), count, delete; drag to reorder, drop a space to add it.
  taskHeader(task, t) {
    const folded = this.foldedSpaces.has(task.id);
    const renaming = this.renaming === task.id;
    const dropHere = this.pressed !== null && this.spaceDropTask === task.id;
    const reorderHere = this.taskDrag !== null && this.taskDrag !== task.id && this.taskOver === task.id;
    const chevron = div()
      .id(`taskfold-${task.id}`).flex_none().p(2).rounded(4).text_color(t.dim).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { this.toggleFold(task.id); cx.notify(); })
      .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(12).flex_none());
    const del = div()
      .id(`taskdel-${task.id}`).flex_none().p(2).rounded(4).text_color(t.dim).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.blocked)).tooltip("Delete task (its spaces move to Ungrouped)")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { this.deleteTask(task.id); cx.notify(); })
      .child(svg("mods/workspace-chrome/x.svg").size(12));
    const label = renaming
      ? h_flex().flex_1().min_w(0).child(Input.new(this.renameState))
      : div().flex_1().min_w(0).truncate().text_color(t.foreground).child(task.name);
    return h_flex()
      .id(`task-${task.id}`).relative()
      .px(8).h(30).mt(6).flex_none().gap(6).items_center().rounded(8)
      .text_size(11).font_medium()
      .when(this.taskDrag === task.id, (el) => el.opacity(0.5))
      .when(dropHere, (el) => el.bg(t.accent + "22").border_1().border_color(t.accent))
      .when(!dropHere, (el) => el.hover((s) => s.bg(t.hover)))
      .when(reorderHere, (el) => el.child(div().absolute().left(0).right(0).top(0).h(2).bg(t.accent)))
      .on_mouse_down("left", () => { if (!renaming) { this.taskDrag = task.id; this.taskOver = task.id; } })
      .on_mouse_move((_e, cx) => {
        if (this.taskDrag !== null) { if (this.taskOver !== task.id) { this.taskOver = task.id; cx.notify(); } }
        else if (this.pressed !== null) { if (this.spaceDropTask !== task.id) { this.spaceDropTask = task.id; cx.notify(); } }
      })
      .on_mouse_up("left", (_e, cx) => {
        const dragId = this.taskDrag, droppingSpace = this.pressed;
        if (dragId !== null) {
          if (this.taskOver !== null && this.taskOver !== dragId) this.reorderTask(dragId, this.taskOver);
        } else if (droppingSpace !== null) this.assignSpaceToTask(droppingSpace, task.id);
        this.taskDrag = this.taskOver = this.spaceDropTask = this.pressed = this.over = null;
        cx.notify();
      })
      .on_mouse_down("right", () => this.taskMenu(task.id))
      .child(chevron)
      .child(label)
      .when(!renaming, (el) => el.child(h_flex().flex_none().min_w(20).px(6).h(18).rounded(9).bg(t.raised).items_center().justify_center()
        .text_size(10.5).font_medium().text_color(t.dim).tooltip(`${task.spaces.length} space${task.spaces.length === 1 ? "" : "s"}`)
        .child(String(task.spaces.length))))
      .when(!renaming, (el) => el.child(del));
  }

  ungroupedHeader(t) {
    const folded = this.foldedSpaces.has("__ungrouped__");
    const dropHere = this.pressed !== null && this.spaceDropTask === "__ungrouped__";
    return h_flex()
      .id("task-ungrouped").relative()
      .px(8).h(28).mt(6).flex_none().gap(6).items_center().rounded(8)
      .text_size(11).font_medium().text_color(t.dim)
      .when(dropHere, (el) => el.bg(t.accent + "22").border_1().border_color(t.accent))
      .on_mouse_move((_e, cx) => { if (this.pressed !== null && this.spaceDropTask !== "__ungrouped__") { this.spaceDropTask = "__ungrouped__"; cx.notify(); } })
      .on_mouse_up("left", (_e, cx) => { if (this.pressed !== null) this.assignSpaceToTask(this.pressed, null); this.taskDrag = this.taskOver = this.spaceDropTask = this.pressed = this.over = null; cx.notify(); })
      .child(div().id("ungrouped-fold").flex_none().p(2).rounded(4).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.toggleFold("__ungrouped__"); cx.notify(); })
        .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(12).flex_none()))
      .child(div().flex_1().child("Ungrouped"));
  }

  // Spaces grouped under tasks (wide only). Worktrees ride with their main space; a task holds main spaces.
  taskList(t) {
    const rows = this.ordered();
    this.parentMain = new Map();
    this.mainHasWorktree = new Set();
    const blocks = new Map();
    const mainOrder = [];
    let cur = null;
    for (const r of rows) {
      if (r.tree) { this.parentMain.set(r.w.id, cur); this.mainHasWorktree.add(cur); blocks.get(cur)?.push(r); }
      else { cur = r.w.id; blocks.set(cur, [r]); mainOrder.push(cur); }
    }
    const draw = (r) => this.row(r, t);
    const out = [];
    let activeOffset = -1;
    const pushBlocks = (ids) => {
      const memberRows = [];
      for (const id of ids) if (blocks.has(id)) memberRows.push(...blocks.get(id));
      const res = this.drawSpaces(memberRows, draw, t);
      if (res.activeOffset >= 0) activeOffset = out.length + res.activeOffset;
      out.push(...res.items);
    };
    const tasks = this.tasks();
    if (!tasks.length) { pushBlocks(mainOrder); this.activeAt = activeOffset; return out; }
    const assigned = new Set(tasks.flatMap((task) => task.spaces));
    for (const task of tasks) {
      out.push(this.taskHeader(task, t));
      if (!this.foldedSpaces.has(task.id)) pushBlocks(task.spaces);
    }
    const ungrouped = mainOrder.filter((id) => !assigned.has(id));
    if (ungrouped.length) {
      out.push(this.ungroupedHeader(t));
      if (!this.foldedSpaces.has("__ungrouped__")) pushBlocks(ungrouped);
    }
    this.activeAt = activeOffset;
    return out;
  }

  render() {
    const t = theme();
    if (props()?.assign != null) return this.assignPopup(t);
    if (props()?.taskMenu != null) return this.taskMenuPopup(t);
    if (props()?.agentMenu != null) return this.agentMenuPopup(t);
    const collapsed = narrow();
    // The right-click menu lives in its own overlay; it asks for a rename through shared state, picked up here.
    const wantRename = shared("tim-spaces.renaming");
    if (wantRename && this.renaming !== wantRename) {
      const task = this.tasks().find((x) => x.id === wantRename);
      if (task) this.startRename(task.id, task.name);
      else setShared("tim-spaces.renaming", null);
    }
    // A task-menu "New space" ran space.new; assign the newly-appeared space to that task.
    // shortcut: takes the first space absent when the menu ran; gives up after 5s if none appears.
    const newInTask = shared("tim-spaces.newInTask");
    if (newInTask) {
      const created = spaces().find((s) => !newInTask.before.includes(s.id));
      if (created) { this.assignSpaceToTask(created.id, newInTask.task); setShared("tim-spaces.newInTask", null); }
      else if (Date.now() - newInTask.at > 5000) setShared("tim-spaces.newInTask", null);
    }
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    this.agentsBySpace = new Map();
    for (const a of agents()) {
      if (!this.agentsBySpace.has(a.space)) this.agentsBySpace.set(a.space, []);
      this.agentsBySpace.get(a.space).push(a);
    }
    this.tabsById = new Map(sp.flatMap((s) => s.tabs ?? []).map((tab) => [tab.id, tab]));
    const list = collapsed ? this.grouped(t, true) : this.taskList(t);
    // Bring the active space into view when it, or its place in the list, changes; a row already in view stays put.
    const active = sp.find(p => p.active)?.id;
    if (active !== this.revealed || this.activeAt !== this.revealedAt) {
      this.revealed = active;
      this.revealedAt = this.activeAt;
      if (this.activeAt >= 0) this.scroll.scroll_to_item(this.activeAt);
    }
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(collapsed, el => el.pl(0).pr(0).justify_center())
        .when(!collapsed, el => el.child("Spaces"))
        .child(h_flex().flex_none().gap(2).items_center()
          .when(!collapsed, (el) => el.child(div().id("task-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("New task")
            .on_click((_e, cx) => this.createTask(cx)).child(svg("mods/workspace-chrome/folder-plus.svg").size(14))))
          .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14)))))
      .child(v_flex().flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).overflow_y_scrollbar().mode("always").track_scroll(this.scroll)
        // A block above (another mod's) growing, or the window resizing, shrinks this list and can push the active space out.
        .on_size_change((_size, cx) => { if (this.activeAt >= 0) { this.scroll.scroll_to_item(this.activeAt); cx.notify(); } })
        .on_mouse_up("left", (_e, cx) => { this.pressed = this.taskDrag = this.taskOver = this.spaceDropTask = null; cx.notify(); })
        .children(list));
  }
}
