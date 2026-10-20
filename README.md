# pi-jev2

A fast safety check for the [Pi coding agent](https://github.com/earendil-works/pi). Before the agent runs a risky command, pi-jev2 asks a small decision model whether it's a good idea. When the agent works for another agent, it can ask that agent instead of you.

```bash
pi install npm:@khaentertainment/pi-jev2
```

## The problem

Coding agents run shell commands and edit files on your machine. Most of that is fine. Now and then an agent decides the quickest fix is `rm -rf src`, a force push to `main`, or posting your `.env` somewhere. Usually you're not watching when it happens.

A second large language model reviewing every command would be slow and expensive. [TypeSafe's Jev](https://docs.typesafe.ai) is a different kind of model: it doesn't write text, it answers typed questions with numbers. "Is this destructive?" comes back as a probability in about 300 ms. That makes it cheap enough to check every command.

## Why this fork exists

[y0usaf/pi-jev](https://github.com/y0usaf/pi-jev) built that check for Pi. We started using it on teams of agents run by an orchestrator such as [Traycer](https://traycer.ai), and hit two limits:

1. **It only talked to TypeSafe.** We wanted to reach Jev through OpenRouter or another provider we already pay for.
2. **When it flagged a command, the only choices were "warn" or "ask the person at the keyboard."** An agent working for another agent has nobody at the keyboard. In that setup, a warning gets ignored and a prompt waits forever.

pi-jev2 fixes both:

- **Use any provider in Pi's catalog.** Jev through TypeSafe, OpenRouter, Cloudflare Workers AI, Vercel AI Gateway, or OpenCode, or another decision model entirely. pi-jev2 also carries its own copy of the Jev model definitions, for when Pi's catalog leaves them out.
- **Ask the orchestrator.** In escalate mode, a flagged command goes to whoever manages the agent: a parent Pi process, a Traycer parent agent, or any A2A-compatible orchestrator. That manager approves, denies, or hands the question to a human.

## How it works

1. **Before a command runs**, pi-jev2 asks Jev four questions about it:
   - Is it destructive?
   - Does it send data off the machine?
   - Does it go beyond what you asked for?
   - How bad would it be if you didn't want it?
2. **If a command looks risky**, what happens next depends on the mode:

   | Mode | What happens |
   |---|---|
   | `shadow` (default) | You get a warning. Nothing is blocked. |
   | `enforce` | You're asked to confirm before it runs. |
   | `escalate` | The agent's manager decides. If the manager doesn't answer in time, it falls back to `enforce`. |

3. **After a command runs**, pi-jev2 reads the output:
   - If a password or key was printed, it warns the agent not to repeat it.
   - If the command failed, it tells the agent what kind of failure it was (a network blip, a missing tool, a code bug) and whether retrying makes sense.
4. **If anything goes wrong** with pi-jev2 itself (no key, a timeout, an outage), the command goes ahead. A safety check that breaks your agent is worse than none.

The agent also gets `jev_ask`, for its own typed yes/no and multiple-choice judgements. When it has a manager, it gets `jev_escalate` too, for asking before a big step.

## Quick start

1. **Install** (needs Pi 0.99 or later):

   ```bash
   pi install npm:@khaentertainment/pi-jev2
   ```

2. **Give it a key.** By default it uses Jev from TypeSafe: set `TYPESAFE_API_KEY`, or run `/login typesafe` in Pi. To use OpenRouter or another provider instead, see [Providers](https://github.com/KHAEntertainment/pi-jev2/blob/main/docs/REFERENCE.md#providers).

3. **Watch it work.** It starts in `shadow` mode, so it only warns. Run `/jev` to see its status, and `/jev log` to see what it flagged.

4. **Turn it up when you trust it:**

   ```
   /jev mode enforce     ask me before risky commands
   /jev mode escalate    ask the agent's manager instead
   ```

   To make a mode stick, put it in `~/.pi/agent/pi-jev.json`:

   ```json
   { "gate": { "mode": "enforce" } }
   ```

## Commands

| Command | Does |
|---|---|
| `/jev` | Status: mode, model, credentials, escalation route |
| `/jev mode shadow\|enforce\|escalate` | Switch modes for this session |
| `/jev on`, `/jev off` | Turn the checks on or off |
| `/jev log` | Recent flags, leak warnings, and escalations |
| `/jev last`, `/jev output` | The last command verdict, the last output verdict |
| `/jev check <text>` | Run the four questions against any text |

## What it sends, and to whom

Each check sends the command, the working directory, and the start of your last message to the decision model's provider. File contents and output are cut short first (400 and 2,000 characters by default). In escalate mode, the same request goes to the agent's manager, with passwords and keys scrubbed out. If a request can't be scrubbed safely, it isn't sent, and you're asked locally instead. Details are in [What leaves the machine](https://github.com/KHAEntertainment/pi-jev2/blob/main/docs/REFERENCE.md#what-leaves-the-machine).

A repository's own `.pi/pi-jev.json` can make the checks stricter but never looser. A cloned repo can't switch them off, pick a model that never flags, or send your requests to its own server.

## Learn more

[`docs/REFERENCE.md`](https://github.com/KHAEntertainment/pi-jev2/blob/main/docs/REFERENCE.md) has everything else:

- [Providers](https://github.com/KHAEntertainment/pi-jev2/blob/main/docs/REFERENCE.md#providers): every supported model and its login, and how to keep OpenRouter's chat models out of Pi
- [Escalation](https://github.com/KHAEntertainment/pi-jev2/blob/main/docs/REFERENCE.md#escalation): how each orchestrator connection works, and the request format
- [Configure](https://github.com/KHAEntertainment/pi-jev2/blob/main/docs/REFERENCE.md#configure): every setting, and which ones a project file may change
- [Calibration](https://github.com/KHAEntertainment/pi-jev2/blob/main/docs/REFERENCE.md#calibration): the measurements behind each threshold

Releases: [`PUBLISHING.md`](PUBLISHING.md). Contributing: [`AGENTS.md`](AGENTS.md).

## Credits

Built on [y0usaf/pi-jev](https://github.com/y0usaf/pi-jev), which created the gate, the output judge, the journal, and the calibration method. [Jev](https://docs.typesafe.ai) is TypeSafe's model. MIT licensed.
