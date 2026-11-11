# Discord bot setup

The bot is already logged in as **Scribblespark** and joined **[redacted server] → [redacted channel]** for the first live test. This walkthrough is here for a second server or a fresh setup.

## 1. Invite it to your server

Open **Setup → Discord bot** and click **Open** on the invite link. The dashboard builds the link
from the public application ID inside the bot token, so it is always correct for the configured
bot. You need **Manage Server** on the target server to add it.

Permissions requested:

- View Channel (`1024`)
- Connect (`1048576`)
- Speak (`2097152`)

Total: `3146752`.

The bot does **not** need Message Content, Server Members, or Administrator.

## 2. Check the channel permissions

If the voice channel is public, the server-level permissions are usually enough. If it is private or category-restricted, add the bot's role (or the bot user) to that channel and allow:

- View Channel
- Connect
- Speak

The bot joins self-deafened=false, self-muted=true. It listens; it does not speak.

## 2b. Give it a personality

Scribblespark is the default server nickname for the bot; the Discord account name itself is
unchanged. **Setup → Bot personality** edits the nickname, activity type, base activity text, and
whether the presence updates while recording/testing/processing/listening. Changing a guild nickname
needs **Change Nickname** (or Manage Nicknames); if that permission is missing, the activity still
works and the nickname is left alone.

## 3. Confirm the dashboard sees the server

1. Open `http://127.0.0.1:17300`.
2. Go to **Setup** and click **Refresh**. The Discord server list lives under **Advanced**.
3. Your server should appear. It is also listed in the server picker on **Record**.

You can also check from a terminal:

```powershell
(Invoke-RestMethod http://127.0.0.1:17300/api/discord/guilds).guilds
```

## 4. Run the audio test

1. Join the target voice channel yourself.
2. On **Record**, choose the server and channel under **Voice channel**.
3. Click **Join**.
4. Click **Test audio**.
5. Speak for 10–20 seconds, then stop the test.

A healthy result shows:

- at least one utterance;
- more than zero bytes;
- no `DecryptionFailed` errors;
- your Discord user in the per-speaker list.

If the test shows zero bytes, do not start a real session. Recheck Connect/Speak permissions, the bot token, and the DAVE/Opus dependency report.

## 5. First real session

1. Create a session in **Sessions**, confirm consent, and select the voice channel.
2. Start recording.
3. Run the 60-second capture test first if this is a new server.
4. Keep the bot in the same channel for the whole session. If it disconnects, stop and note the gap; there is no OBS fallback.

## 6. Foundry bridge

The bridge is the main path. Point the module at the loopback dashboard:

- dashboard URL: `http://127.0.0.1:17300`
- module: **TableRecords Bridge**
- Session ID: leave blank to follow the active recording
- Alt+M: GM mental-note prompt

When a TableRecords session is recording, the bridge targets it automatically. If no session is recording, the bridge stays connected but reports `targetSessionId: null`.

If the Foundry browser cannot reach loopback, use the macro export instead: run it as GM after the session, then upload the JSON in Sessions → Rolls. Do not put the bridge token in chat or screenshots.

