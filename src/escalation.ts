/**
 * Orchestrator escalation: when the gate flags a call in `escalate` mode, the
 * verdict goes upstream to whatever is managing this agent - a Pi parent
 * driving it over RPC, the Traycer ADE, or any A2A orchestrator - and the tool
 * call waits until that manager approves, denies, or hands it to a human.
 *
 * This module is the transport-agnostic half: the request and decision
 * shapes, decision parsing, transport selection, and the wait loop. Transports
 * live in `src/escalators/`. Nothing here imports pi at runtime.
 *
 * Fail-open applies here too: an escalator that cannot answer (unreachable,
 * timed out, aborted, malformed reply) throws, and the caller falls back to
 * the local `enforce` rule. An orchestrator outage never blocks more than the
 * local rule would.
 */

import type { EscalationConfig, EscalationTransport } from "./config";

export const ESCALATION_SCHEMA = "pi-jev.escalation/v1";

/** What the orchestrator is asked to decide. Arguments are already elided. */
export interface EscalationRequest {
	schema: typeof ESCALATION_SCHEMA;
	id: string;
	/** "gate" for a flagged call, "agent" for a jev_escalate tool call. */
	source: "gate" | "agent";
	tool: string;
	arguments: unknown;
	verdict?: {
		summary: string;
		reasons: string[];
		scores: Record<string, number | undefined>;
		model: string;
	};
	/** Free text the agent attached (jev_escalate), or the user's last request. */
	question?: string;
	userRequest?: string;
	/**
	 * Set when credentials were replaced with `[redacted]` before sending.
	 * Only inert values are ever redacted, never shell code, but an
	 * orchestrator may still deny a request it cannot see in full.
	 */
	redacted?: true;
	cwd: string;
	at: number;
}

export type Decision = "approve" | "deny" | "escalate";

export interface EscalationDecision {
	decision: Decision;
	reason?: string;
	/** Who decided: an agent id, "human", the transport name. */
	by?: string;
}

/** What the gate learned, for the journal and the block reason. */
export interface EscalationOutcome {
	decision: Exclude<Decision, "escalate">;
	reason?: string;
	by?: string;
	transport: string;
	/** True when a human decided after the orchestrator escalated. */
	viaHuman: boolean;
	latencyMs: number;
}

export interface EscalationWait {
	signal?: AbortSignal;
	/** Absolute ms epoch after which the wait gives up. */
	deadline: number;
	/** Called when the orchestrator escalates further; extends the deadline. */
	onEscalated?: (decision: EscalationDecision) => void;
}

/**
 * One way to reach the orchestrator. `request` resolves with a final approve
 * or deny. An intermediate "escalated to a human" reply is the transport's to
 * handle: it calls `wait.onEscalated` (which moves the deadline out to the
 * human timeout) and keeps waiting on the same thread rather than asking
 * again. Throw for "no answer" - never resolve deny for a transport failure.
 */
export interface Escalator {
	readonly name: Exclude<EscalationTransport, "auto" | "none">;
	request(
		req: EscalationRequest,
		wait: EscalationWait,
	): Promise<EscalationDecision & { decision: "approve" | "deny" }>;
}

export class EscalationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EscalationError";
	}
}

/** Anything that resolves `auto` to a transport, so tests can stub env/mode. */
export interface TransportContext {
	mode?: string;
	env: Record<string, string | undefined>;
}

/**
 * `auto` picks the most specific manager the process can see: Traycer sets
 * TRAYCER_AGENT_ID on every agent it launches, an A2A URL is explicit
 * configuration, and RPC mode means a parent process holds our stdin.
 */
export function resolveTransport(
	config: EscalationConfig,
	ctx: TransportContext,
): Exclude<EscalationTransport, "auto"> {
	if (config.transport !== "auto") return config.transport;
	if (ctx.env.TRAYCER_AGENT_ID && ctx.env.TRAYCER_EPIC_ID) return "traycer";
	if (config.a2a.url) return "a2a";
	if (ctx.mode === "rpc") return "pi-rpc";
	return "none";
}

/**
 * Words that decide. A structured `decision` field and a reply that is only
 * one word may use any of them; a leading word in prose may use only the
 * unambiguous ones, because "Run this past the user first" or "OK, but deny"
 * must not read as approval. Anything unclear is no answer, so the local
 * enforce rule decides.
 */
