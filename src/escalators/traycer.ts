/**
 * Escalate to the managing agent inside Traycer.
 *
 * Traycer exposes no public A2A endpoint; its agent-to-agent channel is the
 * `traycer` CLI that it installs and configures for every agent it launches
 * (TRAYCER_EPIC_ID and TRAYCER_AGENT_ID in the environment):
 *
 *   traycer agent send --to <parent> --message <text> --expect-reply --json
 *     -> NDJSON: progress lines, then one {"type":"result",…} carrying a responseId
 *   traycer agent inbox [--after <cursor>] --json
 *     -> NDJSON result with the messages addressed to this agent
 *
 * The managing agent sees the message as `[traycer:agent-message]` text and
 * answers with its `traycer_send_message` tool, so the message is written for
 * an LLM reader and asks for JSON back, carrying the request id.
 *
 * Where the answer lands (verified on Traycer 1.5.1, docs/SESSION-NOTES.md):
 * Traycer delivers a reply into this agent's conversation as a new prompt,
 * even while the gated tool call is still waiting. The CLI inbox is only a
 * recovery buffer: it can be empty, and its entries carry no responseId. So
 * the main path is `ReplyInbox`: the extension's `input` handler offers each
 * incoming message to it, and a matching decision resolves the wait and is
 * consumed before the model sees it. Polling the inbox for the responseId
 * stays as a second path for hosts that keep replies there.
 *
 * Verified shapes: `agent list --json` is `{type:"result", data:{agents:[{id,
 * parentId, isSelf, …}]}}`; `agent inbox --json` is `{type:"result",
 * data:{messages:[…], nextCursor:{createdAt, eventId} | null}}`.
 */

import {
	EscalationError,
	extractJsonObject,
	pollUntil,
	type EscalationDecision,
	type EscalationRequest,
	type EscalationWait,
	type Escalator,
	parseDecision,
} from "../escalation";

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
}

