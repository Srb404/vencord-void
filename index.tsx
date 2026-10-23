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
import { Guild, RenderModalProps } from "@vencord/discord-types";
import { closeModal, GuildReadStateStore, GuildStore, IconUtils, Menu, Modal, NavigationRouter, openModal, React, SortedGuildStore, TextInput, Tooltip, useStateFromStores } from "@webpack/common";

const VISITS_KEY = "Void_visits";
const KEPT_KEY = "Void_kept";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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
        default: "ctrl+shift+o"
    },
    alwaysShow: {
        type: OptionType.BOOLEAN,
        description: "Always show the Void, not only when someone pings you there",
        default: false
    },
    // state lives in settings so Vencord Cloud syncs it between devices
    /** guildId -> last time you opened it */
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
const writeVisits = (patch: Record<string, number>) => settings.store.visits = { ...visitsOf(), ...patch };

let voided = new Set<string>();
let expanded = false;
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
        const last = visits[id] ?? (seed[id] = now);
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
    const now = Date.now();
    // the limit is in days, so there's no need to write (and sync) settings on every click
    if (now - (visitsOf()[guildId] ?? 0) > HOUR) writeVisits({ [guildId]: now });
    recompute();
}

function toggleExpanded() {
    expanded = !expanded;
    emit();
}

const useVoid = () => React.useSyncExternalStore(subscribe, () => voided);
const useExpanded = () => React.useSyncExternalStore(subscribe, () => expanded);

