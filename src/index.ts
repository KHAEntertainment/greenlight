import { createHash, randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	authHint,
	classify,
	describeAnswer,
	hasClassifierRuntime,
	isCalibratedModel,
	usesBuiltInDefinition,
	JevError,
	parseModelSpec,
	redact,
	rememberSecret,
	resolveModel,
	type ClassifierRegistry,
	type JevQuestion,
	type JevResponse,
	type JevState,
} from "./classifier";
import {
	GATE_MODES,
	loadJevConfig,
	readSecretFile,
	type GateMode,
	type JevConfig,
	type LoadedJevConfig,
} from "./config";
import {
	describeOutcome,
	ESCALATION_SCHEMA,
	escalate,
	newRequestId,
	resolveTransport,
	scrubSecrets,
	type EscalationOutcome,
	type EscalationRequest,
	type Escalator,
} from "./escalation";
import { a2aEscalator } from "./escalators/a2a";
import { piRpcEscalator } from "./escalators/pi-rpc";
import { createReplyInbox, type ReplyMatch, traycerEscalator } from "./escalators/traycer";
import {
	buildGateState,
	describeAnswers,
	evaluateGate,
	GATE_QUESTIONS,
	judgmentKey,
	summarizeArguments,
	summarizeVerdict,
	type GateVerdict,
} from "./gate";
import {
	buildOutputState,
	evaluateOutput,
	OUTPUT_QUESTIONS,
	outputKey,
	type OutputVerdict,
} from "./output";
import {
	capped,
	describeRecord,
	escalationRecord,
	gateRecord,
	JOURNAL_CAP,
	JOURNAL_TAIL,
	newest as newestRecord,
	outputRecord,
	recordsFromEntries,
	recordClock,
	writeRecord,
	type JournalRecord,
} from "./journal";

/**
 * pi-jev - a System One classifier (TypeSafe Jev by default) as a decision
 * layer for pi. The classifier is whatever `model` names, served by whichever
 * provider pi routes it to: TypeSafe, OpenRouter, Cloudflare Workers AI,
 * Vercel AI Gateway, OpenCode, or a custom provider.
 *
 * Four jobs, all decided by typed questions rather than by prompt text:
 *
 *   1. Gate. Before a mutating tool runs, ask Jev whether the action is
 *      destructive, exfiltrating, or outside scope, plus how reversible it is.
 *      Shadow mode (default) reports. Enforce mode asks the user to confirm.
 *      Escalate mode asks the orchestrator managing this agent (Pi parent over
 *      RPC, Traycer, A2A) and waits for its decision.
 *   2. Output judge. After a tool runs, ask whether its output carries a
 *      secret and what kind of failure it reports. Never blocks; it appends a
 *      line to the tool result the model reads.
 *   3. jev_ask. A model-facing tool for decisions that should be typed and
 *      calibrated instead of written: classification, relevance, yes/no checks.
 *
 * Fails open. An API outage must never stop the agent from working, so every
 * error path returns "no verdict" instead of a block.
 */

const STATUS_KEY = "jev";
const ESCALATE_TOOL = "jev_escalate";
/** Deferred-escalation key prefix for jev_escalate requests. */
const AGENT_KEY = "agent:";
/**
 * Session entries for requests still waiting on a deferred transport. Pi
 * may run each turn in a new process (Traycer does), and the reply arrives
 * in the next turn, so the wait has to outlive the process. Only the wait
 * is stored, never a decision: a decision is taken from the reply itself.
 */
const DEFERRED_TYPE = "jev-deferred";
const DEFERRED_RESTORE_LIMIT = 50;

type DeferredData =
	| { state: "pending"; requestId: string; slot: string; nonce: string; toolName: string; to: string; sentAt: number; deadline: number; viaHuman: boolean }
	| { state: "settled"; requestId: string };

function slotOf(key: string): string {
	return createHash("sha256").update(key).digest("hex");
}

/**
 * A deferred request's id, bound to the call it is about. The parent decides
 * on this id after seeing that call; a hand-edited session entry pairing the
 * id with another call's slot fails the check on restore.
 */