const APPROVE = new Set(["approve", "approved", "allow", "allowed", "accept", "accepted"]);
const DENY = new Set(["deny", "denied", "block", "blocked", "reject", "rejected", "refuse", "refused"]);
const ESCALATE = new Set(["escalate", "escalated"]);
const APPROVE_BARE = new Set([...APPROVE, "yes", "y", "ok", "okay", "proceed"]);
const DENY_BARE = new Set([...DENY, "no", "n", "stop"]);
const ESCALATE_BARE = new Set([...ESCALATE, "human", "defer", "pending"]);

/**
 * A decision from whatever the orchestrator sent back. JSON is the contract
 * (`{"decision":"approve","reason":"..."}`); a one-word reply, or an
 * unambiguous leading word followed by punctuation ("deny: too risky"), is
 * accepted because the orchestrator is often another LLM agent answering in text.
 * Undefined means "this text is not a decision" - the caller keeps waiting or
 * treats it as no answer, never as a deny.
 */
export function parseDecision(value: unknown): EscalationDecision | undefined {
	if (typeof value === "string") return parseDecisionText(value);
	if (typeof value !== "object" || value === null) return undefined;
	const raw = Reflect.get(value, "decision") ?? Reflect.get(value, "verdict");
	const word = typeof raw === "string" ? classifyWord(raw, true) : undefined;
	if (!word) {
		const approved = Reflect.get(value, "approved");
		if (typeof approved !== "boolean") return undefined;
		return withDetail({ decision: approved ? "approve" : "deny" }, value);
	}
	return withDetail({ decision: word }, value);
}