/** Takes the guild list roots and leaves out every voided server (also inside folders). */
function useRoots(roots: any[]) {
    // no memo: Discord can reorder the roots array in place
    const voidSet = useVoid();
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

const VoidItem = ErrorBoundary.wrap(({ renderTreeNode }: { renderTreeNode: (node: any) => React.ReactNode; }) => {
    const voidSet = useVoid();
    const isExpanded = useExpanded();
    const { alwaysShow } = settings.use(["alwaysShow"]);
    const pinged = useStateFromStores(
        [GuildReadStateStore],
        () => [...voidSet].some(id => GuildReadStateStore.getMentionCount(id) > 0),
        [voidSet]
    );

    if (!alwaysShow && (!voidSet.size || !(isExpanded || pinged))) return null;

    const tree = SortedGuildStore.getGuildsTree();
    const nodes = SortedGuildStore.getFlattenedGuildIds()
        .filter(id => voidSet.has(id))
        .map(id => tree.getNode(id))
        .filter(Boolean);

    const label = `Void (${voidSet.size} ${voidSet.size === 1 ? "server" : "servers"})`;

    return (
        <div className={`vc-void${isExpanded ? " vc-void-expanded" : ""}`}>
            <div className="vc-void-item">
                <Tooltip text={label} position="right">
                    {props => (
                        <div
                            {...props}
                            className="vc-void-icon"
                            role="treeitem"
                            aria-label={label}
                            aria-expanded={isExpanded}
                            onClick={toggleExpanded}
                        >
                            <VoidIcon />
                        </div>
                    )}
                </Tooltip>
                {pinged && <div className="vc-void-badge">!</div>}
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
    settings.store.kept = keptOf().filter(id => !guildIds.includes(id));
    writeVisits(Object.fromEntries(guildIds.map(id => [id, 0])));
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
    children.push(
        <Menu.MenuGroup>
            {voided.has(id)
                ? <Menu.MenuItem id="vc-void-out" label="Take out of Void" action={() => visit(id)} />
                : <Menu.MenuItem id="vc-void-in" label="Send to Void" action={() => sendToVoid([id])} />}
            <Menu.MenuCheckboxItem
                id="vc-void-keep"
                label="Never send to Void"
                checked={keptOf().includes(id)}
                action={() => setKept(id, !keptOf().includes(id))}
            />
        </Menu.MenuGroup>
    );
};

const acronym = (name: string) => name.split(/\s+/).map(w => w[0]).join("").slice(0, 3);

function VoidModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const voidSet = useVoid();
    const [query, setQuery] = React.useState("");
    const [active, setActive] = React.useState(0);

    const guilds = useStateFromStores([GuildReadStateStore, GuildStore], () => {
        const q = query.trim().toLowerCase();
        return SortedGuildStore.getFlattenedGuildIds()
            .filter(id => voidSet.has(id))
            .map(id => GuildStore.getGuild(id))
            .filter(g => g && (!q || g.name.toLowerCase().includes(q)))
            .map(g => ({ guild: g, mentions: GuildReadStateStore.getMentionCount(g.id) }))
            // pinged servers first
            .sort((a, b) => Number(b.mentions > 0) - Number(a.mentions > 0));
    }, [voidSet, query]);

    const selected = Math.min(active, guilds.length - 1);

    const open = (guildId: string) => {
        modalProps.onClose();
        NavigationRouter.transitionToGuild(guildId);
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const step = e.key === "ArrowDown" ? 1 : -1;
            setActive((selected + step + guilds.length) % Math.max(guilds.length, 1));
        } else if (e.key === "Enter" && guilds[selected]) {
            open(guilds[selected].guild.id);
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
                {guilds.map(({ guild, mentions }, i) => {
                    const icon = IconUtils.getGuildIconURL({ id: guild.id, icon: guild.icon, size: 64, canAnimate: false });
                    return (
                        <div
                            key={guild.id}
                            className={`vc-void-modal-row${i === selected ? " vc-void-modal-active" : ""}`}
                            onMouseEnter={() => setActive(i)}
                            onClick={() => open(guild.id)}
                        >
                            {icon
                                ? <img className="vc-void-modal-icon" src={icon} alt="" />
                                : <div className="vc-void-modal-icon vc-void-modal-acronym">{acronym(guild.name)}</div>}
                            <span className="vc-void-modal-name">{guild.name}</span>
                            {mentions > 0 && <span className="vc-void-modal-mentions">{mentions}</span>}
                        </div>
                    );
                })}
            </div>
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
    const parts = settings.store.shortcut.toLowerCase().split("+").map(p => p.trim()).filter(Boolean);
    const key = parts.find(p => !["ctrl", "control", "shift", "alt", "meta", "cmd"].includes(p));
    if (!key) return false;
    return e.key.toLowerCase() === key
        && e.ctrlKey === parts.some(p => p === "ctrl" || p === "control")
        && e.shiftKey === parts.includes("shift")
        && e.altKey === parts.includes("alt")
        && e.metaKey === parts.some(p => p === "meta" || p === "cmd");
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
    description: "Servers you don't open go to the Void, a hidden folder in the server list. It only shows up, with a \"!\", when someone pings you in one of them. Ctrl+Shift+O opens a list of everything in the Void.",
    authors: [{ name: "Srb404", id: 256522090134372362n }],
    settings,

    patches: [
        {
            find: '("guildsnav")',
            replacement: [
                // leave voided servers out of the server list
                {
                    match: /(\i)=(\i)\.getRoots\(\),(?=\i=\(0,\i\.\i\)\(\[\i\.\i\],\(\)=>\i\.\i\.getGeoRestrictedGuilds)/,
                    replace: "$1=$self.useRoots($2.getRoots()),"
                },
                // render the Void above the servers
                {
                    match: /children:(\i)\.map\(\((\i),(\i)\)=>(\i)\(\2,\3,\1\.length\)\)/,
                    replace: "children:[$self.renderVoid($4),...$1.map(($2,$3)=>$4($2,$3,$1.length))]"
                }
            ]
        }
    ],

    contextMenus: {
        "guild-context": guildContext
    },

    flux: {
        CHANNEL_SELECT({ guildId }: { guildId?: string | null; }) {
            if (guildId) visit(guildId);
        },
        CONNECTION_OPEN: () => recompute(),
        GUILD_CREATE: () => recompute(),
        GUILD_DELETE: () => recompute()
    },

    useRoots,
    renderVoid: (renderTreeNode: (node: any) => React.ReactNode) => <VoidItem key="vc-void" renderTreeNode={renderTreeNode} />,

    async start() {
        await migrateDataStore();
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
        emit();
    }
});
