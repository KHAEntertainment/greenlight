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
	branch?: string;
	default_branch?: string;
}

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
	const run = async (args: string[]): Promise<string | undefined> => {
		try {
			const result = await exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS, signal });
			const out = result.stdout.trim();
			if (result.code !== 0 || !out || out.includes("\n") || out.length > MAX_FIELD_CHARS) {
				return undefined;
			}
			return out;
		} catch {
			return undefined;
		}
	};
	const [origin, branch, originHead] = await Promise.all([
		run(["remote", "get-url", "origin"]),
		run(["rev-parse", "--abbrev-ref", "HEAD"]),
		run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
	]);
	const context: GitContext = {};
	const url = origin === undefined ? undefined : publicRemoteUrl(origin);
	if (url) context.origin = url;
	// A detached HEAD reports the literal "HEAD", which says nothing.
	if (branch && branch !== "HEAD") context.branch = branch;
	if (originHead?.startsWith("origin/")) context.default_branch = originHead.slice("origin/".length);
	return Object.keys(context).length > 0 ? context : undefined;
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
			return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
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
