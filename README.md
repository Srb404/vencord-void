# vencord-void

A [Vencord](https://github.com/Vendicated/Vencord) userplugin that hides the Discord servers you don't use. Servers you haven't opened for a while fall into the **Void**, a hidden folder in the server list. You don't see them, until someone pings you in one of them: then the Void shows up with your mention count.

Nothing is deleted or left: you stay in every server, they're just out of sight. Open one and it comes back to its old place.

## How it works

The plugin remembers when you last used each server: opened it, joined its voice channel or sent a message there. Every server you haven't opened for the set number of days (14 by default) goes to the Void:

- it disappears from the server list, also from inside folders;
- the Void icon appears at the top of the list only when a server in it has a ping (optionally also on unread messages, or always);
- clicking the icon expands the Void like a folder, with Discord's own server icons, unread markers and badges; it collapses again when you switch servers;
- opening a server takes it out of the Void and puts it back where it was;
- <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> and <kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>9</kbd> skip the servers in the Void;
- leaving a server removes it from the plugin's memory.

New servers, and all servers right after installing, get the full grace period, so nothing disappears on day one.

## Features

- **Right-click a server**: *Send to Void* (or *Take out of Void*) and *Never send to Void*, for servers you want to keep visible even if you rarely open them. The menu also says in how many days the server goes to the Void by itself.
- **Right-click a folder**: *Send folder to Void* sends every server in it at once.
- **Quick list**: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd> opens a small window with everything in the Void, pinged servers first with their mention count, then unread ones, each with when you last opened it. Type to search, pick with <kbd>↑</kbd>/<kbd>↓</kbd> and <kbd>Enter</kbd> (or click). <kbd>Shift</kbd>+<kbd>Enter</kbd> (or <kbd>Shift</kbd>+click) only peeks: the server opens but stays in the Void. The *Take out* and *Keep* buttons on a row act without opening the server. Press the shortcut again to close it.
- **Syncs between devices**: the Void lives in the plugin's settings, so Vencord Cloud carries it between your computers along with the rest of your settings.

## Requirements

- Vencord [built from source](https://docs.vencord.dev/installing/) (userplugins require it)
- Any Discord client Vencord runs in. Tested on the official desktop client on Linux.

## Installation

```sh
git clone https://github.com/Srb404/vencord-void /path/to/Vencord/src/userplugins/void
cd /path/to/Vencord && pnpm build && pnpm inject   # inject only on first install
```

The plugin must physically live in `src/userplugins`. A symlink won't work, because esbuild resolves it to the real path, where Vencord's `@api/...` import aliases don't apply.

Then reload Discord (<kbd>Ctrl</kbd>+<kbd>R</kbd>) and enable **Void** in Vencord's plugin settings.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Days | 14 | Servers you haven't opened for this many days go to the Void |
| Shortcut | `ctrl+shift+o` | Opens the quick list; modifiers `ctrl`, `shift`, `alt`, `meta` joined with `+` |
| Always show | off | Show the Void icon even when nobody pings you there |
| Show on unread | off | Also show it when an unmuted server in the Void has unread messages |

## Syncing

With Vencord Cloud's settings sync on, the Void moves between devices by itself. Vencord uploads changes about a minute after the last one and downloads them when Discord starts, so:

- give it a minute before closing Discord on one computer and opening it on the other;
- after downloading, Vencord asks you to restart Discord to apply everything.

Cloud sync replaces the whole settings file, so if you use two computers at the same time, the one that uploads last wins. To make up for it, every computer also keeps its own copy of the visits and merges it back on startup, keeping the newer event for each server, so visits from both computers survive.

## Disclaimer

Client modifications are against Discord's Terms of Service. Vencord is used by many people without issues, but use it at your own risk. This is a third-party userplugin, not affiliated with or supported by Vencord or Discord.

## License

[GPL-3.0-or-later](LICENSE), like Vencord, which this plugin is built against.