function boundRequestId(slot: string, nonce: string): string {
	const hex = createHash("sha256").update(`${slot}:${nonce}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function parseDeferredData(value: unknown): DeferredData | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const requestId = Reflect.get(value, "requestId");
	if (typeof requestId !== "string" || !requestId) return undefined;
	const state = Reflect.get(value, "state");
	if (state === "settled") return { state, requestId };
	if (state !== "pending") return undefined;
	const slot = Reflect.get(value, "slot");
	const nonce = Reflect.get(value, "nonce");
	const toolName = Reflect.get(value, "toolName");
	const to = Reflect.get(value, "to");
	const sentAt = Reflect.get(value, "sentAt");
	const deadline = Reflect.get(value, "deadline");
	if (typeof slot !== "string" || typeof nonce !== "string" || typeof toolName !== "string" || typeof to !== "string" || !to) return undefined;
	if (typeof sentAt !== "number" || typeof deadline !== "number") return undefined;
	if (boundRequestId(slot, nonce) !== requestId) return undefined;
	return { state, requestId, slot, nonce, toolName, to, sentAt, deadline, viaHuman: Reflect.get(value, "viaHuman") === true };
}

/** A request sent over a deferred transport, waiting for or holding its decision. */
interface Deferred {
	/** SHA-256 of the judgment key, so the session never holds the call's text twice. */
	slot: string;
	/** With `slot`, derives `requestId` (`boundRequestId`). */
	nonce: string;
	requestId: string;
	toolName: string;
	transport: string;
	to: string;
	sentAt: number;
	/** Waiting: when the enforce rule takes over. Decided: when the decision goes stale. */
	deadline: number;
	viaHuman: boolean;
	outcome?: EscalationOutcome;
	cancel(): void;
}
const ERROR_NOTIFY_INTERVAL_MS = 60_000;
/** Identical output is judged once per window, keyed by tool and output hash. */
const OUTPUT_CACHE_SECONDS = 120;

const QuestionParam = Type.Object({
	id: Type.String({
		description: "Short key for this question. The answer comes back under it.",
	}),
	type: StringEnum(["bool", "noul", "choice", "score"] as const, {
		description:
			"bool (or noul) = yes/no probability, choice = pick one option, score = value on a rubric",
	}),
	instructions: Type.String({
		description:
			"The one thing to judge. One specific, well-scoped gut-check per question.",
	}),
	options: Type.Optional(
		Type.Array(
			Type.Object({
				name: Type.String({ description: "Option key" }),
				description: Type.Optional(
					Type.String({ description: "When this option applies" }),
				),
			}),
			{ description: "choice only: the options to choose between" },
		),
	),
	levels: Type.Optional(
		Type.Array(Type.String(), {
			description: "score only: ordered rubric levels, lowest first, at least two",
		}),
	),
});

const EscalateParams = Type.Object({
	question: Type.String({
		description:
			"The decision you need from your orchestrator, in one or two sentences.",
	}),
	action: Type.Optional(
		Type.String({
			description:
				"The action you intend to take if approved, e.g. the command or file.",
		}),
	),
});

const AskParams = Type.Object({
	state: Type.String({
		description:
			"The text to judge: tool output, a diff, a message, a document excerpt.",
	}),
	questions: Type.Array(QuestionParam, {
		description:
			"One or more questions. All are evaluated in parallel against the same state.",
	}),
});

/** Returned instead of an outcome when a request cannot leave safely. */
const UNSAFE = "unsafe";
const UNSAFE_REASON = "a credential in it is mixed with shell syntax or a private key, so it can be neither sent nor redacted safely";

export default function jevExtension(pi: ExtensionAPI): void {
	let loaded: LoadedJevConfig = loadJevConfig(process.cwd());
	let config: JevConfig = loaded.config;
	rememberSecret(config.apiKey);

	let gateOn = config.gate.enabled;
	let outputOn = config.output.enabled;
	let mode: GateMode = config.gate.mode;
	/**
	 * Why the judges are inactive, or undefined when they can run: no
	 * classifier runtime on this host, a model the catalog does not know, or a
	 * provider with no credentials. Set at session_start.
	 */
	let inactive: string | undefined = "not started";

	const cache = new Map<string, { at: number; verdict: GateVerdict }>();
	const inflight = new Map<string, Promise<GateVerdict | undefined>>();
	const outputCache = new Map<string, { at: number; verdict: OutputVerdict }>();
	const outputInflight = new Map<string, Promise<OutputVerdict | undefined>>();
	/** One orchestrator question per identical pending call, shared by siblings. */
	const escalations = new Map<string, Promise<EscalationOutcome | typeof UNSAFE | undefined>>();
	/**
	 * Escalations over a deferred transport (Traycer), by judgment key, or
	 * `agent:<request id>` for jev_escalate. The request is sent and the call
	 * blocked; the decision comes with a later prompt and is kept for one
	 * retry of that exact call.
	 */
	const deferred = new Map<string, Deferred>();
	const deferredSends = new Map<string, Promise<Deferred | typeof UNSAFE | undefined>>();
	/** Decision notes pi queued during a run, until they start a user message. */
	const queuedNotes = new Set<string>();
	/**
	 * `/jev last` and `/jev output` read these; they are journal records rather
	 * than live verdicts so a rehydrated session renders the same text as a live
	 * one. `journal` holds the records written this session (or reloaded from it).
	 */
	let last: JournalRecord | undefined;
	let lastOutput: JournalRecord | undefined;
	let journal: JournalRecord[] = [];
	let lastErrorAt = 0;
	const warnedOnce = new Set<string>();

	/** Traycer delivers the parent's decision as chat input; see `createReplyInbox`. */
	const traycerReplies = createReplyInbox();

	function reload(cwd: string): void {
		loaded = loadJevConfig(cwd);
		config = loaded.config;
		rememberSecret(config.apiKey);
		gateOn = config.gate.enabled;
		outputOn = config.output.enabled;
		mode = config.gate.mode;
	}

	/** Persist a record and keep it in memory. Writing must never break a call. */
	function remember(record: JournalRecord): void {
		journal = capped([...journal, record]);
		writeRecord(pi, record);
	}

	/** Session entries are hand-editable, so a bad read yields an empty journal. */
	function readJournal(ctx: ExtensionContext): JournalRecord[] {
		try {
			return recordsFromEntries(ctx.sessionManager.getEntries());
		} catch {
			return [];
		}
	}

	function warnOnce(ctx: ExtensionContext, key: string, message: string): void {
		if (warnedOnce.has(key)) return;
		warnedOnce.add(key);
		ctx.ui.notify(message, "warning");
	}

	function registryOf(ctx: ExtensionContext): ClassifierRegistry | undefined {
		const registry: unknown = ctx.modelRegistry;
		return hasClassifierRuntime(registry) ? registry : undefined;
	}

	/** Why the judges cannot run with this host and config, or undefined. */
	function checkReady(ctx: ExtensionContext): string | undefined {
		const registry = registryOf(ctx);
		if (!registry) {
			return "this host has no classifier runtime (pi 0.99 or later is required)";
		}
		if (!resolveModel(registry, config.model)) {
			return `classifier ${config.model} is not in the model catalog (check the provider/id spelling, or add it in models.json)`;
		}
		if (config.apiKey) return undefined;
		const { provider } = parseModelSpec(config.model);
		const status = registry.getProviderAuthStatus?.(provider);
		if (status && !status.configured) {
			return `no credentials for ${provider}: ${authHint(provider)}`;
		}
		return undefined;
	}

	function statusText(): string {
		return `jev: ${gateOn ? mode : "off"}${outputOn ? "" : " (out off)"}`;
	}

	/** One classifier request with this session's model, timeout, and key override. */
	async function ask(
		ctx: ExtensionContext,
		state: JevState,
		questions: Record<string, JevQuestion>,
		signal: AbortSignal | undefined,
	): Promise<JevResponse> {
		const registry = registryOf(ctx);
		if (!registry) throw new JevError("no classifier runtime on this host");
		return classify(registry, {
			state,
			questions,
			model: config.model,
			timeoutMs: config.timeoutMs,
			retries: config.retries,
			apiKey: config.apiKey,
			signal,
		});
	}

	/** The escalator for this process, or undefined when none applies. */
	function escalatorFor(ctx: ExtensionContext): Escalator | undefined {
		const transport = resolveTransport(config.escalation, {
			mode: ctx.mode,
			env: process.env,
		});
		switch (transport) {
			case "traycer":
				return traycerEscalator(
					(command, args, options) => pi.exec(command, args, options),
					{
						command: config.escalation.traycer.command,
						parentAgentId: config.escalation.traycer.parentAgentId,
						pollMs: config.escalation.pollMs,
						env: process.env,
						replies: traycerReplies,
					},
				);
			case "a2a": {
				const url = config.escalation.a2a.url;
				if (!url) return undefined;
				const { tokenEnv, tokenFile } = config.escalation.a2a;
				const token =
					(tokenEnv ? process.env[tokenEnv]?.trim() : undefined) ||
					(tokenFile ? readSecretFile(tokenFile) : undefined);
				rememberSecret(token);
				return a2aEscalator({ url, token, pollMs: config.escalation.pollMs });
			}
			case "pi-rpc":
				return ctx.hasUI ? piRpcEscalator(ctx.ui) : undefined;
			default:
				return undefined;
		}
	}

	/** jev_escalate is declared to the model only when an orchestrator exists. */
	function syncEscalateTool(ctx: ExtensionContext): void {
		try {
			const active = pi.getActiveTools();
			const want = escalatorFor(ctx) !== undefined;
			const has = active.includes(ESCALATE_TOOL);
			if (want && !has) pi.setActiveTools([...active, ESCALATE_TOOL]);
			if (!want && has) pi.setActiveTools(active.filter((name) => name !== ESCALATE_TOOL));
		} catch {
			// Tool activation is a convenience; never let it break session start.
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		reload(ctx.cwd);
		// A reload, resume, or fork rebuilds this closure from nothing, so the
		// session's own entries are the only record of what already fired.
		journal = readJournal(ctx);
		await restoreDeferred(ctx);
		last = newestRecord(journal, "gate");
		lastOutput = newestRecord(journal, "output");
		for (const warning of loaded.warnings) {
			ctx.ui.notify(`pi-jev: ${redact(warning)}`, "warning");
		}
		inactive = checkReady(ctx);
		syncEscalateTool(ctx);
		if (inactive) {
			warnOnce(ctx, inactive, `pi-jev: ${inactive}; the judges are inactive until then.`);
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const registry = registryOf(ctx);
		if (registry && usesBuiltInDefinition(registry, config.model)) {
			warnOnce(
				ctx,
				`built-in:${config.model}`,
				`pi-jev: ${config.model} is missing from pi's model catalog; using pi-jev's built-in definition for it.`,
			);
		}
		if (mode !== "shadow" && !isCalibratedModel(config.model)) {
			warnOnce(
				ctx,
				`uncalibrated:${config.model}`,
				`pi-jev: ${config.model} is not a Jev model; the thresholds were measured on Jev, so it may flag too much or too little. Run \`npm run calibrate -- --model ${config.model}\` before relying on ${mode}.`,
			);
		}
		if (mode === "escalate" && !escalatorFor(ctx)) {
			warnOnce(
				ctx,
				"no-transport",
				"pi-jev: escalate mode has no orchestrator here (no Traycer env, no escalation.a2a.url, not in RPC mode); flagged calls use the enforce rule.",
			);
		}
		ctx.ui.setStatus(STATUS_KEY, statusText());
	});

	// A decision on a pending escalation is the gate's: the gate records it,
	// and the model reads a note saying what to do, never the raw reply.
	pi.on("input", (event) => {
		const match = traycerReplies.offer(event.text);
		if (!match) return { action: "continue" };
		const note = replyNote(match);
		if (event.streamingBehavior) queuedNotes.add(note);
		return { action: "transform", text: note };
	});

	// Pi checks its queue once before a run settles. A note queued after that
	// check (Traycer delivers as soon as the last message ends) never becomes
	// a turn, and the agent would sit idle with its decision unread.
	pi.on("message_start", (event) => {
		if (event.message.role === "user") queuedNotes.delete(messageText(event.message.content) ?? "");
	});
	pi.on("agent_settled", (event) => {
		if (event.aborted || queuedNotes.size === 0) return;
		const notes = [...queuedNotes].join("\n\n");
		queuedNotes.clear();
		try {
			pi.sendUserMessage(notes);
		} catch {
			// The decision is still recorded; the agent sees it on its next turn.
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!gateOn || inactive) return;
		if (!config.gate.tools.includes(event.toolName)) return;

		const key = judgmentKey(event.toolName, event.input);
		const verdict = await verdictFor(key, event, ctx);
		if (!verdict) return;

		last = gateRecord(event.toolName, verdict, Date.now());
		ctx.ui.setStatus(
			STATUS_KEY,
			verdict.flagged
				? `jev: ${summarizeVerdict(verdict)}`
				: `jev: clear (${mode})`,
		);
		if (!verdict.flagged) return;
		// A clear call is not journaled: the flag is the record worth keeping.
		remember(last);

		const reason = `pi-jev: ${summarizeVerdict(verdict)}`;
		if (mode === "shadow") {
			ctx.ui.notify(
				`jev shadow: ${event.toolName} - ${summarizeVerdict(verdict)}`,
				"warning",
			);
			return;
		}
		if (mode === "escalate") {
			const escalator = escalatorFor(ctx);
			if (escalator?.send) {
				return deferredDecision(key, event, verdict, reason, escalator.send.bind(escalator), escalator.name, ctx);
			}
			const outcome = await escalationFor(key, event, verdict, ctx);
			if (outcome === UNSAFE) {
				// Not an outage: the call itself carries a credential mixed with
				// shell syntax, which the agent controls. Falling open headless
				// would let it skip the orchestrator at will, so headless blocks.
				return localDecision(event.toolName, verdict, `${reason} (not escalated: ${UNSAFE_REASON})`, ctx, true);
			}
			if (outcome) {
				if (outcome.decision === "approve") {
					ctx.ui.notify(
						`jev: ${event.toolName} ${describeOutcome(outcome)}`,
						"info",
					);
					return;
				}
				return { block: true, reason: `${reason} (${describeOutcome(outcome)})` };
			}
			// No answer from the orchestrator: the enforce rule below decides.
		}
		return localDecision(event.toolName, verdict, reason, ctx);
	});

	/** The enforce rule: ask the local user, or apply blockWithoutUI headless. */
	async function localDecision(
		toolName: string,
		verdict: GateVerdict,
		reason: string,
		ctx: ExtensionContext,
		blockHeadless = config.gate.blockWithoutUI,
	): Promise<{ block: true; reason: string } | undefined> {
		if (!ctx.hasUI) {
			if (blockHeadless) return { block: true, reason };
			// No UI means no way to approve a flagged call. Degrade to shadow
			// rather than deadlocking a headless run on a classifier's opinion.
			ctx.ui.notify(
				`jev: ${toolName} - ${summarizeVerdict(verdict)} (headless: not blocking; set gate.blockWithoutUI to block)`,
				"warning",
			);
			return undefined;
		}
		const allow = await ctx.ui.confirm(
			"Jev flagged this tool call",
			`${toolName}\n${summarizeVerdict(verdict)}\n\nRun it anyway?`,
		);
		return allow ? undefined : { block: true, reason: `${reason} (declined)` };
	}

	/**
	 * Ask the orchestrator about a flagged call. Identical sibling calls share
	 * one request; a decision is not cached past it, because an approval is
	 * for this call, not for every later call that looks the same.
	 */
	async function escalationFor(
		key: string,
		event: { toolName: string; input: unknown },
		verdict: GateVerdict,
		ctx: ExtensionContext,
	): Promise<EscalationOutcome | typeof UNSAFE | undefined> {
		const pending = escalations.get(key);
		if (pending) return pending;
		const promise = runEscalation(
			gateRequest(event, verdict, ctx),
			event.toolName,
			ctx,
			ctx.signal,
		).finally(() => escalations.delete(key));
		escalations.set(key, promise);
		return promise;
	}

	/**
	 * Escalate mode over a deferred transport. The first flagged call sends
	 * the request and is blocked while the orchestrator decides; the turn
	 * ends, the decision arrives as the next prompt, and a retry of the same
	 * call uses it once. No answer in time falls back to the enforce rule.
	 */
	async function deferredDecision(
		key: string,
		event: { toolName: string; input: unknown },
		verdict: GateVerdict,
		reason: string,
		send: NonNullable<Escalator["send"]>,
		transport: string,
		ctx: ExtensionContext,
	): Promise<{ block: true; reason: string } | undefined> {
		const now = Date.now();
		const slot = slotOf(key);
		const entry = deferred.get(slot);
		if (entry?.outcome) {
			deferred.delete(slot);
			if (now <= entry.deadline) {
				if (entry.outcome.decision === "approve") {
					ctx.ui.notify(`jev: ${event.toolName} ${describeOutcome(entry.outcome)}`, "info");
					return undefined;
				}
				return { block: true, reason: `${reason} (${describeOutcome(entry.outcome)})` };
			}
			// A decision nobody used in time is stale: ask again.
		} else if (entry && now < entry.deadline) {
			return { block: true, reason: `${reason} (${waitingText(entry)})` };
		} else if (entry) {
			// No answer in time: the enforce rule decides, as for any transport.
			entry.cancel();
			deferred.delete(slot);
			writeDeferred({ state: "settled", requestId: entry.requestId });
			remember(
				escalationRecord(
					event.toolName,
					{ fallback: "escalation timed out", transport: entry.transport, latencyMs: now - entry.sentAt },
					now,
				),
			);
			ctx.ui.setStatus(STATUS_KEY, statusText());
			return localDecision(event.toolName, verdict, reason, ctx);
		}
		let inflight = deferredSends.get(key);
		if (!inflight) {
			inflight = sendDeferred(gateRequest(event, verdict, ctx), event.toolName, key, send, transport, ctx).finally(() =>
				deferredSends.delete(key),
			);
			deferredSends.set(key, inflight);
		}
		const sent = await inflight;
		if (sent === UNSAFE) {
			// Same rule as an in-turn escalation: headless blocks (see tool_call).
			return localDecision(event.toolName, verdict, `${reason} (not escalated: ${UNSAFE_REASON})`, ctx, true);
		}
		if (!sent) return localDecision(event.toolName, verdict, reason, ctx);
		return { block: true, reason: `${reason} (${waitingText(sent)})` };
	}

	function waitingText(entry: Deferred): string {
		return `asked ${entry.to} for a decision, request ${entry.requestId}. End your turn now and wait: the decision arrives as your next message. Retry this exact call only if it is approved`;
	}

	/** Send over a deferred transport and record what to expect back. */
	async function sendDeferred(
		request: EscalationRequest,
		toolName: string,
		key: string,
		send: NonNullable<Escalator["send"]>,
		transport: string,
		ctx: ExtensionContext,
	): Promise<Deferred | typeof UNSAFE | undefined> {
		settleExpiredAsks();
		const slot = slotOf(key);
		const nonce = randomUUID();
		const scrubbed = scrubSecrets({ ...request, id: boundRequestId(slot, nonce) }, redact);
		if (scrubbed.unsafe) {
			remember(escalationRecord(toolName, { fallback: UNSAFE_REASON, transport, latencyMs: 0 }, Date.now()));
			ctx.ui.notify(`jev: ${toolName} not escalated: ${UNSAFE_REASON}`, "warning");
			return UNSAFE;
		}
		if (scrubbed.redacted) scrubbed.value.redacted = true;
		const started = Date.now();
		try {
			const { to } = await send(scrubbed.value, ctx.signal);
			const entry: Deferred = {
				slot,
				nonce,
				requestId: scrubbed.value.id,
				toolName,
				transport,
				to,
				sentAt: started,
				deadline: Date.now() + config.escalation.timeoutSeconds * 1000,
				viaHuman: false,
				cancel: () => undefined,
			};
			trackDeferred(entry);
			persistDeferred(entry);
			ctx.ui.setStatus(STATUS_KEY, `jev: waiting on ${transport}`);
			return entry;
		} catch (error) {
			const message = redact(error instanceof Error ? error.message : String(error));
			remember(escalationRecord(toolName, { fallback: message, transport, latencyMs: Date.now() - started }, Date.now()));
			ctx.ui.setStatus(STATUS_KEY, statusText());
			notifyError(ctx, new Error(`escalation over ${transport}: ${message}; using the local rule`));
			return undefined;
		}
	}

	/** Wait for the reply to `entry`, and record the decision when it comes. */
	function trackDeferred(entry: Deferred): void {
		const waiting = traycerReplies.expect(entry.requestId, entry.to, () => {
			entry.viaHuman = true;
			entry.deadline = Math.max(entry.deadline, Date.now() + config.escalation.humanTimeoutSeconds * 1000);
			persistDeferred(entry);
		});
		entry.cancel = waiting.cancel;
		void waiting.promise.then((decision) => {
			const outcome: EscalationOutcome = {
				decision: decision.decision,
				reason: decision.reason,
				by: decision.by,
				transport: entry.transport,
				viaHuman: entry.viaHuman,
				latencyMs: Date.now() - entry.sentAt,
			};
			entry.outcome = outcome;
			// The retry that uses the decision has the escalation timeout to come.
			entry.deadline = Date.now() + config.escalation.timeoutSeconds * 1000;
			remember(escalationRecord(entry.toolName, outcome, Date.now()));
			writeDeferred({ state: "settled", requestId: entry.requestId });
			if (entry.toolName === ESCALATE_TOOL) deferred.delete(entry.slot);
		});
		deferred.set(entry.slot, entry);
	}

	function persistDeferred(entry: Deferred): void {
		writeDeferred({
			state: "pending",
			requestId: entry.requestId,
			slot: entry.slot,
			nonce: entry.nonce,
			toolName: entry.toolName,
			to: entry.to,
			sentAt: entry.sentAt,
			deadline: entry.deadline,
			viaHuman: entry.viaHuman,
		});
	}

	/** Fail open like the journal: an unwritable session only loses the wait. */
	function writeDeferred(data: DeferredData): void {
		try {
			pi.appendEntry(DEFERRED_TYPE, data);
		} catch {
			// The next retry then asks again.
		}
	}

	/**
	 * Pick up requests a previous process left waiting. Session entries are
	 * hand-editable, so an entry is restored only when its recipient is the
	 * parent this agent has now: a forged entry cannot name another sender.
	 */
	async function restoreDeferred(ctx: ExtensionContext): Promise<void> {
		if (mode !== "escalate") return;
		const waiting = new Map<string, Extract<DeferredData, { state: "pending" }>>();
		try {
			for (const entry of ctx.sessionManager.getEntries()) {
				if (typeof entry !== "object" || entry === null) continue;
				if (Reflect.get(entry, "type") !== "custom" || Reflect.get(entry, "customType") !== DEFERRED_TYPE) continue;
				const data = parseDeferredData(Reflect.get(entry, "data"));
				if (!data) continue;
				if (data.state === "settled") waiting.delete(data.requestId);
				else waiting.set(data.requestId, data);
			}
		} catch {
			return;
		}
		if (waiting.size === 0) return;
		const escalator = escalatorFor(ctx);
		if (!escalator?.send || !escalator.recipient) return;
		let parent: string;
		try {
			parent = await escalator.recipient(ctx.signal);
		} catch {
			return;
		}
		for (const data of [...waiting.values()].slice(-DEFERRED_RESTORE_LIMIT)) {
			if (data.to !== parent || deferred.has(data.slot)) continue;
			// No retry ever settles a jev_escalate wait, so an expired one would linger.
			if (data.toolName === ESCALATE_TOOL && Date.now() >= data.deadline) {
				writeDeferred({ state: "settled", requestId: data.requestId });
				continue;
			}
			trackDeferred({ ...data, transport: escalator.name, cancel: () => undefined });
		}
	}

	/**
	 * Drop jev_escalate waits past their deadline. A gate wait is settled by
	 * the retry that finds it expired; nothing retries a jev_escalate, and a
	 * stale wait would count as pending, so an id-less reply to a live
	 * request would see two candidates and be refused.
	 */
	function settleExpiredAsks(): void {
		const now = Date.now();
		for (const entry of [...deferred.values()]) {
			if (entry.toolName !== ESCALATE_TOOL || entry.outcome || now < entry.deadline) continue;
			entry.cancel();
			deferred.delete(entry.slot);
			writeDeferred({ state: "settled", requestId: entry.requestId });
		}
	}

	/** What the model reads in place of the orchestrator's raw reply. */
	function replyNote(match: ReplyMatch): string {
		const entry = [...deferred.values()].find((pending) => pending.requestId === match.requestId);
		const { decision, by } = match.decision;
		const why = match.decision.reason ? `: ${match.decision.reason}` : "";
		if (entry?.toolName === ESCALATE_TOOL) {
			if (decision === "escalate") {
				return `[pi-jev] ${by} passed your jev_escalate request ${match.requestId} to a human. End your turn and wait; the decision comes as a later message.`;
			}
			return `[pi-jev] ${by} ${decision === "approve" ? "approved" : "denied"} your jev_escalate request ${match.requestId}${why}.${decision === "deny" ? " Do not take the action; adjust the plan or ask the user." : ""}`;
		}
		const call = entry ? `the flagged \`${entry.toolName}\` call` : `escalation ${match.requestId}`;
		if (decision === "escalate") {
			return `[pi-jev] ${by} passed ${call} to a human. End your turn and wait; the decision comes as a later message.`;
		}
		if (decision === "approve") {
			return `[pi-jev] ${by} approved ${call}${why}. Retry that exact call now; a changed call needs a new decision.`;
		}
		return `[pi-jev] ${by} denied ${call}${why}. Do not retry it; adjust the plan or ask the user.`;
	}

	/**
	 * Escalate and journal the outcome; undefined means fall back locally.
	 * UNSAFE means the request was not sent because it holds a credential that
	 * can be neither sent nor redacted without hiding code.
	 */
	async function runEscalation(
		request: EscalationRequest,
		toolName: string,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
	): Promise<EscalationOutcome | typeof UNSAFE | undefined> {
		const escalator = escalatorFor(ctx);
		if (!escalator) return undefined;
		const started = Date.now();
		// The request leaves this process (another agent, a CLI's argv, a
		// remote A2A server), so credentials in arguments stay behind.
		const scrubbed = scrubSecrets(request, redact);
		if (scrubbed.unsafe) {
			remember(
				escalationRecord(
					toolName,
					{ fallback: UNSAFE_REASON, transport: escalator.name, latencyMs: 0 },
					Date.now(),
				),
			);
			ctx.ui.notify(`jev: ${toolName} not escalated: ${UNSAFE_REASON}`, "warning");
			return UNSAFE;
		}
		if (scrubbed.redacted) scrubbed.value.redacted = true;
		ctx.ui.setStatus(STATUS_KEY, `jev: waiting on ${escalator.name}`);
		try {
			const outcome = await escalate(escalator, scrubbed.value, config.escalation, {
				signal,
				onEscalated: () => {
					ctx.ui.setStatus(STATUS_KEY, `jev: ${escalator.name} escalated to a human`);
					ctx.ui.notify(
						`jev: ${toolName} escalated to a human by the orchestrator; waiting`,
						"info",
					);
				},
			});
			remember(escalationRecord(toolName, outcome, Date.now()));
			ctx.ui.setStatus(STATUS_KEY, statusText());
			return outcome;
		} catch (error) {
			const message = redact(error instanceof Error ? error.message : String(error));
			remember(
				escalationRecord(
					toolName,
					{ fallback: message, transport: escalator.name, latencyMs: Date.now() - started },
					Date.now(),
				),
			);
			ctx.ui.setStatus(STATUS_KEY, statusText());
			notifyError(ctx, new Error(`escalation over ${escalator.name}: ${message}; using the local rule`));
			return undefined;
		}
	}

	function gateRequest(
		event: { toolName: string; input: unknown },
		verdict: GateVerdict,
		ctx: ExtensionContext,
	): EscalationRequest {
		return {
			schema: ESCALATION_SCHEMA,
			id: newRequestId(),
			source: "gate",
			tool: event.toolName,
			arguments: summarizeArguments(event.input, config.gate.argumentChars),
			verdict: {
				summary: summarizeVerdict(verdict),
				reasons: verdict.reasons,
				scores: {
					destructive: verdict.destructive,
					exfiltration: verdict.exfiltration,
					beyond_scope: verdict.beyondScope,
					impact: verdict.impact,
				},
				model: verdict.model,
			},
			userRequest: truncateUser(lastUserRequest(ctx)),
			cwd: ctx.cwd,
			at: Date.now(),
		};
	}

	pi.on("tool_result", async (event, ctx) => {
		if (!outputOn || inactive) return;
		if (!config.output.tools.includes(event.toolName)) return;
		if (event.parentToolCallId) return;
		const text = contentText(event.content);
		if (!text.trim()) return;

		const verdict = await outputVerdictFor(
			outputKey(event.toolName, text),
			{
				toolName: event.toolName,
				input: event.input,
				output: text,
				isError: event.isError,
			},
			ctx,
		);
		if (!verdict?.notice) return;

		lastOutput = outputRecord(event.toolName, verdict, Date.now());
		remember(lastOutput);
		ctx.ui.setStatus(STATUS_KEY, `jev: ${verdict.kind} (${event.toolName})`);
		if (verdict.kind === "leak") {
			ctx.ui.notify(
				`jev: ${event.toolName} output may carry a secret (${verdict.leaksSecret.toFixed(2)})`,
				"warning",
			);
		}
		// The model reads the tool result, so the notice rides with it.
		return {
			content: [
				...event.content,
				{ type: "text" as const, text: `[pi-jev] ${verdict.notice}` },
			],
			structuredContent: event.structuredContent,
		};
	});

	async function outputVerdictFor(
		key: string,
		event: { toolName: string; input: unknown; output: string; isError: boolean },
		ctx: ExtensionContext,
	): Promise<OutputVerdict | undefined> {
		const cached = outputCache.get(key);
		if (
			cached &&
			(Date.now() - cached.at) / 1000 <= OUTPUT_CACHE_SECONDS
		) {
			return cached.verdict;
		}
		const pending = outputInflight.get(key);
		if (pending) return pending;

		const promise = judgeOutput(event, ctx).finally(() =>
			outputInflight.delete(key),
		);
		outputInflight.set(key, promise);
		const verdict = await promise;
		if (verdict) {
			outputCache.set(key, { at: Date.now(), verdict });
			if (outputCache.size > 64) outputCache.clear();
		}
		return verdict;
	}

	async function judgeOutput(
		event: { toolName: string; input: unknown; output: string; isError: boolean },
		ctx: ExtensionContext,
	): Promise<OutputVerdict | undefined> {
		try {
			const response = await ask(
				ctx,
				buildOutputState({
					cwd: ctx.cwd,
					toolName: event.toolName,
					input: event.input,
					output: event.output,
					isError: event.isError,
					argumentChars: config.gate.argumentChars,
					outputChars: config.output.outputChars,
				}),
				OUTPUT_QUESTIONS,
				ctx.signal,
			);
			return evaluateOutput(response, config);
		} catch (error) {
			notifyError(ctx, error);
			return undefined;
		}
	}

	async function verdictFor(
		key: string,
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	): Promise<GateVerdict | undefined> {
		const cached = cache.get(key);
		if (
			cached &&
			(Date.now() - cached.at) / 1000 <= config.gate.cacheSeconds
		) {
			return cached.verdict;
		}
		const pending = inflight.get(key);
		if (pending) return pending;

		const promise = judge(event, ctx).finally(() => inflight.delete(key));
		inflight.set(key, promise);
		const verdict = await promise;
		if (verdict) {
			cache.set(key, { at: Date.now(), verdict });
			prune();
		}
		return verdict;
	}

	async function judge(
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	): Promise<GateVerdict | undefined> {
		try {
			const response = await ask(
				ctx,
				buildGateState({
					cwd: ctx.cwd,
					toolName: event.toolName,
					input: event.input,
					userRequest: lastUserRequest(ctx),
					argumentChars: config.gate.argumentChars,
				}),
				GATE_QUESTIONS,
				ctx.signal,
			);
			return evaluateGate(response, config);
		} catch (error) {
			notifyError(ctx, error);
			return undefined;
		}
	}

	function notifyError(ctx: ExtensionContext, error: unknown): void {
		const at = Date.now();
		if (at - lastErrorAt < ERROR_NOTIFY_INTERVAL_MS) return;
		lastErrorAt = at;
		ctx.ui.notify(
			`pi-jev: ${redact(error instanceof Error ? error.message : String(error))} (failing open)`,
			"error",
		);
	}

	function prune(): void {
		if (cache.size <= 64) return;
		const cutoff = Date.now() - config.gate.cacheSeconds * 1000;
		for (const [key, entry] of cache) {
			if (entry.at < cutoff) cache.delete(key);
		}
		while (cache.size > 64) {
			const oldest = cache.keys().next().value;
			if (oldest === undefined) break;
			cache.delete(oldest);
		}
	}

	pi.registerCommand("jev", {
		description:
			"pi-jev: status, mode shadow|enforce|escalate, on/off, last verdict, last judged output, journal log, check",
		handler: async (args, ctx) => {
			const [sub, value] = args.trim().toLowerCase().split(/\s+/);
			if (sub === "on" || sub === "off") {
				const on = sub === "on";
				gateOn = on;
				outputOn = on;
				ctx.ui.setStatus(STATUS_KEY, on ? `jev: ${mode}` : "jev: off");
				ctx.ui.notify(`pi-jev: gate ${sub}`, "info");
				return;
			}
			if (sub === "mode") {
				if (!GATE_MODES.includes(value as GateMode)) {
					ctx.ui.notify(
						`pi-jev: mode is ${mode} (usage: /jev mode ${GATE_MODES.join("|")})`,
						"warning",
					);
					return;
				}
				mode = value as GateMode;
				ctx.ui.setStatus(STATUS_KEY, statusText());
				const detail =
					mode === "shadow"
						? "reports, never blocks"
						: mode === "enforce"
							? "asks before running flagged calls"
							: `asks the orchestrator (${escalatorFor(ctx)?.name ?? "none found: enforce rule"})`;
				ctx.ui.notify(`pi-jev: ${mode} (${detail})`, "info");
				return;
			}
			if (sub === "last") {
				if (last?.kind !== "gate") {
					ctx.ui.notify("pi-jev: no verdicts yet", "info");
					return;
				}
				ctx.ui.notify(`pi-jev: ${describeRecord(last)}`, "info");
				return;
			}
			if (sub === "output") {
				if (lastOutput?.kind !== "output") {
					ctx.ui.notify("pi-jev: no tool output judged yet", "info");
					return;
				}
				ctx.ui.notify(`pi-jev output: ${describeRecord(lastOutput)}`, "info");
				return;
			}
			if (sub === "log") {
				if (journal.length === 0) {
					ctx.ui.notify(
						"pi-jev: journal is empty (nothing flagged yet)",
						"info",
					);
					return;
				}
				const shown = journal.slice(-JOURNAL_TAIL);
				const lines = shown.map(
					(record) =>
						`${recordClock(record)} ${record.kind} ${describeRecord(record)}`,
				);
				ctx.ui.notify(
					`pi-jev log: ${shown.length} of ${journal.length} kept (cap ${JOURNAL_CAP})\n${lines.join("\n")}`,
					"info",
				);
				return;
			}
			if (sub === "check") {
				const text = args.trim().slice("check".length).trim();
				if (!text) {
					ctx.ui.notify("pi-jev: usage /jev check <text>", "warning");
					return;
				}
				const why = checkReady(ctx);
				if (why) {
					ctx.ui.notify(`pi-jev: ${why}`, "warning");
					return;
				}
				try {
					const response = await ask(ctx, { text }, GATE_QUESTIONS, ctx.signal);
					const verdict = evaluateGate(response, config);
					// A manual probe, not a field observation, so it is shown but
					// not journaled: the journal is the record of what actually fired.
					last = gateRecord("check", verdict, Date.now());
					ctx.ui.notify(
						`pi-jev check: ${summarizeVerdict(verdict)} | ${describeAnswers(response)}`,
						"info",
					);
				} catch (error) {
					ctx.ui.notify(
						`pi-jev: ${redact(error instanceof Error ? error.message : String(error))}`,
						"error",
					);
				}
				return;
			}

			const { provider } = parseModelSpec(config.model);
			const auth = config.apiKey
				? config.apiKeyFile
					? `apiKeyFile ${config.apiKeyFile}`
					: "apiKey (inline)"
				: describeAuth(registryOf(ctx), provider);
			const transport = resolveTransport(config.escalation, {
				mode: ctx.mode,
				env: process.env,
			});
			ctx.ui.notify(
				`pi-jev: ${inactive ? `inactive (${inactive})` : gateOn ? "on" : "off"}, out ${outputOn ? "on" : "off"}, mode ${mode}, model ${config.model}${isCalibratedModel(config.model) ? "" : " (uncalibrated)"}, auth ${auth}, escalation ${transport}, judging ${config.gate.tools.join("/")}, out tools ${config.output.tools.join("/")}, cache ${cache.size}/${outputCache.size}, journal ${journal.length}`,
				"info",
			);
		},
	});

	pi.registerTool({
		name: ESCALATE_TOOL,
		label: "Escalate",
		description:
			"Ask the orchestrator managing this agent (a Pi parent, Traycer, or an A2A orchestrator) to decide something before you act. Blocks until it approves or denies; it may hand the question to a human first. Over Traycer it returns at once, and the decision arrives as your next message.",
		promptSnippet:
			"Ask your orchestrator to approve or deny an action before you take it",
		promptGuidelines: [
			"Use jev_escalate when an action needs a decision from whoever is managing you (scope changes, irreversible operations, conflicting instructions), not for questions you can answer yourself.",
			"If jev_escalate returns a denial, do not take the action; adjust the plan or ask the user.",
		],
		parameters: EscalateParams,
		defaultActive: false,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const escalator = escalatorFor(ctx);
			if (!escalator) {
				return {
					content: [
						{ type: "text" as const, text: "jev_escalate: no orchestrator is reachable from this session; ask the user instead." },
					],
					details: { ok: false },
				};
			}
			const request: EscalationRequest = {
				schema: ESCALATION_SCHEMA,
				id: newRequestId(),
				source: "agent",
				tool: ESCALATE_TOOL,
				arguments: summarizeArguments({ action: params.action }, config.gate.argumentChars),
				question: params.question,
				userRequest: truncateUser(lastUserRequest(ctx)),
				cwd: ctx.cwd,
				at: Date.now(),
			};
			if (escalator.send) {
				const sent = await sendDeferred(
					request,
					ESCALATE_TOOL,
					`${AGENT_KEY}${request.id}`,
					escalator.send.bind(escalator),
					escalator.name,
					ctx,
				);
				const text =
					sent === UNSAFE
						? `not sent: ${UNSAFE_REASON}. Leave the credential out of the question, or ask the user.`
						: sent
							? `asked ${sent.to}, request ${sent.requestId}. End your turn now and wait: the decision arrives as your next message. Do not take the action unless it is approved.`
							: "no decision: the orchestrator could not be reached. Ask the user before taking the action.";
				return {
					content: [{ type: "text" as const, text: `jev_escalate: ${text}` }],
					details: { ok: sent !== undefined && sent !== UNSAFE, pending: sent && sent !== UNSAFE ? sent.requestId : undefined },
				};
			}
			const result = await runEscalation(request, ESCALATE_TOOL, ctx, signal);
			const outcome = result === UNSAFE ? undefined : result;
			const text =
				result === UNSAFE
					? `not sent: ${UNSAFE_REASON}. Leave the credential out of the question, or ask the user.`
					: outcome
						? `${describeOutcome(outcome)}.`
						: "no decision: the orchestrator did not answer in time. Ask the user before taking the action.";
			return {
				content: [{ type: "text" as const, text: `jev_escalate: ${text}` }],
				details: { ok: outcome !== undefined, outcome },
			};
		},
	});

	pi.registerTool({
		name: "jev_ask",
		label: "Jev Ask",
		description:
			"Ask a System One classifier (TypeSafe Jev by default) typed questions about a piece of text and get calibrated answers (probabilities, a chosen option, a rubric score) instead of prose.",
		promptSnippet:
			"Ask Jev typed questions (yes/no, choice, rubric) about text and get calibrated answers",
		promptGuidelines: [
			"Use jev_ask when a judgement must be typed and calibrated rather than written: classification, relevance, yes/no checks, rubric scores.",
			"Ask one specific question per entry in jev_ask; split multi-factor judgements into separate questions and combine the answers yourself.",
		],
		parameters: AskParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const why = checkReady(ctx);
			if (why) {
				return {
					content: [{ type: "text" as const, text: `jev_ask: ${why}` }],
					details: { ok: false },
				};
			}
			const questions: Record<string, JevQuestion> = {};
			for (const question of params.questions) {
				const built = toQuestion(question);
				if (typeof built === "string") {
					return {
						content: [
							{ type: "text" as const, text: `jev_ask: ${built}` },
						],
						details: { ok: false },
					};
				}
				questions[question.id] = built;
			}

			try {
				const response = await ask(ctx, { text: params.state }, questions, signal);
				return {
					content: [
						{
							type: "text" as const,
							text: renderAnswers(response, questions),
						},
					],
					details: {
						ok: true,
						model: response.model,
						usage: response.usage,
						answers: response.answers,
					},
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: `jev_ask: ${redact(error instanceof Error ? error.message : String(error))}`,
						},
					],
					details: { ok: false },
				};
			}
		},
	});
}

