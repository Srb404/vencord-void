/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType } from "@utils/types";
import { FluxStore, Guild, Message, RenderModalProps } from "@vencord/discord-types";
import { findStoreLazy } from "@webpack";
import { ChannelStore, closeModal, GuildReadStateStore, GuildStore, IconUtils, Menu, Modal, NavigationRouter, openModal, React, SelectedGuildStore, SortedGuildStore, TextInput, Tooltip, UserGuildSettingsStore, UserStore, useStateFromStores } from "@webpack/common";

const VISITS_KEY = "Void_visits";
const KEPT_KEY = "Void_kept";
/** this device's own copy of the visits, which a cloud pull can't overwrite */
const LOCAL_VISITS_KEY = "Void_localVisits";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const GuildAvailabilityStore = findStoreLazy("GuildAvailabilityStore") as FluxStore & {
    isUnavailable(guildId: string): boolean;
};

const MODIFIERS = ["ctrl", "control", "shift", "alt", "meta", "cmd"];

function parseShortcut(shortcut: string) {
    const parts = shortcut.toLowerCase().split("+").map(p => p.trim()).filter(Boolean);
    const keys = parts.filter(p => !MODIFIERS.includes(p));
    if (keys.length !== 1) return null;
    return {
        key: keys[0],
        ctrl: parts.some(p => p === "ctrl" || p === "control"),
        shift: parts.includes("shift"),
        alt: parts.includes("alt"),
        meta: parts.some(p => p === "meta" || p === "cmd")
    };
}

const settings = definePluginSettings({
    days: {
        type: OptionType.NUMBER,
        description: "Servers you haven't opened for this many days go to the Void",
        default: 14,
        onChange: () => recompute()
    },
    shortcut: {
        type: OptionType.STRING,
        description: "Shortcut that opens the list of servers in the Void (e.g. ctrl+shift+o)",
        default: "ctrl+shift+o",
        isValid: (v: string) => parseShortcut(v) != null || "Use one key with modifiers (ctrl, shift, alt, meta) joined by +, e.g. ctrl+shift+o"
    },
    alwaysShow: {
        type: OptionType.BOOLEAN,
        description: "Always show the Void, not only when someone pings you there",
        default: false
    },
    showOnUnread: {
        type: OptionType.BOOLEAN,
        description: "Also show the Void when an unmuted server in it has unread messages",
        default: false
    },
    // state lives in settings so Vencord Cloud syncs it between devices
    /**
     * guildId -> last time you opened it; negative means it was sent to the Void at that (absolute) time.
     * Either way the bigger absolute value is the newer event, which is what merging devices relies on.
     */
    visits: {
        type: OptionType.CUSTOM,
        default: {} as Record<string, number>
    },
    /** servers that never go to the Void */
    kept: {
        type: OptionType.CUSTOM,
        default: [] as string[]
    }
});

// always read settings.plain fresh: a cloud pull replaces the object
const visitsOf = (): Record<string, number> => settings.plain.visits ?? {};
const keptOf = (): string[] => settings.plain.kept ?? [];
const lastVisit = (v: number | undefined) => v != null && v > 0 ? v : 0;

function setVisits(visits: Record<string, number>) {
    settings.store.visits = visits;
    DataStore.set(LOCAL_VISITS_KEY, visits);
}
const writeVisits = (patch: Record<string, number>) => setVisits({ ...visitsOf(), ...patch });

let voided = new Set<string>();
let expanded = false;
/** a server opened from the quick list without taking it out of the Void */
let peeking: string | null = null;
let lastGuildId: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

/** old DataStore state has been migrated; before that, nothing may be seeded */
let loaded = false;

function recompute() {
    if (!loaded) return;
    const now = Date.now();
    const limit = Math.max(1, settings.store.days) * DAY;
    const next = new Set<string>();
    const visits = visitsOf();
    const kept = new Set(keptOf());
    const seed: Record<string, number> = {};

    for (const id of Object.keys(GuildStore.getGuilds())) {
        // a server we haven't seen yet (fresh install, newly joined) gets the full grace period
        const last = lastVisit(visits[id] ?? (seed[id] = now));
        if (!kept.has(id) && now - last > limit) next.add(id);
    }
    if (Object.keys(seed).length) writeVisits(seed);

    if (next.size !== voided.size || [...next].some(id => !voided.has(id))) {
        voided = next;
        if (!voided.size) expanded = false;
        emit();
    }
}