export type Exec = (
	command: string,
	args: string[],
	options?: { signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;

export interface TraycerOptions {
	command: string;
	parentAgentId: string | undefined;
	pollMs: number;
	env: Record<string, string | undefined>;
	/** Decisions delivered as chat input (see `createReplyInbox`). */
	replies?: ReplyInbox;
	now?: () => number;
}

interface PendingReply {
	requestId: string;
	from: string;
	onEscalated?: (decision: EscalationDecision) => void;
	resolve: (decision: FinalDecision) => void;
}

type FinalDecision = EscalationDecision & { decision: "approve" | "deny" };

/**
 * Decisions that reach this agent as chat input instead of through the CLI.
 * One per extension instance; the escalator registers what it waits for and
 * the `input` handler offers every incoming message while anything is pending.
 */
export interface ReplyInbox {
	/** Wait for the decision on `requestId` from agent `from`. */
	expect(
		requestId: string,
		from: string,
		onEscalated?: (decision: EscalationDecision) => void,
	): { promise: Promise<FinalDecision>; cancel(): void };
	/**
	 * Offer one incoming message. A match means it answered a pending
	 * request, so the caller must not pass the raw text on: the decision is
	 * the gate's to act on, and the model must not act on an approval the
	 * gate did not record.
	 */
	offer(text: string): ReplyMatch | undefined;
	readonly pending: number;
}

/**
 * Traycer's prompt header names the sender, as
 * `Agent message from <title> (agent <id>) [harness]` or
 * `[traycer:agent-message] from <title> (agent <id>) [harness]`. It is the
 * first header-shaped line: Traycer may put its own preamble (`# Workspace
 * Directories …`) above it, and the sender's text only below it. The title
 * is the sender's to choose, so the id is the last `(agent …)` before the
 * harness tag.
 */
const HEADER_START = /^(?:Agent message|\[traycer:agent-message\]) from /;
const HEADER = /^(?:Agent message|\[traycer:agent-message\]) from .*\(agent ([0-9A-Za-z][0-9A-Za-z-]{3,})\) \[[^\]\n]+\]\s*$/;

/**
 * The sender named by the header; null when the message is from an agent but
 * the header does not parse, so the caller fails closed; undefined when the
 * message has no agent header at all (typed by the local user).
 */
function headerSender(text: string): string | null | undefined {
	const line = text.split("\n").find((candidate) => HEADER_START.test(candidate));
	if (line === undefined) return undefined;
	return HEADER.exec(line)?.[1] ?? null;
}

export interface ReplyMatch {
	requestId: string;
	/** `escalate` means a human now decides; the request stays pending. */
	decision: EscalationDecision & { by: string };
}

export function createReplyInbox(): ReplyInbox {
	const waiting = new Map<string, PendingReply>();
	return {
		get pending() {
			return waiting.size;
		},
		expect(requestId, from, onEscalated) {
			let entry: PendingReply | undefined;
			const promise = new Promise<FinalDecision>((resolve) => {
				entry = { requestId, from, onEscalated, resolve };
				waiting.set(requestId, entry);
			});
			return {
				promise,
				cancel: () => {
					if (waiting.get(requestId) === entry) waiting.delete(requestId);
				},
			};
		},
		offer(text) {
			if (waiting.size === 0) return undefined;
			const sender = headerSender(text);
			if (sender === null) return undefined;
			const body = extractJsonObject(text);
			const id = body ? (findString(body, ["id", "requestId", "request_id"], 0) ?? undefined) : undefined;
			// The request id is shared only with the parent, so it names the
			// request. Without one, accept a reply only when its header names
			// the parent and exactly one request is waiting on that parent,
			// and only to deny or escalate: an approval must name its request.
			let entry = id ? waiting.get(id) : undefined;
			if (!entry && !id && sender) {
				const candidates = [...waiting.values()].filter((pending) => pending.from === sender);
				if (candidates.length === 1) entry = candidates[0];
			}
			if (!entry) return undefined;
			if (sender && sender !== entry.from) return undefined;
			const decision = parseDecision(body ?? text);
			if (!decision) return undefined;
			if (!id && decision.decision === "approve") return undefined;
			const match = { requestId: entry.requestId, decision: { ...decision, by: decision.by ?? entry.from } };
			if (decision.decision === "escalate") {
				entry.onEscalated?.(decision);
				return match;
			}
			waiting.delete(entry.requestId);
			entry.resolve({ ...match.decision, decision: decision.decision });
			return match;
		},
	};
}

const CLI_TIMEOUT_MS = 30_000;

export function traycerEscalator(exec: Exec, options: TraycerOptions): Escalator {
	const now = options.now ?? Date.now;
	const self = options.env.TRAYCER_AGENT_ID;

	async function run(args: string[], signal?: AbortSignal): Promise<unknown[]> {
		const result = await exec(options.command, [...args, "--json"], {
			signal,
			timeout: CLI_TIMEOUT_MS,
		});
		if (result.code !== 0) {
			const detail = (result.stderr || result.stdout).trim().slice(0, 300);
			throw new EscalationError(`traycer ${args.slice(0, 2).join(" ")} exited ${result.code}${detail ? `: ${detail}` : ""}`);
		}
		return parseNdjson(result.stdout);
	}

	async function parentId(signal?: AbortSignal): Promise<string> {
		const configured = options.parentAgentId ?? options.env.TRAYCER_PARENT_AGENT_ID;
		if (configured) return configured;
		if (!self) throw new EscalationError("TRAYCER_AGENT_ID is not set");
		const lines = await run(["agent", "list"], signal);
		const parent = findParentId(lines, self);
		if (!parent) {
			throw new EscalationError(
				"could not find this agent's parent in `traycer agent list`; set escalation.traycer.parentAgentId",
			);
		}
		return parent;
	}

	/** This agent's id; throws outside Traycer. */
	function requireSelf(): string {
		if (!self || !options.env.TRAYCER_EPIC_ID) {
			throw new EscalationError("not running under Traycer (TRAYCER_EPIC_ID/TRAYCER_AGENT_ID unset)");
		}
		return self;
	}

	return {
		name: "traycer",
		// Traycer 1.5.1 holds a reply until this agent's turn ends, so the
		// extension sends, blocks the call, and takes the decision from the
		// next prompt (`ReplyInbox`). `request` waits in-turn instead, for a
		// host that delivers mid-turn.
		async recipient(signal?: AbortSignal) {
			requireSelf();
			return parentId(signal);
		},
		async send(req: EscalationRequest, signal?: AbortSignal) {
			const me = requireSelf();
			const to = await parentId(signal);
			await run(["agent", "send", "--to", to, "--message", traycerMessage(req, me), "--expect-reply"], signal);
			return { to };
		},
		async request(req: EscalationRequest, wait: EscalationWait) {
			const me = requireSelf();
			const to = await parentId(wait.signal);
			// Read the cursor first so a stale reply in the inbox cannot answer us.
			// With chat replies as the main path, an unreadable inbox only loses
			// the backup path, so it does not stop the escalation.
			let cursor = inboxCursor(
				await run(["agent", "inbox"], wait.signal).catch((error: unknown) => {
					if (options.replies) return [];
					throw error;
				}),
			);
			const sent = await run(
				["agent", "send", "--to", to, "--message", traycerMessage(req, me), "--expect-reply"],
				wait.signal,
			);
			const responseId = findString(resultOf(sent), ["responseId", "response_id"]);
			if (!responseId && !options.replies) {
				throw new EscalationError("traycer send returned no responseId");
			}

			// Stops the inbox poll once a reply arrives as chat input. `deadline`
			// is read through, because onEscalated moves it on the shared wait.
			const stop = new AbortController();
			const pollWait: EscalationWait = {
				get deadline() {
					return wait.deadline;
				},
				signal: wait.signal ? AbortSignal.any([wait.signal, stop.signal]) : stop.signal,
				onEscalated: wait.onEscalated,
			};
			const viaInput = options.replies?.expect(req.id, to, wait.onEscalated);
			const viaInbox = pollUntil(
				async () => {
					if (!responseId) return undefined;
					const args = ["agent", "inbox"];
					if (cursor) args.push("--after", cursor);
					let lines: unknown[];
					try {
						lines = await run(args, pollWait.signal);
					} catch (error) {
						// With chat replies as the main path, a failing inbox read is
						// not the end of the wait: keep waiting until the deadline.
						if (options.replies && !pollWait.signal?.aborted) return undefined;
						throw error;
					}
					cursor = inboxCursor(lines) ?? cursor;
					for (const message of inboxMessages(lines)) {
						if (findString(message, ["responseId", "response_id"]) !== responseId) continue;
						const decision = parseDecision(messageText(message));
						if (!decision) continue;
						if (decision.decision === "escalate") {
							wait.onEscalated?.(decision);
							continue;
						}
						return {
							...decision,
							decision: decision.decision,
							by: decision.by ?? findString(message, ["senderAgentId", "fromAgentId", "sender", "from"]) ?? to,
						} as FinalDecision;
					}
					return undefined;
				},
				{ intervalMs: options.pollMs, wait: pollWait, now },
			);
			try {
				return await (viaInput ? Promise.race([viaInbox, viaInput.promise]) : viaInbox);
			} finally {
				viaInput?.cancel();
				stop.abort();
			}
		},
	};
}

/** Written for an LLM manager: what is asked, and the exact reply shape. */
export function traycerMessage(req: EscalationRequest, self: string): string {
	const what = req.verdict
		? `the pi-jev safety gate flagged a \`${req.tool}\` call (${req.verdict.summary}).`
		: `it asks for a decision before \`${req.tool}\`: ${req.question ?? "(no question given)"}`;
	return [
		`[pi-jev escalation] Agent ${self} is paused: ${what}`,
		"It will not continue until you reply to this message.",
		`Reply on this thread with JSON: {"id":"${req.id}","decision":"approve"|"deny"|"escalate","reason":"<one line>"}.`,
		'Use "escalate" if a human should decide; then send the final approve/deny when they have.',
		"",
		"Request:",
		JSON.stringify(req, null, 2),
	].join("\n");
}

export function parseNdjson(text: string): unknown[] {
	const out: unknown[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {
			// a progress line that is not JSON
		}
	}
	return out;
}

/** The `result` line, or the last object when the CLI prints no type field. */
function resultOf(lines: unknown[]): unknown {
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		if (typeof line === "object" && line !== null && Reflect.get(line, "type") === "result") return line;
	}
	return lines.at(-1);
}

