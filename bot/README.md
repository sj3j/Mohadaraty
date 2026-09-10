# Telegram mirror bot

Bidirectional mirror between five private Telegram channels and the five
academic stages of the `announcements` feed.

- **Telegram → app**: a channel post becomes an announcement in that stage.
- **App → Telegram**: an announcement is posted to its stage's channel, unless
  the moderator opted that post out in the composer.
- **Edits** sync both ways. **Deletes** only go app → Telegram.
- **Polls are not mirrored** in either direction.

---

## Why deletes are one-directional

Telegram's Bot API delivers **no message-deletion events**. A bot cannot learn
that a channel post was deleted, so a post deleted inside Telegram stays in the
app. There is no workaround; the admin screen says so rather than pretending
otherwise. Deleting in the app *does* delete the mirrored Telegram message.

## Why polls are not mirrored

Bots can send a poll to a channel but receive no `poll_answer` updates for
channel polls — votes cast in Telegram are permanently invisible to the bot.
A poll that could be voted on in two places while only one set of votes counted
would be worse than no mirroring.

---

## One-time setup

### 1. Create the bot and add it to each channel

Talk to [@BotFather](https://t.me/BotFather), create a bot, copy the token.

Then in **each** of the five stage channels: *Manage channel → Administrators →
Add administrator → your bot*, and grant:

| Right | Needed for |
| --- | --- |
| Post messages | app → Telegram |
| Edit messages | syncing an app-side edit |
| Delete messages | deleting from Telegram when the app post is deleted |

> A bot that is not an administrator of a channel receives **no channel posts at
> all**, silently. The bot checks this at boot and every 15 minutes, and names
> the missing right in the admin screen.

### 2. Find each channel's numeric id

Forward any message from the channel to [@userinfobot](https://t.me/userinfobot),
or open the channel in Telegram Web and read the `-100…` id from the URL. The
admin screen also accepts a `t.me/c/…` link and extracts the id.

### 3. Map channels to stages in the app

Settings → Administration → **مزامنة تيليجرام / Telegram mirror**
(master admin only).

Enter one channel id per stage, turn on the stages you want, and save. The bot
picks the change up live — **no restart, no redeploy**.

### 4. Configure and run the container

```bash
cp bot/.env.example bot/.env
# fill in TELEGRAM_BOT_TOKEN and the three FIREBASE_* values

docker compose -f bot/docker-compose.yml up -d --build
docker compose -f bot/docker-compose.yml logs -f
```

The build context is the **repo root**, not `bot/` — the bot imports the
announcement types and the link sanitiser straight out of `src/` so the schema
has exactly one definition. Run the command from the repo root.

---

## Operational notes

**One consumer per bot token.** Telegram delivers updates to exactly one place.
This bot long-polls, so any webhook must be gone — it clears one automatically
at boot. The Cloud Function that used to hold it was deployed in **two**
regions, and a `firebase deploy` removes neither:

```bash
firebase functions:delete telegramWebhookV3 --region me-west1
firebase functions:delete telegramWebhookV3 --region us-central1
```

**One container at a time.** A Firestore lease stops a second instance from
starting; it exits non-zero rather than double-posting every message.

**A first run does not import history.** Telegram holds up to 24h of pending
updates. A cold start skips them deliberately — importing a day of channel
history would create dozens of announcements at once, each firing its own push
notification to a whole stage.

**Size limits.** Bots can download at most **20MB** (`getFile`) and upload
50MB. A larger Telegram file is skipped with a note in the post pointing at the
channel; a larger app attachment is skipped with a link.

**Media edits do not sync.** Telegram cannot add or remove media from an
existing message. Changing an announcement's attachments would require
delete-and-repost, which burns the message, its views and its comment thread,
and re-notifies every subscriber. The post is flagged `media_edit_unsupported`
in the admin screen instead.

---

## Where state lives

Everything is in Firestore; the container is disposable and mounts no volumes.

| Document | Contents |
| --- | --- |
| `admin_config/telegram` | the channel map (master admin reads and writes) |
| `admin_config/telegram_status` | health, per-channel counters (bot writes, master admin reads) |
| `admin_config/telegram_state` | the `getUpdates` offset and the instance lease |
| `telegramMessages/{chatId}_{msgId}` | message ↔ announcement mapping |
| `announcements/*.telegramMirror` | where a post lives in Telegram, and its content hash |

That last field is the loop breaker. Both directions send only when the content
hash differs from what is already mirrored, which also makes a Firestore
listener reconnect free: it replays every document as `added`, they all hash
equal, and nothing is sent.

`reactions` and `poll.counts` are deliberately excluded from the hash. Including
them would turn one student tapping 👍, or one vote in a class poll, into a
Telegram edit — and a busy poll into a 429.

---

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Admin screen says "bot offline" | `docker compose -f bot/docker-compose.yml ps`, then the logs. The screen calls it offline after 2 minutes without a heartbeat. |
| Nothing arrives from Telegram | Is the bot an administrator of that channel? The screen shows `parked` and the missing right. |
| `409 Conflict` in the logs | Something else holds the update stream: a webhook, or a second container. |
| Posts appear in the app but not Telegram | The per-post toggle in the composer, or `mirrorOut` off for that stage. |
| An old post was not mirrored | `MIRROR_MAX_AGE_MS` (default 24h). This is the guard that stops a first boot from re-posting the back catalogue. |

```bash
npm --prefix bot run lint     # typecheck
npm --prefix bot run test     # entity codec round-trip tests
curl -s localhost:8081/healthz?verbose=1 | jq   # on the host, if the port is exposed
```
