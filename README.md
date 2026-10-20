# pi-jev2

**Stop your coding agent before it does something you'll regret.**

## The problem

You let an AI agent work in your repo and step away. It's fixing a test. It decides the fastest fix is to delete a folder and force-push to `main`. Or it prints your API keys into the chat. By the time you look, it's done.

If you run several agents at once, each managed by another agent, nobody is watching at all.

## The solution

pi-jev2 checks every risky command your [Pi](https://github.com/earendil-works/pi) agent is about to run, before it runs.

- **It catches the bad ones.** Deleting files, force-pushing, sending data off your machine, going beyond what you asked for.
- **It's fast and cheap.** The check takes about a third of a second, using a small decision model built for yes-or-no calls ([Jev](https://docs.typesafe.ai)).
- **It works with no one watching.** When the agent works for another agent, pi-jev2 asks that agent to approve or deny, instead of waiting for you.
- **It catches leaks after the fact.** If a command prints a password or key, it warns the agent not to repeat it.
- **It never gets in your way when it breaks.** If the check itself fails, your agent keeps working.

## Try it in two minutes

1. Install it:

   ```bash
   pi install npm:@khaentertainment/pi-jev2
   ```

2. Give it a key. Run `/login typesafe` in Pi, or set `TYPESAFE_API_KEY`. (OpenRouter and other providers work too.)

3. Keep working as usual. pi-jev2 starts by only warning you, so nothing gets blocked. Run `/jev log` to see what it caught.

4. When you trust it, let it act:

   ```
   /jev mode enforce
   ```

   Now it asks you before a risky command runs.

**[Install pi-jev2 now](https://www.npmjs.com/package/@khaentertainment/pi-jev2)**, and see what your agent has been up to.

## Want the details?

Providers, settings, orchestrator setups, and the measurements behind every threshold are in the [reference guide](https://github.com/KHAEntertainment/pi-jev2/blob/main/docs/REFERENCE.md).

---

Built on [y0usaf/pi-jev](https://github.com/y0usaf/pi-jev). MIT licensed.