function describeAuth(registry: ClassifierRegistry | undefined, provider: string): string {
	const status = registry?.getProviderAuthStatus?.(provider);
	if (!status) return "unknown";
	if (!status.configured) return `missing (${authHint(provider)})`;
	return status.label ?? status.source ?? "configured";
}

function truncateUser(text: string | undefined): string | undefined {
	return text && text.length > 1200 ? `${text.slice(0, 1200)}…[truncated]` : text;
}

/** Text of a tool result, so the output judge sees what the model will see. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const text = Reflect.get(block, "text");
		if (typeof text === "string") parts.push(text);
	}
	return parts.join("\n");
}

interface QuestionParamValue {
	id: string;
	type: "bool" | "noul" | "choice" | "score";
	instructions: string;
	options?: { name: string; description?: string }[];
	levels?: string[];
}

/** Returns a Jev question, or a message explaining why the shape is invalid. */
function toQuestion(question: QuestionParamValue): JevQuestion | string {
	const { id, instructions } = question;
	if (question.type === "choice") {
		if (!question.options || question.options.length === 0) {
			return `question "${id}": choice needs at least one option`;
		}
		const criteria: Record<string, string> = {};
		for (const option of question.options) {
			criteria[option.name] = option.description ?? option.name;
		}
		return { type: "choice", instructions, criteria };
	}
	if (question.type === "score") {
		if (!question.levels || question.levels.length < 2) {
			return `question "${id}": score needs at least two levels`;
		}
		return { type: "score", instructions, criteria: question.levels };
	}
	return { type: "bool", instructions, criteria: { true: "Yes", false: "No" } };
}

