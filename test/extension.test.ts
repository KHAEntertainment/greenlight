/**
 * The extension end to end against a fake pi host: session_start readiness,
 * the tool_call gate in each mode, the escalation fallback, the output judge,
 * and the two tools.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jevExtension from "../src/index";
import { fakeContext, fakePi, fakeRegistry, gateAnswers, outputAnswers } from "./helpers";

let root: string;
let saved: Record<string, string | undefined>;
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "TRAYCER_AGENT_ID", "TRAYCER_EPIC_ID", "TRAYCER_PARENT_AGENT_ID"];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-jev-ext-"));
	saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	for (const key of ENV_KEYS) delete process.env[key];
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	mkdirSync(join(root, "agent"), { recursive: true });
	mkdirSync(join(root, "project", ".pi"), { recursive: true });
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	rmSync(root, { recursive: true, force: true });
});

function configure(value: unknown) {
	writeFileSync(join(root, "agent", "pi-jev.json"), JSON.stringify(value));
}

const destructiveCall = { toolName: "bash", toolCallId: "call-1", input: { command: "rm -rf src && git push --force origin main" } };

async function start(
	pi: ReturnType<typeof fakePi>,
	ctxOptions: Parameters<typeof fakeContext>[1] = {},
	registry = fakeRegistry(() => ({ answers: gateAnswers({ destructive: 0.99, impact: 3 }) })),
) {
	jevExtension(pi.api);
	const ctx = fakeContext(registry, ctxOptions);
	ctx.cwd = join(root, "project");
	await pi.emit("session_start", { reason: "startup" }, ctx);
	return { ctx, registry };
}

describe("session_start", () => {
	test("a host without the classifier runtime stays inactive and says so", async () => {
		const pi = fakePi();
		jevExtension(pi.api);
		const ctx = fakeContext({ find: () => undefined });
		await pi.emit("session_start", {}, ctx);
		expect(ctx.notifications.some((n) => n.message.includes("pi 0.99 or later"))).toBe(true);
		expect(await pi.emit("tool_call", destructiveCall, ctx)).toBeUndefined();
	});

	test("missing credentials name the provider's login", async () => {
		configure({ model: "openrouter/typesafe/jev-1.13" });
		const pi = fakePi();
		const { ctx } = await start(pi, {}, fakeRegistry(() => ({}), { configured: false }));
		expect(ctx.notifications.some((n) => n.message.includes("/login openrouter"))).toBe(true);
	});

	test("a Jev model missing from pi's catalog runs on the built-in definition, and says so", async () => {
		const keyFile = join(root, "or.key");
		writeFileSync(keyFile, "sk-or-test\n");
		configure({ model: "openrouter/typesafe/jev-1.14", apiKeyFile: keyFile });
		const pi = fakePi();
		const registry = fakeRegistry(() => ({ answers: gateAnswers({ destructive: 0.99, impact: 3 }) }), { known: [], configured: false });
		const { ctx } = await start(pi, {}, registry);
		expect(ctx.notifications.find((n) => n.message.includes("built-in definition"))?.type).toBe("info");
		expect(ctx.notifications.some((n) => n.message.includes("inactive"))).toBe(false);
		await pi.emit("tool_call", destructiveCall, ctx);
		expect(registry.calls[0]).toMatchObject({ model: "openrouter/typesafe/jev-1.14", apiKey: "sk-or-test" });
	});

	test("with both judges off, startup says nothing about the classifier", async () => {
		configure({
			model: "openrouter/typesafe/jev-1.14",
			gate: { enabled: false, mode: "escalate" },
			output: { enabled: false },
		});
		const pi = fakePi();
		const registry = fakeRegistry(() => ({}), { known: [], configured: false });
		const { ctx } = await start(pi, {}, registry);
		expect(ctx.notifications).toEqual([]);
	});

	test("/jev on reports what startup kept quiet while the judges were off", async () => {
		configure({ model: "openrouter/typesafe/jev-1.13", gate: { enabled: false }, output: { enabled: false } });
		const pi = fakePi();
		const { ctx } = await start(pi, {}, fakeRegistry(() => ({}), { configured: false }));
		expect(ctx.notifications).toEqual([]);
		await pi.commands.get("jev").handler("on", ctx);
		expect(ctx.notifications.some((n) => n.message.includes("/login openrouter") && n.type === "warning")).toBe(true);
		expect(ctx.statuses.at(-1)).toBeUndefined();
	});

	test("a project file that turns the judges on brings the notices back", async () => {
		const keyFile = join(root, "or.key");
		writeFileSync(keyFile, "sk-or-test\n");
		configure({ model: "openrouter/typesafe/jev-1.14", apiKeyFile: keyFile, gate: { enabled: false }, output: { enabled: false } });
		writeFileSync(join(root, "project", ".pi", "pi-jev.json"), JSON.stringify({ gate: { enabled: true } }));
		const pi = fakePi();
		const registry = fakeRegistry(() => ({ answers: gateAnswers({ destructive: 0.99, impact: 3 }) }), { known: [], configured: false });
		const { ctx } = await start(pi, {}, registry);
		expect(ctx.notifications.some((n) => n.message.includes("built-in definition"))).toBe(true);
	});

	test("an unknown model is reported", async () => {
		configure({ model: "openrouter/nobody/nothing" });
		const pi = fakePi();
		const { ctx } = await start(pi);
		expect(ctx.notifications.some((n) => n.message.includes("not in the model catalog"))).toBe(true);
	});

	test("an uncalibrated model warns before it can block", async () => {
		configure({ model: "cloudflare-workers-ai/@cf/cloudflare/clef", gate: { mode: "enforce" } });
		const pi = fakePi();
		const { ctx } = await start(pi);
		expect(ctx.notifications.some((n) => n.message.includes("not a Jev model"))).toBe(true);
	});

	test("jev_escalate is active only with an orchestrator", async () => {
		const tui = fakePi();
		await start(tui, { mode: "tui" });
		expect(tui.active).not.toContain("jev_escalate");
		const rpc = fakePi();
		await start(rpc, { mode: "rpc" });
		expect(rpc.active).toContain("jev_escalate");
		expect(rpc.active).toContain("jev_ask");
	});
});

describe("gate modes", () => {
	test("shadow reports and runs", async () => {
		const pi = fakePi();
		const { ctx, registry } = await start(pi);
		expect(await pi.emit("tool_call", destructiveCall, ctx)).toBeUndefined();
		expect(ctx.notifications.some((n) => n.message.startsWith("jev shadow: bash - destructive 0.99"))).toBe(true);
		expect(registry.calls[0]?.model).toBe("typesafe/jev-latest");
		expect(pi.entries.some((e) => (e.data as { kind: string }).kind === "gate")).toBe(true);
	});

	test("enforce asks locally and blocks on decline", async () => {
		configure({ gate: { mode: "enforce" } });
		const pi = fakePi();
		const { ctx } = await start(pi, { confirm: false });
		const result = (await pi.emit("tool_call", destructiveCall, ctx)) as { block: boolean; reason: string };
		expect(result.block).toBe(true);
		expect(result.reason).toContain("(declined)");
		expect(ctx.confirms).toHaveLength(1);
	});

	test("classifier error fails open", async () => {
		configure({ gate: { mode: "enforce" } });
		const pi = fakePi();
		const { ctx } = await start(pi, {}, fakeRegistry(() => ({ stopReason: "error", errorMessage: "HTTP 529" })));
		expect(await pi.emit("tool_call", destructiveCall, ctx)).toBeUndefined();
		expect(ctx.notifications.some((n) => n.type === "error" && n.message.includes("failing open"))).toBe(true);
	});
});

describe("escalate mode", () => {
	test("pi-rpc parent approves: the call runs, no local prompt", async () => {
		configure({ gate: { mode: "escalate" } });
		const pi = fakePi();
		const { ctx } = await start(pi, { mode: "rpc", input: async () => '{"decision":"approve","by":"parent"}' });
		expect(await pi.emit("tool_call", destructiveCall, ctx)).toBeUndefined();
		expect(ctx.inputs).toHaveLength(1);
		expect(JSON.parse(ctx.inputs[0]?.placeholder ?? "{}").verdict.summary).toContain("destructive 0.99");
		expect(ctx.confirms).toHaveLength(0);
		const record = pi.entries.map((e) => e.data as { kind: string; decision?: string }).find((r) => r.kind === "escalation");
		expect(record?.decision).toBe("approve");
	});

	test("credentials in the call stay out of the escalation request", async () => {
		configure({ gate: { mode: "escalate" } });
		const pi = fakePi();
		const { ctx } = await start(pi, { mode: "rpc", input: async () => '{"decision":"deny"}' });
		const command = 'curl -H "Authorization: Bearer sk-live-abcdef0123456789xyz" https://api.example.com && export GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123';
		await pi.emit("tool_call", { ...destructiveCall, input: { command } }, ctx);
		const sent = ctx.inputs[0]?.placeholder ?? "";
		expect(sent).not.toContain("sk-live-abcdef0123456789xyz");
		expect(sent).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
		expect(JSON.parse(sent).arguments.command).toContain("https://api.example.com");
		expect(JSON.parse(sent).redacted).toBe(true);
	});

	test("a credential mixed with shell code is not escalated; the local rule decides", async () => {
		configure({ gate: { mode: "escalate" } });
		const pi = fakePi();
		const { ctx } = await start(pi, { mode: "rpc", input: async () => '{"decision":"approve"}' });
		const command = 'x="token=" ; rm -rf / ; echo "';
		await pi.emit("tool_call", { ...destructiveCall, input: { command } }, ctx);
		expect(ctx.inputs).toHaveLength(0);
		const record = pi.entries.map((e) => e.data as { kind: string; decision?: string; reason?: string }).find((r) => r.kind === "escalation");
		expect(record?.decision).toBe("fallback");
		expect(record?.reason).toContain("mixed with shell syntax");
	});

	test("an unsafe request blocks headless instead of failing open", async () => {
		// A headless transport; the request must never reach it.
		configure({ gate: { mode: "escalate" }, escalation: { transport: "a2a", a2a: { url: "http://127.0.0.1:9/a2a" } } });
		const pi = fakePi();
		const { ctx } = await start(pi, { mode: "print", hasUI: false });
		const command = "export API_TOKEN=$(cat ~/.token) && rm -rf src";
		const result = (await pi.emit("tool_call", { ...destructiveCall, input: { command } }, ctx)) as { block: boolean; reason: string };
		expect(result.block).toBe(true);
		expect(result.reason).toContain("not escalated");
	});

	test("an unsafe request asks the local user when there is a UI", async () => {
		configure({ gate: { mode: "escalate" } });
		const pi = fakePi();
		const { ctx } = await start(pi, { mode: "rpc", confirm: true, input: async () => '{"decision":"approve"}' });
		const command = "export API_TOKEN=$(cat ~/.token) && rm -rf src";
		expect(await pi.emit("tool_call", { ...destructiveCall, input: { command } }, ctx)).toBeUndefined();
		expect(ctx.inputs).toHaveLength(0);
		expect(ctx.confirms).toHaveLength(1);
	});

	test("pi-rpc parent denies: blocked with the parent's reason", async () => {
		configure({ gate: { mode: "escalate" } });
		const pi = fakePi();
		const { ctx } = await start(pi, { mode: "rpc", input: async () => "deny: no force pushes to main" });
		const result = (await pi.emit("tool_call", destructiveCall, ctx)) as { block: boolean; reason: string };
		expect(result.block).toBe(true);
		expect(result.reason).toContain("denied by pi parent: no force pushes to main");
	});

	test("no answer falls back to the enforce rule (local confirm)", async () => {
		configure({ gate: { mode: "escalate" } });
		const pi = fakePi();
		const { ctx } = await start(pi, { mode: "rpc", input: async () => undefined, confirm: true });
		expect(await pi.emit("tool_call", destructiveCall, ctx)).toBeUndefined();
		expect(ctx.confirms).toHaveLength(1);
		const record = pi.entries.map((e) => e.data as { kind: string; decision?: string }).find((r) => r.kind === "escalation");
		expect(record?.decision).toBe("fallback");
	});

	test("no transport, headless: warns and runs (fail open)", async () => {
		configure({ gate: { mode: "escalate" } });
		const pi = fakePi();
		const { ctx } = await start(pi, { mode: "json", hasUI: false });
		expect(await pi.emit("tool_call", destructiveCall, ctx)).toBeUndefined();
		expect(ctx.notifications.some((n) => n.message.includes("escalate mode has no orchestrator"))).toBe(true);
		expect(ctx.notifications.some((n) => n.message.includes("headless: not blocking"))).toBe(true);
	});

	describe("Traycer: block, then retry", () => {
		const header = "[traycer:agent-message] from Lead (agent lead-1) [claude]\n[traycer:agent-message] No reply is required.\n\n";

		async function traycerSetup(extra: Record<string, unknown> = {}) {
			process.env.TRAYCER_AGENT_ID = "child-1";
			process.env.TRAYCER_EPIC_ID = "epic-1";
			configure({ gate: { mode: "escalate" }, escalation: { traycer: { parentAgentId: "lead-1" }, ...extra } });
			const sent: string[] = [];
			const exec = async (_command: string, args: string[]) => {
				if (args[1] === "send") {
					sent.push(/"id":"([^"]+)"/.exec(args.join(" "))?.[1] ?? "");
					return { code: 0, stderr: "", stdout: '{"type":"result","data":{"responseId":"r-1"}}' };
				}
				return { code: 2, stderr: "unexpected", stdout: "" };
			};
			const pi = fakePi(exec);
			const { ctx } = await start(pi, { mode: "tui" });
			return { pi, ctx, sent, exec };
		}

		test("the flagged call is blocked while the parent decides; a deny holds on retry", async () => {
			const { pi, ctx, sent } = await traycerSetup();
			const first = (await pi.emit("tool_call", destructiveCall, ctx)) as { block: boolean; reason: string };
			expect(first.block).toBe(true);
			expect(first.reason).toContain(`asked lead-1 for a decision, request ${sent[0]}`);
			expect(pi.execCalls.some((c) => c.args.includes("--to") && c.args.includes("lead-1"))).toBe(true);
			// A sibling or an early retry does not send again.
			const again = (await pi.emit("tool_call", { ...destructiveCall, toolCallId: "call-2" }, ctx)) as { reason: string };
			expect(again.reason).toContain("asked lead-1");
			expect(sent).toHaveLength(1);

			expect(await pi.emit("input", { type: "input", text: "unrelated", source: "rpc" }, ctx)).toEqual({ action: "continue" });
			const note = (await pi.emit("input", { type: "input", text: `${header}{"id":"${sent[0]}","decision":"deny","reason":"ask the user first"}`, source: "rpc" }, ctx)) as { action: string; text: string };
			expect(note.action).toBe("transform");
			expect(note.text).toContain("lead-1 denied the flagged `bash` call: ask the user first. Do not retry it");
			await new Promise((resolve) => setTimeout(resolve, 0));
			const retry = (await pi.emit("tool_call", destructiveCall, ctx)) as { reason: string };
			expect(retry.reason).toContain("denied by lead-1: ask the user first");
		});

		test("an approve lets exactly one retry of that call run", async () => {
			const { pi, ctx, sent } = await traycerSetup();
			await pi.emit("tool_call", destructiveCall, ctx);
			const note = (await pi.emit("input", { type: "input", text: `${header}{"id":"${sent[0]}","decision":"approve"}`, source: "rpc" }, ctx)) as { text: string };
			expect(note.text).toContain("approved the flagged `bash` call. Retry that exact call now");
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(await pi.emit("tool_call", destructiveCall, ctx)).toBeUndefined();
			const later = (await pi.emit("tool_call", destructiveCall, ctx)) as { reason: string };
			expect(later.reason).toContain("asked lead-1");
			expect(sent).toHaveLength(2);
		});

		test("an approve without the request id is not taken", async () => {
			const { pi, ctx } = await traycerSetup();
			await pi.emit("tool_call", destructiveCall, ctx);
			expect(await pi.emit("input", { type: "input", text: `${header}{"decision":"approve"}`, source: "rpc" }, ctx)).toEqual({ action: "continue" });
			const retry = (await pi.emit("tool_call", destructiveCall, ctx)) as { reason: string };
			expect(retry.reason).toContain("asked lead-1");
		});

		test("no answer in time falls back to the enforce rule", async () => {
			const { pi, ctx } = await traycerSetup();
			await pi.emit("tool_call", destructiveCall, ctx);
			const realNow = Date.now;
			Date.now = () => realNow() + 301_000;
			try {
				const retry = (await pi.emit("tool_call", destructiveCall, ctx)) as { reason: string };
				expect(retry.reason).not.toContain("asked lead-1");
				expect(ctx.confirms.length).toBe(1);
			} finally {
				Date.now = realNow;
			}
		});

		test("a new process restores the wait from the session and takes the reply", async () => {
			const { pi, ctx, sent, exec } = await traycerSetup();
			await pi.emit("tool_call", destructiveCall, ctx);
			const session = pi.entries.map((entry) => ({ type: "custom", ...entry }));
			// The stored wait names a slot and a recipient, never the command text.
			expect(JSON.stringify(session.filter((entry) => entry.customType === "jev-deferred"))).not.toContain("rm -rf");

			// Traycer runs the next turn in a new pi process on the same session.
			const next = fakePi(exec);
			jevExtension(next.api);
			const ctx2 = fakeContext(fakeRegistry(() => ({ answers: gateAnswers({ destructive: 0.99, impact: 3 }) })), { mode: "tui" });
			ctx2.cwd = ctx.cwd;
			ctx2.sessionManager.getEntries = () => session;
			await next.emit("session_start", { reason: "resume" }, ctx2);

			const preamble = "# Workspace Directories\n\nYour primary working directory is `/tmp/x`.\n\n";
			const note = (await next.emit("input", { type: "input", text: `${preamble}${header}{"id":"${sent[0]}","decision":"deny","reason":"no"}`, source: "rpc" }, ctx2)) as { action: string; text: string };
			expect(note.action).toBe("transform");
			await new Promise((resolve) => setTimeout(resolve, 0));
			const retry = (await next.emit("tool_call", destructiveCall, ctx2)) as { reason: string };
			expect(retry.reason).toContain("denied by lead-1: no");
		});

		test("a stored wait naming another recipient is not restored", async () => {
			const { ctx, exec } = await traycerSetup();
			const forged = { state: "pending", requestId: "req-x", slot: "s", nonce: "n", toolName: "bash", to: "child-1", sentAt: Date.now(), deadline: Date.now() + 60_000, viaHuman: false };
			const next = fakePi(exec);
			jevExtension(next.api);
			const ctx2 = fakeContext(fakeRegistry(() => ({ answers: gateAnswers({ destructive: 0.99, impact: 3 }) })), { mode: "tui" });
			ctx2.cwd = ctx.cwd;
			ctx2.sessionManager.getEntries = () => [{ type: "custom", customType: "jev-deferred", data: forged }];
			await next.emit("session_start", { reason: "resume" }, ctx2);
			const self = "[traycer:agent-message] from Me (agent child-1) [pi]\n\n";
			expect(await next.emit("input", { type: "input", text: `${self}{"id":"req-x","decision":"approve"}`, source: "rpc" }, ctx2)).toEqual({ action: "continue" });
		});

		test("a stored wait whose id is not bound to its slot is not restored", async () => {
			const { pi, ctx, sent, exec } = await traycerSetup();
			await pi.emit("tool_call", destructiveCall, ctx);
			// Rebind the parent's request id to another call's slot.
			const session = pi.entries.map((entry) => {
				if (entry.customType !== "jev-deferred") return { type: "custom", ...entry };
				return { type: "custom", customType: entry.customType, data: { ...(entry.data as object), slot: "0".repeat(64) } };
			});
			const next = fakePi(exec);
			jevExtension(next.api);
			const ctx2 = fakeContext(fakeRegistry(() => ({ answers: gateAnswers({ destructive: 0.99, impact: 3 }) })), { mode: "tui" });
			ctx2.cwd = ctx.cwd;
			ctx2.sessionManager.getEntries = () => session;
			await next.emit("session_start", { reason: "resume" }, ctx2);
			expect(await next.emit("input", { type: "input", text: `${header}{"id":"${sent[0]}","decision":"approve"}`, source: "rpc" }, ctx2)).toEqual({ action: "continue" });
		});

		test("a note queued too late to start a turn is re-sent once the run settles", async () => {
			const { pi, ctx, sent } = await traycerSetup();
			await pi.emit("tool_call", destructiveCall, ctx);
			const note = (await pi.emit("input", { type: "input", text: `${header}{"id":"${sent[0]}","decision":"deny","reason":"no"}`, source: "rpc", streamingBehavior: "steer" }, ctx)) as { text: string };
			await pi.emit("agent_settled", { type: "agent_settled", aborted: false }, ctx);
			expect(pi.userMessages).toEqual([note.text]);

			// A queued note that did start a turn is not sent again.
			await pi.emit("tool_call", destructiveCall, ctx);
			const second = (await pi.emit("input", { type: "input", text: `${header}{"id":"${sent[1]}","decision":"deny"}`, source: "rpc", streamingBehavior: "followUp" }, ctx)) as { text: string };
			await pi.emit("message_start", { type: "message_start", message: { role: "user", content: [{ type: "text", text: second.text }] } }, ctx);
			await pi.emit("agent_settled", { type: "agent_settled", aborted: false }, ctx);
			expect(pi.userMessages).toHaveLength(1);
		});

		test("an expired jev_escalate wait does not block an id-less deny for a live request", async () => {
			const { pi, ctx, sent, exec } = await traycerSetup();
			const tool = pi.tools.get("jev_escalate");
			await tool.execute("t", { question: "May I?", action: "x" }, undefined, undefined, ctx);
			const realNow = Date.now;
			Date.now = () => realNow() + 301_000;
			try {
				// In the same process: the next send settles the stale ask first.
				await pi.emit("tool_call", destructiveCall, ctx);
				const idless = `${header}{"decision":"deny","reason":"no"}`;
				expect(((await pi.emit("input", { type: "input", text: idless, source: "rpc" }, ctx)) as { action: string }).action).toBe("transform");
				expect(pi.entries.some((e) => e.customType === "jev-deferred" && (e.data as { state: string; requestId: string }).state === "settled" && (e.data as { requestId: string }).requestId === sent[0])).toBe(true);

				// On restore: an expired ask from an earlier process is settled, not restored.
				const session = pi.entries
					.filter((e) => !(e.customType === "jev-deferred" && (e.data as { state: string }).state === "settled"))
					.map((entry) => ({ type: "custom", ...entry }));
				const next = fakePi(exec);
				jevExtension(next.api);
				const ctx2 = fakeContext(fakeRegistry(() => ({ answers: gateAnswers({ destructive: 0.99, impact: 3 }) })), { mode: "tui" });
				ctx2.cwd = ctx.cwd;
				ctx2.sessionManager.getEntries = () => session;
				await next.emit("session_start", { reason: "resume" }, ctx2);
				expect(next.entries.some((e) => e.customType === "jev-deferred" && (e.data as { requestId: string }).requestId === sent[0])).toBe(true);
			} finally {
				Date.now = realNow;
			}
		});

		test("jev_escalate returns at once and the reply becomes a note", async () => {
			const { pi, ctx, sent } = await traycerSetup();
			const tool = pi.tools.get("jev_escalate");
			const result = await tool.execute("t", { question: "May I drop the staging DB?", action: "psql -c 'drop database staging'" }, undefined, undefined, ctx);
			expect(result.content[0].text).toContain(`jev_escalate: asked lead-1, request ${sent[0]}. End your turn now`);
			const note = (await pi.emit("input", { type: "input", text: `${header}{"id":"${sent[0]}","decision":"deny","reason":"not today"}`, source: "rpc" }, ctx)) as { text: string };
			expect(note.text).toBe(`[pi-jev] lead-1 denied your jev_escalate request ${sent[0]}: not today. Do not take the action; adjust the plan or ask the user.`);
		});
	});

	test("sibling identical calls share one escalation", async () => {
		configure({ gate: { mode: "escalate" } });
		const pi = fakePi();
		let resolveInput: (value: string) => void = () => undefined;
		const { ctx } = await start(pi, { mode: "rpc", input: () => new Promise((resolve) => (resolveInput = resolve)) });
		const first = pi.emit("tool_call", destructiveCall, ctx);
		const second = pi.emit("tool_call", { ...destructiveCall, toolCallId: "call-2" }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		resolveInput("approve");
		expect(await first).toBeUndefined();
		expect(await second).toBeUndefined();
		expect(ctx.inputs).toHaveLength(1);
	});
});

describe("output judge and tools", () => {
	test("leak notice rides on the tool result", async () => {
		const pi = fakePi();
		const { ctx } = await start(pi, {}, fakeRegistry(() => ({ answers: outputAnswers(0.97) })));
		const result = (await pi.emit(
			"tool_result",
			{ toolName: "bash", toolCallId: "c", input: { command: "cat .env" }, content: [{ type: "text", text: "OPENAI_API_KEY=sk-..." }], isError: false },
			ctx,
		)) as { content: { text: string }[] };
		expect(result.content.at(-1)?.text).toContain("[pi-jev] Jev flagged this output as containing a secret");
	});

	test("jev_ask wraps text state and accepts bool/noul", async () => {
		const pi = fakePi();
		const registry = fakeRegistry(() => ({ answers: { relevant: { type: "bool", probability: 0.8 } } }));
		const { ctx } = await start(pi, {}, registry);
		const tool = pi.tools.get("jev_ask");
		const result = await tool.execute(
			"t",
			{ state: "some text", questions: [{ id: "relevant", type: "noul", instructions: "Is it relevant?" }] },
			undefined,
			undefined,
			ctx,
		);
		expect(result.details.ok).toBe(true);
		expect(result.content[0].text).toContain("relevant: yes 0.80");
		expect(registry.calls.at(-1)?.state).toEqual({ text: "some text" });
	});

	test("jev_escalate returns the orchestrator's decision", async () => {
		const pi = fakePi();
		const { ctx } = await start(pi, { mode: "rpc", input: async () => '{"decision":"approve","reason":"go ahead"}' });
		const tool = pi.tools.get("jev_escalate");
		const result = await tool.execute("t", { question: "May I drop the staging DB?", action: "psql -c 'drop database staging'" }, undefined, undefined, ctx);
		expect(result.content[0].text).toBe("jev_escalate: approved by pi parent: go ahead.");
		expect(JSON.parse(ctx.inputs[0]?.placeholder ?? "{}").source).toBe("agent");
	});
});
