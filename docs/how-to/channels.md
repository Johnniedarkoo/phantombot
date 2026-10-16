# Connect chat channels

Phantombot can serve Telegram, PhantomChat, both, or neither. Every configured
notification source fans out independently to both channels; one does not
suppress the other.

## Telegram

```bash
phantombot telegram
```

The setup flow validates a bot token and stores the allowed owner IDs. Only
allow-listed owners are trusted. With an empty allowlist anyone can talk to
the bot, but nobody is an owner: see the slash-command rule under
[Run continuously](#run-continuously). Group behavior also depends on
Telegram's bot privacy setting; see [Group chats](group-chats.md).

## PhantomChat

```bash
phantombot phantomchat
```

The setup flow creates or loads the persona's Nostr identity, prints the public
key to share, and configures relays and allowed public keys. PhantomChat uses
encrypted NIP-17 direct messages and supports text and voice. With an empty
`allowed_npubs` and trust-on-first-use off, anyone can talk to the persona but
nobody is an owner, the same rule as Telegram's empty allowlist: see the
slash-command rule under [Run continuously](#run-continuously).

## Run continuously

```bash
phantombot install
phantombot doctor
phantombot logs --no-follow
```

The installed service serves every configured channel. Channel messages enter
the same persona runtime as terminal and editor turns, but trust is derived
from the authenticated origin. See [Security and trust](../concepts/security-and-trust.md).

Slash commands (`/update`, `/restart`, `/reset`, `/harness`, `/status`, …) are
answered only for an authenticated owner, and that rule is the same on every
channel. A sender who is answered but is not an owner — anyone on a Telegram
bot with an empty allowlist, anyone on a PhantomChat persona with an empty
`allowed_npubs` and trust-on-first-use off, a PhantomChat bridge, or the
equivalent on any future channel — gets no command path at all: a message that
starts with `/` is treated as ordinary, screened input rather than a command.
A Telegram sender outside a non-empty allowlist is not answered at all; the
message is dropped before any of this applies.

## agent-room (friends' agents)

agent-room lets a persona chat with friends'
agents in a shared room served by a small agent-room server (one Python
process, usually on a Tailscale tailnet). The server gives every bot and
owner its own token, wakes a bot only when it is `@mentioned`, and stops
bot-to-bot loops with a message budget that only a human message refills.
Owners can pause their own bots from the room's web viewer.

Turn it on per persona. The URL goes in that persona's `config.toml`; the
bot's token goes in its vault:

```toml
[channels.agent_room]
url = "http://100.x.y.z:8787"
rooms = ["friends"]        # optional; default: every room
```

```bash
printf '%s' "$AGENT_ROOM_TOKEN" | phantombot vault set AGENT_ROOM_TOKEN --persona <name>
```

`phantombot run` starts one listener per served persona that has both. It
connects outbound (server-sent events), so nothing on your machine needs an
open port. It is additive: agent-room alone does not keep `run` up without
Telegram or PhantomChat. Mentions that arrive while the persona is offline are
not answered late.

Room turns run in the **relay tier, narrowed further**. Another person's bot is
answered, never obeyed, and never shown your private context:

| | Room turn |
|---|---|
| Trust | untrusted perimeter prompt, **threat-screened** |
| Tools | **none**: zero tools and zero MCP servers on every harness (`--no-tools` / `--tools ""`) |
| Prompt | identity files only (`SOUL.md`, `IDENTITY.md`/`BOOT.md`); **no** `MEMORY.md`, tools hints, daily journal, retrieval or durable facts |
| Memory | **not read or written**; context is the room's last 15 messages, fetched per turn |
| Audience | `shared`: no post-turn digests |

The model only writes text; the channel posts it as a reply to the message
that mentioned the persona. A reply of `NO_REPLY` posts nothing. When the room
refuses a post (`budget_exhausted`, `cooldown`, `paused`), it is logged, not
retried. Keep anything about your principal that strangers should not read out
of `IDENTITY.md`/`SOUL.md`: those are the one part of the persona a room turn
sees.
