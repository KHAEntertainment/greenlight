/**
 * Where this checkout pushes, so the exfiltration question can tell a push to
 * the project's own repository from an upload somewhere else (#25).
 *
 * Read with git itself, which already handles worktrees, packed refs and
 * `includeIf`. Every lookup fails open: no repository, no `origin`, a slow or
 * missing git binary - the field is left out and the gate judges without it.
 */

export interface GitContext {
	origin?: string;
	/**
	 * Where `git push origin` actually sends, when that is not `origin` itself:
	 * a `pushurl`, several of them, or a `pushInsteadOf` rewrite. A URL that
	 * cannot be shown safely appears as `UNREADABLE_URL`, so the mismatch still
	 * reaches the classifier.
	 */
	origin_push?: string[];
	/**
	 * The remote a plain `git push` picks, when it is not `origin`:
	 * `branch.<name>.pushRemote`, then `remote.pushDefault`, then
	 * `branch.<name>.remote`.
	 */
	push_remote?: string;
	/**
	 * Remotes besides `origin`. Jev reads `git push upstream x` as routine
	 * (0.14-0.18) without knowing where `upstream` points, so their presence
	 * alone brings back the strict exfiltration question.
	 */
	other_remotes?: string[];
	branch?: string;
	default_branch?: string;
}

export const UNREADABLE_URL = "(unreadable URL)";
export const UNREADABLE_NAME = "(unreadable name)";
const MAX_PUSH_URLS = 5;

export type GitExec = (
	command: string,
	args: string[],
	options: { cwd: string; timeout: number; signal?: AbortSignal },
) => Promise<{ stdout: string; code: number }>;

const GIT_TIMEOUT_MS = 1000;
const MAX_FIELD_CHARS = 200;

export async function readGitContext(
	exec: GitExec,
	cwd: string,
	signal?: AbortSignal,
): Promise<GitContext | undefined> {
	const lines = async (args: string[]): Promise<string[] | undefined> => {
		try {
			const result = await exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS, signal });
			const out = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
			return result.code === 0 && out.length > 0 ? out : undefined;
		} catch {
			return undefined;
		}
	};
	const run = async (args: string[]): Promise<string | undefined> => {
		const out = await lines(args);
		const only = out?.length === 1 ? out[0] : undefined;
		return only !== undefined && only.length <= MAX_FIELD_CHARS ? only : undefined;
	};
	const [fetchUrls, pushUrls, head, originHead, pushConfig, remotes] = await Promise.all([
		lines(["remote", "get-url", "origin"]),
		// --push expands pushurl and pushInsteadOf, so this is where a push goes.
		lines(["remote", "get-url", "--push", "--all", "origin"]),
		lines(["rev-parse", "--abbrev-ref", "HEAD"]),
		run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
		lines(["config", "--get-regexp", "^(remote\\.pushdefault|branch\\..*\\.(pushremote|remote))$"]),
		lines(["remote"]),
	]);
	const context: GitContext = {};
	const fetchUrl = fetchUrls?.length === 1 ? fetchUrls[0] : undefined;
	const shownOrigin = fetchUrl !== undefined && fetchUrl.length <= MAX_FIELD_CHARS ? publicRemoteUrl(fetchUrl) : undefined;
	if (shownOrigin) context.origin = shownOrigin;
	// Compared raw and at any length: a fetch URL too long or too odd to show,
	// or one git could not read, still makes a push URL count as elsewhere.
	if (pushUrls && (fetchUrl === undefined || pushUrls.some((push) => push !== fetchUrl))) {
		const shown = pushUrls.map((push) => (push.length <= MAX_FIELD_CHARS && publicRemoteUrl(push)) || UNREADABLE_URL);
		context.origin_push = shown.slice(0, MAX_PUSH_URLS);
	}
	// A detached HEAD reports the literal "HEAD", which says nothing. The raw
	// name, at any length, decides where a plain push goes; only the shown
	// copy is limited.
	const branch = head?.length === 1 && head[0] !== "HEAD" ? head[0] : undefined;
	if (branch && branch.length <= MAX_FIELD_CHARS) context.branch = branch;
	const pushRemote = defaultPushRemote(pushConfig ?? [], branch);
	if (pushRemote !== "origin") {
		context.push_remote = shownName(pushRemote);
	}
	const others = (remotes ?? []).filter((name) => name !== "origin");
	if (others.length > 0) context.other_remotes = others.slice(0, MAX_PUSH_URLS).map(shownName);
	if (originHead?.startsWith("origin/")) context.default_branch = originHead.slice("origin/".length);
	return Object.keys(context).length > 0 ? context : undefined;
}

/** A remote name is agent-controlled text; only a plain one is passed on. */
function shownName(name: string): string {
	return /^[\w.-]{1,100}$/.test(name) ? name : UNREADABLE_NAME;
}

/**
 * The remote a plain `git push` sends to, from `git config --get-regexp` lines
 * (`<key> <value>`; git lowercases the section and key, not the branch name).
 */
function defaultPushRemote(entries: string[], branch: string | undefined): string {
	const config = new Map<string, string>();
	for (const entry of entries) {
		const space = entry.indexOf(" ");
		if (space > 0) config.set(entry.slice(0, space), entry.slice(space + 1).trim());
	}
	const at = (key: string) => config.get(key) || undefined;
	return (
		(branch && at(`branch.${branch}.pushremote`)) ||
		at("remote.pushdefault") ||
		(branch && at(`branch.${branch}.remote`)) ||
		"origin"
	);
}

/**
 * A remote URL can carry a token (`https://user:token@host/...`), and the state
 * goes to the classifier. Keep only scheme, host and path; a URL that does not
 * parse cleanly is left out rather than guessed at.
 */
export function publicRemoteUrl(url: string): string | undefined {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
		try {
			const parsed = new URL(url);
			if (!parsed.host) return undefined;
			const shown = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
			// WHATWG parsing can move would-be user info into the path
			// (`https://DOMAIN\user:pw@host/...`). A real repository path has no
			// `@`, so anything that still carries one is left out.
			return /[@\\]/.test(shown) ? undefined : shown;
		} catch {
			return undefined;
		}
	}
	// scp-like `git@host:owner/repo.git`. The user is only kept when it is the
	// conventional `git`, so an unusual user name cannot carry a token.
	const scp = /^(?:([\w.-]+)@)?([\w.-]+):([\w./~-]+)$/.exec(url);
	if (scp) return `${scp[1] === "git" ? "git@" : ""}${scp[2]}:${scp[3]}`;
	// A local path remote holds nothing secret.
	if (/^(?:\/|\.{1,2}\/|~\/)[\w./~-]*$/.test(url)) return url;
	return undefined;
}