function visit(guildId: string) {
    if (guildId === peeking) peeking = null;
    const now = Date.now();
    // the limit is in days, so there's no need to write (and sync) settings on every click
    if (now - lastVisit(visitsOf()[guildId]) > HOUR) writeVisits({ [guildId]: now });
    recompute();
}

/** you left the server (or it was deleted), so there's nothing to remember about it */
function forget(guildId: string) {
    if (guildId in visitsOf()) {
        const { [guildId]: _, ...rest } = visitsOf();
        setVisits(rest);
    }
    if (keptOf().includes(guildId)) settings.store.kept = keptOf().filter(id => id !== guildId);
}

function setExpanded(value: boolean) {
    if (expanded === value) return;
    expanded = value;
    emit();
}

const useVoid = () => React.useSyncExternalStore(subscribe, () => voided);
const useExpanded = () => React.useSyncExternalStore(subscribe, () => expanded);

/** Takes the guilds tree and returns its roots without the voided servers (also inside folders). */
function useRoots(tree: any) {
    const voidSet = useVoid();
    const roots = tree.getRoots();
    // Discord reorders the roots array in place, but bumps the tree version when it does
    return React.useMemo(() => {
        if (!voidSet.size) return roots;
        const out: any[] = [];
        for (const node of roots) {
            if (node.type === "guild") {
                if (!voidSet.has(node.id)) out.push(node);
            } else if (node.type === "folder") {
                const children = node.children.filter((c: any) => !voidSet.has(c.id));
                if (children.length === node.children.length) out.push(node);
                else if (children.length) out.push({ ...node, children });
            } else out.push(node);
        }
        return out;
    }, [roots, tree.version, voidSet]);
}

/** Server ids for Discord's keyboard navigation, without the voided ones (but with the one you're peeking at). */
function visibleGuildIds(ids: string[], keepSelected = false) {
    if (!voided.size) return ids;
    const selected = keepSelected ? SelectedGuildStore.getGuildId() : null;
    return ids.filter(id => !voided.has(id) || id === selected);
}

function VoidIcon() {
    return (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" />
            <path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" />
            <path d="M12 20.5A8.5 8.5 0 0 1 3.5 12" />
            <path d="M16.5 7.6a5.8 5.8 0 0 1 1.3 5.6" opacity=".6" />
            <path d="M7.5 16.4a5.8 5.8 0 0 1-1.3-5.6" opacity=".6" />
        </svg>
    );
}

const isUnread = (guildId: string) => GuildReadStateStore.hasUnread(guildId) && !UserGuildSettingsStore.isMuted(guildId);

const VoidItem = ErrorBoundary.wrap(({ renderTreeNode }: { renderTreeNode: (node: any) => React.ReactNode; }) => {
    const voidSet = useVoid();
    const isExpanded = useExpanded();
    const { alwaysShow, showOnUnread } = settings.use(["alwaysShow", "showOnUnread"]);
    const mentions = useStateFromStores(
        [GuildReadStateStore],
        () => [...voidSet].reduce((sum, id) => sum + GuildReadStateStore.getMentionCount(id), 0),
        [voidSet]
    );
    const unread = useStateFromStores(
        [GuildReadStateStore, UserGuildSettingsStore],
        () => showOnUnread && [...voidSet].some(isUnread),
        [voidSet, showOnUnread]
    );

    if (!alwaysShow && (!voidSet.size || !(isExpanded || mentions || unread))) return null;

    const tree = SortedGuildStore.getGuildsTree();
    const nodes = SortedGuildStore.getFlattenedGuildIds()
        .filter(id => voidSet.has(id))
        .map(id => tree.getNode(id))
        .filter(Boolean);

    const label = `Void (${voidSet.size} ${voidSet.size === 1 ? "server" : "servers"})`;

    return (
        <div className={`vc-void${isExpanded ? " vc-void-expanded" : ""}`}>
            <div className="vc-void-item">
                {unread && !isExpanded && <div className="vc-void-pill" />}
                <Tooltip text={label} position="right">
                    {props => (
                        <div
                            {...props}
                            className="vc-void-icon"
                            role="treeitem"
                            aria-label={label}
                            aria-expanded={isExpanded}
                            onClick={() => setExpanded(!expanded)}
                        >
                            <VoidIcon />
                        </div>
                    )}
                </Tooltip>
                {mentions > 0 && <div className="vc-void-badge">{mentions}</div>}
            </div>
            {isExpanded && nodes.map(node => renderTreeNode(node))}
        </div>
    );
}, { noop: true });

