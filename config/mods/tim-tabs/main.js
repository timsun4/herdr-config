import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, ScrollHandle, InputState, Input } from "gpui-base";
import { spaces, panes, run, openOverlay, closeOverlay, props, exec, theme, window, shared, setShared, layout, settings } from "herdr";

// A git remote (ssh or https) -> its https web URL. Works for github.com and enterprise hosts.
function toGithubUrl(remote) {
  if (!remote) return null;
  const s = remote.trim().replace(/\.git$/, "");
  let m = s.match(/^git@([^:]+):(.+)$/);             // git@host:owner/repo
  if (m) return `https://${m[1]}/${m[2]}`;
  m = s.match(/^ssh:\/\/(?:[^@]+@)?([^/]+)\/(.+)$/); // ssh://git@host/owner/repo
  if (m) return `https://${m[1]}/${m[2]}`;
  m = s.match(/^https?:\/\/(?:[^@]+@)?(.+)$/);        // https://[creds@]host/owner/repo
  if (m) return `https://${m[1]}`;
  return null;
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Same as the agents mod: drops a status glyph, keeps a leading bracket or quote.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

// A tab Herdr named (unnamed, or after its program) follows its agent's live
// title, as the agents list does; a name the person gave stays.
function label(tab, lead) {
  const prog = lead?.program?.name;
  const base = tab.named ? tab.name : prog ?? "Terminal";
  if (!lead?.program?.agent) return base;
  const live = clean(lead.title);
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((lead.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== lead.terminal && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== lead.program.key;
  return (tab.name === prog || !tab.named) && telling ? live : base;
}

export default class Tabs extends View {
  init() {
    if (props()?.jiraFor != null) { // the Jira-link prompt is a bare overlay instance
      this.jiraInput = InputState.new({ placeholder: "https://…/browse/ABC-123", value: props().value ?? "" });
      this.jiraInput.on("submit", (_e, cx) => this.saveJira(cx));
      return;
    }
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    try { this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}"); } catch { this.panels = {}; }
    if (!this.panels || typeof this.panels !== "object" || Array.isArray(this.panels)) this.panels = {};
    this.swipe = { acc: 0, steps: 0, at: 0, last: 0 };
  }

  // One tab per wheel notch. A touchpad or smooth-scrolling mouse sends many
  // small events per gesture: a short swipe or one smoothed notch (about
  // 25 px) switches one tab, a longer swipe keeps going a tab per 60 px, at
  // most one every 100 ms so each shows.
  wheel(e) {
    if (e.delta_lines) {
      if (e.delta_lines.y) run(e.delta_lines.y > 0 ? "tab.prev" : "tab.next");
      return;
    }
    const s = this.swipe, now = Date.now();
    // Phases often arrive only as moves (a macOS touchpad included): a pause
    // or a turn starts a new gesture.
    if (e.touch_phase === "started" || now - s.at > 250 || e.delta.y * s.acc < 0) Object.assign(s, { acc: 0, steps: 0 });
    s.at = now;
    s.acc += e.delta.y;
    const need = s.steps ? 60 : 20;
    if (Math.abs(s.acc) < need || now - s.last < 100) return;
    s.acc -= Math.sign(s.acc) * need;
    s.steps++;
    s.last = now;
    run(e.delta.y > 0 ? "tab.prev" : "tab.next");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  // ---- GitHub / Jira links in the top bar ----
  spaceCwd(space) {
    const tabs = new Set((space.tabs ?? []).map((c) => c.id));
    return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space.folder;
  }
  // The Task the given space belongs to (tasks live in the tim-spaces mod's shared state).
  taskOf(spaceId) {
    const list = shared("tim-spaces.tasks");
    return Array.isArray(list) ? list.find((x) => (x.spaces ?? []).includes(spaceId)) : null;
  }
  openGithub(space, cx) {
    const cwd = this.spaceCwd(space);
    if (!cwd) return;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", ["remote", "get-url", "origin"], { cwd, on: space.machine ?? null });
        const url = r.code === 0 ? toGithubUrl(r.stdout.trim()) : null;
        if (url) cx.open_url(url);
      } catch {}
    });
  }
  openJiraPrompt(taskId, value, open) {
    openOverlay({ mod: "tim-tabs", kind: "popup", width: 340, height: 150, props: { jiraFor: taskId, value, open } });
  }
  saveJira(cx) {
    const taskId = props().jiraFor;
    const text = (this.jiraInput.content()?.text ?? "").trim();
    const raw = shared("tim-spaces.tasks");
    const list = (Array.isArray(raw) ? raw : []).map((x) => ({ ...x, spaces: [...(x.spaces ?? [])] }));
    const task = list.find((x) => x.id === taskId);
    if (task) { task.jira = text || null; setShared("tim-spaces.tasks", list); }
    if (props().open && /^https?:\/\//i.test(text)) cx.open_url(text);
    closeOverlay(props().overlay);
  }
  jiraPrompt(t) {
    return v_flex().w_full().p(12).gap(8).bg(t.popover).text_size(12.8)
      .child(div().text_size(11).text_color(t.dim).child("Jira card URL for this task"))
      .child(h_flex().w_full().min_w(0).child(Input.new(this.jiraInput)))
      .child(h_flex().gap(6).justify_end()
        .child(div().id("jira-cancel").px(10).h(28).rounded(6).flex().items_center().text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => closeOverlay(props().overlay)).child("Cancel"))
        .child(div().id("jira-save").px(10).h(28).rounded(6).flex().items_center().bg(t.accent).text_color("#ffffff").cursor_pointer().hover((s) => s.opacity(0.9))
          .on_click((_e, cx) => this.saveJira(cx)).child("Save")));
  }

  render() {
    const t = theme();
    if (props()?.jiraFor != null) return this.jiraPrompt(t);
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const lead = panes().find(p => p.tab === c.id && p.program?.agent) ?? panes().find(p => p.tab === c.id);
      const program = lead?.program;
      const name = label(c, lead);
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    const task = space ? this.taskOf(space.id) : null;
    const actionBtn = (id, icon, text, enabled, tip, onClick, onRight) => h_flex().id(id).h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12)
      .bg(t.chrome).text_color(enabled ? t.muted : t.dim).tooltip(tip)
      .when(enabled, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop).on_click(onClick)
        .when(Boolean(onRight), (e2) => e2.on_mouse_down("right", onRight)))
      .child(svg(icon).size(14)).child(text);
    const ghBtn = actionBtn("open-github", "mods/workspace-chrome/git-branch.svg", "GitHub", true,
      "Open the repository on GitHub", (_e, cx) => this.openGithub(space, cx));
    const jiraBtn = actionBtn("open-jira", "mods/workspace-chrome/file-text.svg", "Jira", Boolean(task),
      task ? (task.jira ? `Open ${task.jira}` : "Set a Jira card (right-click to edit)") : "Add this space to a task to link its Jira card",
      (_e, cx) => { if (task?.jira) cx.open_url(task.jira); else if (task) this.openJiraPrompt(task.id, "", true); },
      (_e, cx) => { cx.stop_propagation(); if (task) this.openJiraPrompt(task.id, task.jira ?? "", false); });
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => this.wheel(e))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(Boolean(space), el => el.child(ghBtn).child(jiraBtn))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tim-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tim-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tim-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
