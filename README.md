[![greenlight](https://ascii.rest/banner/greenlight.svg?color=07f236,3f8862&font=bold&shadow=heavy&fill=block&size=l)](https://ascii.rest/banner/)

<div align="center">

### The go-ahead from whoever's in charge

**When your coding agent tries something risky, it asks its boss first.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/KHAEntertainment/greenlight?utm_source=oss&utm_medium=github&utm_campaign=KHAEntertainment%2Fgreenlight&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit)](https://coderabbit.ai)

[Try it](#try-it-in-two-minutes) | [The problem](#the-problem) | [The solution](#the-solution) | [Full reference](docs/REFERENCE.md)

</div>

## The problem

You let AI agents work in your repo and step away. One of them is fixing a test, and decides the fastest fix is to delete a folder and force-push to `main`.

[pi-jev](https://github.com/y0usaf/pi-jev) already catches that for [Pi](https://github.com/earendil-works/pi). Before a risky command runs, it asks a fast decision model ([Jev](https://docs.typesafe.ai)) whether it's a good idea, then warns you or asks you to confirm.

That works when you're at the keyboard. More and more, you aren't. Agents run under other agents: an orchestrator splits the work and hands pieces to helpers. When a helper's command gets flagged, a warning goes unread and a confirm prompt waits forever. The safety check either does nothing or freezes the work.

## The solution

Greenlight sends the decision up the chain of command.

When a command looks risky, Greenlight pauses it and asks the agent's orchestrator: approve, deny, or ask a human. The orchestrator knows the plan, so it can tell a planned cleanup from a mistake. If it doesn't answer in time, you're asked instead, the same as in pi-jev.

It works with:

- **[Traycer](https://traycer.ai)**, the first supported agentic development environment (ADE). A helper agent's flagged command goes straight to its parent agent in Traycer.
- **A parent Pi agent**, when one Pi runs another.
- **Any orchestrator that speaks [A2A](https://a2a-protocol.org)**, the open agent-to-agent protocol.
- **You**, if you're working one-on-one with an agent.

Orca and Xirp are next.

Greenlight also lets you reach Jev through the provider you already use: TypeSafe, OpenRouter, Cloudflare, Vercel, or OpenCode. Jev is the default, not the only option: Mercury Decide can run the output check, and Clef Flash through OpenRouter is calibrated for the gate with the same thresholds. The [calibration data](docs/REFERENCE.md#calibration) covers all three.

Everything pi-jev does is still here. It checks risky commands in about a third of a second, warns when a command prints a password, and never blocks your agent if the check itself fails.

## Try it in two minutes

1. Install it:

   ```bash
   pi install npm:@khaentertainment/pi-greenlight
   ```

2. Give it a key. Run `/login typesafe` in Pi, or set `TYPESAFE_API_KEY`.

3. Keep working as usual. Greenlight starts by only warning you, so nothing gets blocked. Run `/greenlight log` to see what it caught.

4. Running agents under Traycer or another orchestrator? Hand the decisions up the chain:

   ```text
   /greenlight mode escalate
   ```

   Working alone? Use `/greenlight mode enforce` to be asked before risky commands run.

**[Install Greenlight now](https://www.npmjs.com/package/@khaentertainment/pi-greenlight)**, and give your agents a boss to answer to.

## Want the details?

Orchestrator setup, providers, settings, and the measurements behind every threshold are in the [reference guide](https://github.com/KHAEntertainment/greenlight/blob/main/docs/REFERENCE.md).

---

A fork of [y0usaf/pi-jev](https://github.com/y0usaf/pi-jev), which built the command check this is based on. MIT licensed.