function setKept(guildId: string, keep: boolean) {
    const rest = keptOf().filter(id => id !== guildId);
    settings.store.kept = keep ? [...rest, guildId] : rest;
    recompute();
}

function sendToVoid(guildIds: string[]) {
    const now = Date.now();
    settings.store.kept = keptOf().filter(id => !guildIds.includes(id));
    writeVisits(Object.fromEntries(guildIds.map(id => [id, -now])));
    recompute();
}

/** older versions kept the state in DataStore, which doesn't sync */
async function migrateDataStore() {
    const oldVisits: Record<string, number> | undefined = await DataStore.get(VISITS_KEY);
    const oldKept: string[] | undefined = await DataStore.get(KEPT_KEY);
    if (oldVisits) {
        const visits = { ...visitsOf() };
        for (const [id, t] of Object.entries(oldVisits)) visits[id] = Math.max(visits[id] ?? 0, t);
        settings.store.visits = visits;
        await DataStore.del(VISITS_KEY);
    }
    if (oldKept) {
        settings.store.kept = [...new Set([...keptOf(), ...oldKept])];
        await DataStore.del(KEPT_KEY);
    }
}

/**
 * Cloud sync replaces the whole settings file, so visits from another device can overwrite ours.
 * Bring back what this device knows, keeping the newer event for every server.
 */
async function mergeLocalVisits() {
    const local: Record<string, number> = await DataStore.get(LOCAL_VISITS_KEY) ?? {};
    const visits = { ...visitsOf() };
    let changed = false;
    for (const [id, t] of Object.entries(local)) {
        if (Math.abs(t) > Math.abs(visits[id] ?? 0)) {
            visits[id] = t;
            changed = true;
        }
    }
    if (changed) settings.store.visits = visits;
    await DataStore.set(LOCAL_VISITS_KEY, visits);
}

const daysAgo = (time: number) => {
    const days = Math.floor((Date.now() - time) / DAY);
    return days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
};

function describeVisit(guildId: string) {
    const v = visitsOf()[guildId];
    if (v == null || v === 0) return "Never opened";
    return v > 0 ? `Opened ${daysAgo(v)}` : `Sent to the Void ${daysAgo(-v)}`;
}

interface GuildContextProps {
    guild?: Guild;
    folderId?: number;
}

// Discord uses the same menu id for servers and for folders
const guildContext: NavContextMenuPatchCallback = (children, { guild, folderId }: GuildContextProps) => {
    if (folderId != null && !guild) {
        const guildIds: string[] = SortedGuildStore.getGuildFolderById(folderId)?.guildIds ?? [];
        if (!guildIds.length) return;
        children.push(
            <Menu.MenuGroup>
                <Menu.MenuItem id="vc-void-folder" label="Send folder to Void" action={() => sendToVoid(guildIds)} />
            </Menu.MenuGroup>
        );
        return;
    }

    if (!guild) return;
    const { id } = guild;
    const kept = keptOf().includes(id);
    let subtext: string | undefined;
    if (!kept && !voided.has(id)) {
        const left = Math.ceil((lastVisit(visitsOf()[id]) + Math.max(1, settings.store.days) * DAY - Date.now()) / DAY);
        subtext = left <= 1 ? "Goes there by itself within a day" : `Goes there by itself in ${left} days`;
    }
    children.push(
        <Menu.MenuGroup>
            {voided.has(id)
                ? <Menu.MenuItem id="vc-void-out" label="Take out of Void" action={() => visit(id)} />
                : <Menu.MenuItem id="vc-void-in" label="Send to Void" subtext={subtext} action={() => sendToVoid([id])} />}
            <Menu.MenuCheckboxItem
                id="vc-void-keep"
                label="Never send to Void"
                checked={kept}
                action={() => setKept(id, !kept)}
            />
        </Menu.MenuGroup>
    );
};