function parseDecisionText(text: string): EscalationDecision | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	const json = extractJsonObject(trimmed);
	if (json !== undefined) {
		const parsed = parseDecision(json);
		if (parsed) return parsed;
	}
	const bare = /^[\s"'`*_[(]*([A-Za-z]+)[\s"'`*_\]).!:,;-]*$/.exec(trimmed);
	if (bare?.[1]) {
		const word = classifyWord(bare[1], true);
		return word ? { decision: word } : undefined;
	}
	// A leading word counts only when punctuation, not more prose, follows it.
	const match = /^[\s"'`*_[(]*([A-Za-z]+)(?=\s*[.!:,;\u2013\u2014*_"'`)\]-])/.exec(trimmed);
	const word = match?.[1] ? classifyWord(match[1], false) : undefined;
	if (!word) return undefined;
	const rest = trimmed
		.slice(match?.[0].length ?? 0)
		.replace(/^[\s"'`*_\]).:,;-]+/, "")
		.trim();
	return rest ? { decision: word, reason: rest.slice(0, 500) } : { decision: word };
}

function classifyWord(word: string, bare: boolean): Decision | undefined {
	const lower = word.trim().toLowerCase();
	if ((bare ? APPROVE_BARE : APPROVE).has(lower)) return "approve";
	if ((bare ? DENY_BARE : DENY).has(lower)) return "deny";
	if ((bare ? ESCALATE_BARE : ESCALATE).has(lower)) return "escalate";
	return undefined;
}

function withDetail(decision: EscalationDecision, source: object): EscalationDecision {
	const reason = Reflect.get(source, "reason") ?? Reflect.get(source, "message");
	const by = Reflect.get(source, "by");
	if (typeof reason === "string" && reason.trim()) decision.reason = reason.trim().slice(0, 500);
	if (typeof by === "string" && by.trim()) decision.by = by.trim();
	return decision;
}

/** The first balanced `{...}` in the text that parses as JSON. */
export function extractJsonObject(text: string): object | undefined {
	for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
		let depth = 0;
		let inString = false;
		for (let index = start; index < text.length; index += 1) {
			const char = text[index];
			if (inString) {
				if (char === "\\") index += 1;
				else if (char === '"') inString = false;
				continue;
			}
			if (char === '"') inString = true;
			else if (char === "{") depth += 1;
			else if (char === "}") {
				depth -= 1;
				if (depth === 0) {
					try {
						const parsed: unknown = JSON.parse(text.slice(start, index + 1));
						if (typeof parsed === "object" && parsed !== null) return parsed;
					} catch {
						// not JSON from this brace; try the next one
					}
					break;
				}
			}
		}
	}
	return undefined;
}

/**
 * Ask the escalator and wait for a final approve/deny. An `escalate` reply
 * along the way means the orchestrator handed it to a human: the deadline
 * moves out to the human timeout, once.
 */
export async function escalate(
	escalator: Escalator,
	req: EscalationRequest,
	config: Pick<EscalationConfig, "timeoutSeconds" | "humanTimeoutSeconds">,
	options: {
		signal?: AbortSignal;
		now?: () => number;
		onEscalated?: (decision: EscalationDecision) => void;
	} = {},
): Promise<EscalationOutcome> {
	const now = options.now ?? Date.now;
	const started = now();
	let viaHuman = false;
	const wait: EscalationWait = {
		signal: options.signal,
		deadline: started + config.timeoutSeconds * 1000,
		onEscalated: (decision) => {
			if (viaHuman) return;
			viaHuman = true;
			wait.deadline = Math.max(
				wait.deadline,
				now() + config.humanTimeoutSeconds * 1000,
			);
			options.onEscalated?.(decision);
		},
	};
	const decision = await escalator.request(req, wait);
	if (decision.decision !== "approve" && decision.decision !== "deny") {
		throw new EscalationError(`${escalator.name} returned no final decision`);
	}
	return {
		decision: decision.decision,
		reason: decision.reason,
		by: decision.by,
		transport: escalator.name,
		viaHuman,
		latencyMs: now() - started,
	};
}

/**
 * Poll `check` until it yields a value, the deadline passes, or the signal
 * aborts. Shared by the transports without push (Traycer inbox, A2A GetTask).
 */
export async function pollUntil<T>(
	check: () => Promise<T | undefined>,
	options: { intervalMs: number; wait: EscalationWait; now?: () => number },
): Promise<T> {
	const now = options.now ?? Date.now;
	for (;;) {
		if (options.wait.signal?.aborted) throw new EscalationError("escalation aborted");
		const value = await check();
		if (value !== undefined) return value;
		const remaining = options.wait.deadline - now();
		if (remaining <= 0) throw new EscalationError("escalation timed out");
		await sleep(Math.min(options.intervalMs, remaining), options.wait.signal);
	}
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			resolve();
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export const REDACTED = "[redacted]";

/** Object keys whose string values are credentials, wherever they nest. */
const SECRET_KEY = /pass(word|wd|phrase)?$|secret|token|api[-_]?key|auth(orization)?$|cookie|credential|private[-_]?key/i;

/**
 * A value that is inert wherever it sits in a shell command: no whitespace,
 * quotes (except one matching pair around it), expansion (`$`, backticks),
 * escapes, operators or brackets. Replacing it with `[redacted]` cannot hide
 * code, whatever quoting state the surrounding text is really in. Anything
 * else in a credential position is not redacted by guesswork: the request is
 * marked unsafe and is not sent (see `scrubSecrets`).
 */
const INERT = /^(["']?)[^\s"'`$\\;&|<>(){}[\]]+\1$/;

interface ScrubState {
	unsafe: boolean;
}

function inert(value: string, state: ScrubState): string {
	if (INERT.test(value)) return REDACTED;
	state.unsafe = true;
	return value;
}

/** A complete PEM private key: header, base64 lines, END. Nothing else fits. */
const PEM_BLOCK =
	/-----BEGIN ([A-Z ]*)PRIVATE KEY-----(?:(?:\r?\n|\\(?:r\\)?n)(?:(?:Proc-Type|DEK-Info): [A-Za-z0-9,-]+|[A-Za-z0-9+/=]+))*(?:\r?\n|\\(?:r\\)?n)-----END \1PRIVATE KEY-----/g;
const PEM_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/**
 * Credential shapes that show up in tool arguments: auth headers, `NAME=value`
 * assignments, URL userinfo, PEM blocks, and well-known key prefixes. Each
 * replacement keeps the name so the orchestrator still sees what is used.
 * The fixed-alphabet patterns (key prefixes, JWTs, bearer tokens) are inert
 * by construction; the free-text ones go through `inert`.
 */
const SECRET_PATTERNS: ReadonlyArray<(text: string, state: ScrubState) => string> = [
	(text, state) => {
		const out = text.replace(PEM_BLOCK, REDACTED);
		// A key whose block we cannot delimit exactly: neither send it nor guess.
		if (PEM_HEADER.test(out)) state.unsafe = true;
		return out;
	},
	(text, state) =>
		text.replace(
			/\b((?:proxy-)?authorization|x-api-key|api-key|cookie)(\s*[:=]\s*)(?:(bearer|basic|token)\s+)?("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/gi,
			(_match, name: string, sep: string, scheme: string | undefined, value: string) =>
				`${name}${sep}${scheme ? `${scheme} ` : ""}${value === REDACTED ? value : inert(value, state)}`,
		),
	(text) => text.replace(/\b(bearer|basic)\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`),
	(text, state) =>
		text.replace(
			/\b([A-Za-z0-9_]*(?:pass(?:word|wd)?|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credential)[A-Za-z0-9_]*)(["']?\s*[=:]\s*)(?!\[redacted\])("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/gi,
			(_match, name: string, sep: string, value: string) => `${name}${sep}${inert(value, state)}`,
		),
	(text, state) =>
		text.replace(
			/(--?(?:pass(?:word)?|token|secret|api[-_]?key))([ =])(?!\[redacted\])("[^"\n]*"|'[^'\n]*'|\S+)/gi,
			(_match, flag: string, sep: string, value: string) => `${flag}${sep}${inert(value, state)}`,
		),
	(text, state) =>
		text.replace(
			/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)@/gi,
			(_match, prefix: string, value: string) => `${prefix}${value === REDACTED ? value : inert(value, state)}@`,
		),
	(text) =>
		text.replace(
			/\b(sk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36})\b/g,
			REDACTED,
		),
	(text) => text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED),
];

export interface ScrubResult<T> {
	value: T;
	/** Something was replaced with `[redacted]`. */
	redacted: boolean;
	/**
	 * A credential sits in a value that is not inert (shell syntax, spaces,
	 * quotes, an undelimited PEM key). It was left in place, so the request
	 * must not be sent: redacting it could hide code, and sending it leaks it.
	 */
	unsafe: boolean;
}

/**
 * Strip credentials from an escalation request before it leaves the process.
 * The request goes to another agent, a CLI's argv, or a remote A2A server, so
 * a token in a `curl -H` or an `export` must not travel with it. `known`
 * replaces secrets this process has already seen (the classifier key, the
 * orchestrator token). Only inert values are redacted, so the orchestrator
 * never approves code it could not see; when that is not enough, `unsafe`
 * tells the caller to keep the decision local.
 */
export function scrubSecrets<T>(value: T, known: (text: string) => string = (text) => text): ScrubResult<T> {
	const state: ScrubState = { unsafe: false };
	const scrubbed = scrub(value, known, state, 0) as T;
	return { value: scrubbed, redacted: JSON.stringify(scrubbed) !== JSON.stringify(value), unsafe: state.unsafe };
}

function scrub(value: unknown, known: (text: string) => string, state: ScrubState, depth: number): unknown {
	if (typeof value === "string") {
		let out = known(value);
		for (const pattern of SECRET_PATTERNS) out = pattern(out, state);
		return out;
	}
	if (typeof value !== "object" || value === null) return value;
	// Past the depth limit nothing is inspected, so nothing is sent raw.
	if (depth > 8) return REDACTED;
	if (Array.isArray(value)) return value.map((item) => scrub(item, known, state, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		out[key] =
			typeof item === "string" && item.length > 0 && SECRET_KEY.test(key)
				? inert(item, state)
				: scrub(item, known, state, depth + 1);
	}
	return out;
}

export function newRequestId(): string {
	const random = globalThis.crypto?.randomUUID?.();
	return random ?? `jev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** One line for the block reason and notifications. */
export function describeOutcome(outcome: EscalationOutcome): string {
	const who = outcome.by ?? outcome.transport;
	const human = outcome.viaHuman ? " via human" : "";
	const reason = outcome.reason ? `: ${outcome.reason}` : "";
	return `${outcome.decision === "approve" ? "approved" : "denied"} by ${who}${human}${reason}`;
}