function renderAnswers(
	response: JevResponse,
	questions: Record<string, JevQuestion>,
): string {
	const lines = [`model ${response.model}`];
	for (const [id, answer] of Object.entries(response.answers)) {
		const question = questions[id];
		const tail = question ? `  <- ${question.instructions}` : "";
		lines.push(
			`${id}: ${answer.type === "choice" ? formatChoice(answer) : describeAnswer(answer, question)}${tail}`,
		);
	}
	if (response.usage) {
		lines.push(
			`tokens ${response.usage.input ?? 0} in / ${response.usage.output ?? 0} out`,
		);
	}
	return lines.join("\n");
}

function formatChoice(answer: {
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}): string {
	const ranked = Object.entries(answer.probabilities)
		.sort(([, a], [, b]) => b - a)
		.map(([option, probability]) => `${option} ${probability.toFixed(2)}`)
		.join(", ");
	return `${answer.choice} (conf ${answer.confidence.toFixed(2)}) [${ranked}]`;
}

/** Latest user text in the branch, so scope questions can weigh intent. */
function lastUserRequest(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.buildContextEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user") continue;
		const text = messageText(message.content);
		if (text) return text;
	}
	return undefined;
}

function messageText(content: unknown): string | undefined {
	if (typeof content === "string") return content.trim() || undefined;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const type = Reflect.get(block, "type");
		const text = Reflect.get(block, "text");
		if (type === "text" && typeof text === "string") parts.push(text);
	}
	const joined = parts.join("\n").trim();
	return joined || undefined;
}