function inboxMessages(lines: unknown[]): object[] {
	const out: object[] = [];
	const visit = (value: unknown, depth: number): void => {
		if (depth > 5 || typeof value !== "object" || value === null) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item, depth + 1);
			return;
		}
		if (findString(value, ["responseId", "response_id"], 0) && messageText(value)) {
			out.push(value);
			return;
		}
		for (const item of Object.values(value)) visit(item, depth + 1);
	};
	visit(resultOf(lines), 0);
	return out;
}

/** The next-page cursor, as `--after` takes it: a string, or `createdAt:eventId`. */
export function inboxCursor(lines: unknown[]): string | undefined {
	const found = findValue(resultOf(lines), ["nextCursor", "next_cursor", "cursor"], 2);
	if (typeof found === "string" && found) return found;
	if (typeof found === "object" && found !== null) {
		const createdAt = Reflect.get(found, "createdAt");
		const eventId = Reflect.get(found, "eventId");
		if ((typeof createdAt === "number" || typeof createdAt === "string") && typeof eventId === "string") {
			return `${createdAt}:${eventId}`;
		}
	}
	return undefined;
}

function findValue(value: unknown, keys: string[], depth: number): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	for (const key of keys) {
		const found = Reflect.get(value, key);
		if (found !== undefined && found !== null) return found;
	}
	if (depth <= 0) return undefined;
	for (const item of Object.values(value)) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const found = findValue(item, keys, depth - 1);
		if (found !== undefined) return found;
	}
	return undefined;
}

function messageText(message: object): string {
	for (const key of ["prompt", "message", "text", "content", "body"]) {
		const value = Reflect.get(message, key);
		if (typeof value === "string") return value;
	}
	return "";
}

/** First string under any of `keys`, searching nested objects to `depth`. */
export function findString(value: unknown, keys: string[], depth = 3): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	for (const key of keys) {
		const found = Reflect.get(value, key);
		if (typeof found === "string" && found) return found;
	}
	if (depth <= 0) return undefined;
	for (const item of Object.values(value)) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const found = findString(item, keys, depth - 1);
		if (found) return found;
	}
	return undefined;
}

function findParentId(lines: unknown[], self: string): string | undefined {
	let parent: string | undefined;
	const visit = (value: unknown, depth: number): void => {
		if (parent || depth > 5 || typeof value !== "object" || value === null) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item, depth + 1);
			return;
		}
		const id = Reflect.get(value, "id") ?? Reflect.get(value, "agentId");
		if (id === self) {
			parent = findString(value, ["parentAgentId", "parentId", "parent_agent_id", "parent"], 0);
			return;
		}
		for (const item of Object.values(value)) visit(item, depth + 1);
	};
	for (const line of lines) visit(line, 0);
	return parent;
}
