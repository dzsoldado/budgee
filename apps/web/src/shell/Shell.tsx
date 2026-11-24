// The app frame: a bottom tab bar on phones, a sidebar from 1024px (see shell.css).
import { type RouteSectionProps, useHref, useLocation } from "@solidjs/router";
import { type JSX, Show } from "solid-js";
import { useApp } from "../context";
import { t } from "../i18n";
import { useSyncView } from "../sync/SyncPill";
import { announcement, dotClass } from "../sync/status";
import { DashboardIcon, ListIcon, PlusIcon, SettingsIcon } from "./icons";
import { UpdatePrompt } from "./UpdatePrompt";

type Section = "list" | "add" | "dashboard" | "settings";

/** Which section a path belongs to; query strings (e.g. `?drive=ok`) don't matter. */
function sectionOf(pathname: string): Section | undefined {
  if (pathname === "/" || pathname === "") return "list";
  if (pathname === "/add" || pathname.startsWith("/edit/")) return "add";
  if (pathname.startsWith("/dashboard")) return "dashboard";
  if (pathname.startsWith("/settings") || pathname === "/pair") return "settings";
  return undefined;
}

/** Full-screen forms with their own Close and Save: Add / edit, Add chart, the chart editor. */
const isFormScreen = (pathname: string) =>
  sectionOf(pathname) === "add" || pathname.startsWith("/dashboard/");

/** A router link marked `aria-current="page"` while its section is open. */
function NavLink(props: { href: string; section: Section; class: string; children: JSX.Element }) {
  const location = useLocation();
  const href = useHref(() => props.href);
  return (
    <a
      href={href()}
      class={props.class}
      aria-current={sectionOf(location.pathname) === props.section ? "page" : undefined}
    >
      {props.children}
    </a>
  );
}

/** The live CSV file needs the user (access to allow again, or writes failing). */
function useFileAttention() {
  const { liveFile } = useApp();
  return () => {
    const kind = liveFile?.state().kind;
    return kind === "paused" || kind === "failed";
  };
}

/** A small dot on the Settings item, said to screen readers, while the live file needs the user. */
function AttentionDot(props: { show: boolean }) {
  return (
    <Show when={props.show}>
      <span class="status-dot status-dot-error nav-attention" aria-hidden="true" />
      <span class="visually-hidden">{t("liveFile.attention")}</span>
    </Show>
  );
}

/** Settings, or its Your data section while the live file needs the user. */
const settingsHref = (attention: boolean) => (attention ? "/settings?section=data" : "/settings");

function TabBar() {
  const attention = useFileAttention();
  return (
    <nav class="tab-bar" aria-label={t("nav.main")}>
      <NavLink href="/" section="list" class="tab">
        <ListIcon size={22} />
        {t("nav.list")}
      </NavLink>
      <NavLink href="/add" section="add" class="tab">
        <span class="tab-add-pill">
          <PlusIcon size={18} />
        </span>
        {t("nav.add")}
      </NavLink>
      <NavLink href="/dashboard" section="dashboard" class="tab">
        <DashboardIcon size={22} />
        {t("nav.dashboard")}
      </NavLink>
      <NavLink href={settingsHref(attention())} section="settings" class="tab">
        <SettingsIcon size={22} />
        {t("nav.settings")}
        <AttentionDot show={attention()} />
      </NavLink>
    </nav>
  );
}

/**
 * Sync status card (Desktop.dc.html): status line, a note when there is one, and "Sync now"; while
 * not paired or after this device was removed, a link to Settings, where pairing starts.
 */
function SidebarStatus() {
  const { view, syncNow } = useSyncView();
  const settings = useHref(() => "/settings");
  return (
    <div class="sidebar-status">
      <span class="sidebar-status-line">
        <span class={dotClass(view())} />
        {view().label}
      </span>
      <Show when={view().note}>{(note) => <span class="sidebar-status-note">{note()}</span>}</Show>
      <Show
        when={view().canSync}
        fallback={
          <a href={settings()} class="sidebar-sync sidebar-open-settings">
            {t("sync.openSettings")}
          </a>
        }
      >
        <button
          type="button"
          class="sidebar-sync"
          aria-label={view().action}
          aria-busy={view().syncing}
          aria-disabled={view().syncing}
          onClick={syncNow}
        >
          {t("settings.syncNow")}
        </button>
      </Show>
    </div>
  );
}

function Sidebar() {
  const attention = useFileAttention();
  return (
    <aside class="sidebar">
      <div class="sidebar-brand">
        <span class="sidebar-logo" aria-hidden="true">
          {Array.from(t("app.name"))[0]}
        </span>
        <span class="sidebar-name">{t("app.name")}</span>
      </div>
      <NavLink href="/add" section="add" class="sidebar-new">
        <PlusIcon size={16} />
        {t("nav.newEntry")}
      </NavLink>
      <nav class="sidebar-nav" aria-label={t("nav.main")}>
        <NavLink href="/" section="list" class="sidebar-link">
          <ListIcon size={18} />
          {t("nav.list")}
        </NavLink>
        <NavLink href="/dashboard" section="dashboard" class="sidebar-link">
          <DashboardIcon size={18} />
          {t("nav.dashboard")}
        </NavLink>
        <NavLink href={settingsHref(attention())} section="settings" class="sidebar-link">
          <SettingsIcon size={18} />
          {t("nav.settings")}
          <AttentionDot show={attention()} />
        </NavLink>
      </nav>
      <SidebarStatus />
    </aside>
  );
}

/**
 * DOM (and Tab) order: skip link, sidebar (wide screens), content, tab bar (phones), so the
 * tab bar stays last. The skip link focuses the content without touching the hash route.
 * Add / edit, Add chart and the chart editor are full-screen forms on phones, with their own
 * Close and Save, so the tab bar steps aside there (as in Add.dc.html and AddChart.dc.html).
 */
export function Shell(props: RouteSectionProps) {
  const location = useLocation();
  let main!: HTMLElement;
  const skipToContent = (event: MouseEvent) => {
    event.preventDefault(); // the router ignores prevented clicks, so `#main` never routes
    main.focus();
  };
  return (
    <div class="app" classList={{ "app-form": isFormScreen(location.pathname) }}>
      <a class="skip-link" href="#main" on:click={skipToContent}>
        {t("nav.skipToContent")}
      </a>
      <Sidebar />
      <main id="main" class="app-main" tabindex="-1" ref={main}>
        {props.children}
      </main>
      <TabBar />
      <UpdatePrompt />
      {/* The one place sync changes are announced (see sync/status.ts). */}
      <div class="visually-hidden" role="status">
        {announcement()}
      </div>
    </div>
  );
}