const acronym = (name: string) => name.split(/\s+/).map(w => w[0]).join("").slice(0, 3);

function VoidModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const voidSet = useVoid();
    const [query, setQuery] = React.useState("");
    const [active, setActive] = React.useState(0);

    const guilds = useStateFromStores([GuildReadStateStore, GuildStore, UserGuildSettingsStore], () => {
        const q = query.trim().toLowerCase();
        return SortedGuildStore.getFlattenedGuildIds()
            .filter(id => voidSet.has(id))
            .map(id => GuildStore.getGuild(id))
            .filter(g => g && (!q || g.name.toLowerCase().includes(q)))
            .map(g => ({ guild: g, mentions: GuildReadStateStore.getMentionCount(g.id), unread: isUnread(g.id) }))
            // pinged servers first, then unread ones
            .sort((a, b) => Number(b.mentions > 0) - Number(a.mentions > 0) || Number(b.unread) - Number(a.unread));
    }, [voidSet, query]);

    const selected = Math.min(active, guilds.length - 1);

    const open = (guildId: string, peek: boolean) => {
        modalProps.onClose();
        if (peek) peeking = guildId;
        NavigationRouter.transitionToGuild(guildId);
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const step = e.key === "ArrowDown" ? 1 : -1;
            setActive((selected + step + guilds.length) % Math.max(guilds.length, 1));
        } else if (e.key === "Enter" && guilds[selected]) {
            open(guilds[selected].guild.id, e.shiftKey);
        }
    };

    const count = `${voidSet.size} ${voidSet.size === 1 ? "server" : "servers"}`;

    return (
        <Modal
            {...modalProps}
            size="sm"
            title="Void"
            subtitle={count}
            input={
                <TextInput
                    autoFocus
                    placeholder="Search the Void"
                    value={query}
                    onChange={v => { setQuery(v); setActive(0); }}
                    onKeyDown={onKeyDown}
                />
            }
        >
            <div className="vc-void-modal-list">
                {guilds.length === 0 && (
                    <div className="vc-void-modal-empty">{voidSet.size ? "No matching servers" : "The Void is empty"}</div>
                )}
                {guilds.map(({ guild, mentions, unread }, i) => {
                    const icon = IconUtils.getGuildIconURL({ id: guild.id, icon: guild.icon, size: 64, canAnimate: false });
                    return (
                        <div
                            key={guild.id}
                            className={`vc-void-modal-row${i === selected ? " vc-void-modal-active" : ""}`}
                            onMouseEnter={() => setActive(i)}
                            onClick={e => open(guild.id, e.shiftKey)}
                        >
                            {icon
                                ? <img className="vc-void-modal-icon" src={icon} alt="" />
                                : <div className="vc-void-modal-icon vc-void-modal-acronym">{acronym(guild.name)}</div>}
                            <div className="vc-void-modal-text">
                                <span className={`vc-void-modal-name${unread ? " vc-void-modal-unread" : ""}`}>{guild.name}</span>
                                <span className="vc-void-modal-when">{describeVisit(guild.id)}</span>
                            </div>
                            {mentions > 0 && <span className="vc-void-modal-mentions">{mentions}</span>}
                            <div className="vc-void-modal-actions">
                                <button className="vc-void-modal-action" onClick={e => { e.stopPropagation(); visit(guild.id); }}>
                                    Take out
                                </button>
                                <button className="vc-void-modal-action" onClick={e => { e.stopPropagation(); setKept(guild.id, true); }}>
                                    Keep
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
            {guilds.length > 0 && (
                <div className="vc-void-modal-hint">Enter opens and takes it out · Shift+Enter or Shift+click only peeks</div>
            )}
        </Modal>
    );
}

let modalKey: string | null = null;

function toggleModal() {
    if (modalKey) {
        closeModal(modalKey);
        return;
    }
    modalKey = openModal(props => <VoidModal modalProps={props} />, {
        onCloseCallback: () => { modalKey = null; }
    });
}

function matchesShortcut(e: KeyboardEvent) {
    const shortcut = parseShortcut(settings.store.shortcut);
    if (!shortcut) return false;
    return e.key.toLowerCase() === shortcut.key
        && e.ctrlKey === shortcut.ctrl
        && e.shiftKey === shortcut.shift
        && e.altKey === shortcut.alt
        && e.metaKey === shortcut.meta;
}

function onKeyDown(e: KeyboardEvent) {
    if (e.repeat || !matchesShortcut(e)) return;
    e.preventDefault();
    e.stopPropagation();
    toggleModal();
}

let interval: ReturnType<typeof setInterval> | undefined;

export default definePlugin({
    name: "Void",
    description: "Servers you don't open go to the Void, a hidden folder in the server list. It only shows up, with your mention count, when someone pings you in one of them. Ctrl+Shift+O opens a list of everything in the Void.",
    authors: [{ name: "Srb404", id: 256522090134372362n }],
    settings,

    patches: [
        {
            find: '("guildsnav")',
            replacement: [
                // leave voided servers out of the server list
                {
                    match: /(\i)=(\i)\.getRoots\(\),(?=\i=\(0,\i\.\i\)\(\[\i\.\i\],\(\)=>\i\.\i\.getGeoRestrictedGuilds)/,
                    replace: "$1=$self.useRoots($2),"
                },
                // render the Void above the servers
                {
                    match: /children:(\i)\.map\(\((\i),(\i)\)=>(\i)\(\2,\3,\1\.length\)\)/,
                    replace: "children:[$self.renderVoid($4),...$1.map(($2,$3)=>$4($2,$3,$1.length))]"
                }
            ]
        },
        {
            // scrollToGuild walks up to the parent folder when a server has no rendered node, but never advances,
            // so a server in a folder whose servers are all in the Void spins forever: make it actually climb
            find: "this.guildsTree.getNode(",
            replacement: {
                match: /(getNode\((\i)\);if\(.{0,40}?\)break;\i=this\.nodeRefs\[)(\i\.parentId\])/,
                replace: "$1$2=$3"
            }
        },
        // previous/next server (ctrl+alt+up/down) skips the Void
        {
            find: '"mod+alt+down"',
            replacement: {
                match: /\i\.\i\.getFlattenedGuildIds\(\)(?=,\i=function)/,
                replace: "$self.visibleGuildIds($&,true)"
            }
        },
        // ctrl+1..9 count only the servers you can see
        {
            find: ".isTabBarVisible()){let",
            replacement: {
                match: /\i\.\i\.getFlattenedGuildIds\(\)/g,
                replace: "$self.visibleGuildIds($&)"
            }
        }
    ],

    contextMenus: {
        "guild-context": guildContext
    },

    flux: {
        CHANNEL_SELECT({ guildId }: { guildId?: string | null; }) {
            if (guildId !== peeking) peeking = null;
            if (guildId && !peeking) visit(guildId);
            if (guildId && guildId !== lastGuildId) setExpanded(false);
            lastGuildId = guildId ?? null;
        },
        VOICE_CHANNEL_SELECT({ guildId }: { guildId?: string | null; }) {
            if (guildId) visit(guildId);
        },
        MESSAGE_CREATE({ message, optimistic }: { message: Message; optimistic?: boolean; }) {
            if (optimistic || message.author?.id !== UserStore.getCurrentUser()?.id) return;
            const guildId = ChannelStore.getChannel(message.channel_id)?.guild_id;
            if (guildId) visit(guildId);
        },
        CONNECTION_OPEN: () => recompute(),
        GUILD_CREATE: () => recompute(),
        GUILD_DELETE({ guild }: { guild: { id: string; unavailable?: boolean; }; }) {
            // an outage also deletes guilds, but those come back
            if (!guild.unavailable && !GuildAvailabilityStore.isUnavailable(guild.id)) forget(guild.id);
            recompute();
        }
    },

    useRoots,
    visibleGuildIds,
    renderVoid: (renderTreeNode: (node: any) => React.ReactNode) => <VoidItem key="vc-void" renderTreeNode={renderTreeNode} />,

    async start() {
        await migrateDataStore();
        await mergeLocalVisits();
        loaded = true;
        recompute();
        interval = setInterval(recompute, 10 * 60 * 1000);
        document.addEventListener("keydown", onKeyDown, true);
    },

    stop() {
        clearInterval(interval);
        document.removeEventListener("keydown", onKeyDown, true);
        if (modalKey) closeModal(modalKey);
        loaded = false;
        voided = new Set();
        expanded = false;
        peeking = null;
        emit();
    }
});
