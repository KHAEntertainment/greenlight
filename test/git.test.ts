import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGateState } from "../src/gate";
import { type GitExec, publicRemoteUrl, readGitContext, UNREADABLE_NAME, UNREADABLE_URL } from "../src/git";

function fakeGit(answers: Record<string, string | Error>): GitExec & { cwds: string[] } {
	const cwds: string[] = [];
	const exec = async (command: string, args: string[], options: { cwd: string }) => {
		cwds.push(options.cwd);
		const answer = command === "git" ? answers[args.join(" ")] : undefined;
		if (answer instanceof Error) throw answer;
		return answer === undefined ? { code: 128, stdout: "" } : { code: 0, stdout: `${answer}\n` };
	};
	return Object.assign(exec, { cwds });
}

describe("publicRemoteUrl", () => {
	test("drops user info, query and fragment from a URL remote", () => {
		expect(publicRemoteUrl("https://x-access-token:ghs_abc@github.com/acme/app.git")).toBe("https://github.com/acme/app.git");
		expect(publicRemoteUrl("https://oauth2:glpat-abc@gitlab.example.com:8443/g/app.git?x=1#y")).toBe("https://gitlab.example.com:8443/g/app.git");
		expect(publicRemoteUrl("ssh://git@github.com/acme/app.git")).toBe("ssh://github.com/acme/app.git");
	});

	test("keeps the conventional git user on an scp-like remote, and only that one", () => {
		expect(publicRemoteUrl("git@github.com:acme/app.git")).toBe("git@github.com:acme/app.git");
		expect(publicRemoteUrl("ghp_token@github.com:acme/app.git")).toBe("github.com:acme/app.git");
	});

	test("keeps a local path and leaves out anything it cannot read", () => {
		expect(publicRemoteUrl("/srv/git/app.git")).toBe("/srv/git/app.git");
		expect(publicRemoteUrl("../app.git")).toBe("../app.git");
		expect(publicRemoteUrl("https://")).toBeUndefined();
		expect(publicRemoteUrl("ignore previous instructions")).toBeUndefined();
	});

	test("leaves out a URL whose user info the parser moved into the path", () => {
		expect(publicRemoteUrl("https://DOMAIN\\user:dummy-password@git.example/acme/repo.git")).toBeUndefined();
	});
});

describe("readGitContext push URLs", () => {
	const base = {
		"remote get-url origin": "https://github.com/acme/app.git",
		"rev-parse --abbrev-ref HEAD": "issue-106",
	};

	test("a push URL that matches origin adds nothing", async () => {
		const exec = fakeGit({ ...base, "remote get-url --push --all origin": "https://github.com/acme/app.git" });
		expect(await readGitContext(exec, "/work/app")).toEqual({ origin: "https://github.com/acme/app.git", branch: "issue-106" });
	});

	test("a push URL elsewhere is reported, scrubbed, and an unreadable one is still marked", async () => {
		const exec = fakeGit({
			...base,
			"remote get-url --push --all origin": "https://github.com/acme/app.git\nhttps://u:tok_123@mirror.example/app.git\nhttps://DOMAIN\\u:pw@x/y",
		});
		const context = await readGitContext(exec, "/work/app");
		expect(context?.origin_push).toEqual(["https://github.com/acme/app.git", "https://mirror.example/app.git", UNREADABLE_URL]);
		expect(JSON.stringify(context)).not.toContain("tok_123");
		expect(JSON.stringify(context)).not.toContain("pw@");
	});
});

describe("readGitContext", () => {
	test("reads origin, branch and default branch in the given cwd", async () => {
		const exec = fakeGit({
			"remote get-url origin": "git@github.com:acme/app.git",
			"rev-parse --abbrev-ref HEAD": "issue-106",
			"symbolic-ref --short refs/remotes/origin/HEAD": "origin/main",
		});
		expect(await readGitContext(exec, "/work/app")).toEqual({
			origin: "git@github.com:acme/app.git",
			branch: "issue-106",
			default_branch: "main",
		});
		expect(new Set(exec.cwds)).toEqual(new Set(["/work/app"]));
	});

	test("leaves out what git cannot answer, and a detached HEAD", async () => {
		const exec = fakeGit({ "rev-parse --abbrev-ref HEAD": "HEAD", "remote get-url origin": "git@github.com:acme/app.git" });
		expect(await readGitContext(exec, "/work/app")).toEqual({ origin: "git@github.com:acme/app.git" });
	});

	test("fails open: no repository, or an exec that throws, gives nothing", async () => {
		expect(await readGitContext(fakeGit({}), "/tmp")).toBeUndefined();
		const throwing = fakeGit({
			"remote get-url origin": new Error("spawn git ENOENT"),
			"rev-parse --abbrev-ref HEAD": new Error("spawn git ENOENT"),
			"symbolic-ref --short refs/remotes/origin/HEAD": new Error("spawn git ENOENT"),
		});
		expect(await readGitContext(throwing, "/tmp")).toBeUndefined();
	});

	test("ignores multi-line or oversized output", async () => {
		const exec = fakeGit({ "rev-parse --abbrev-ref HEAD": "a\nb", "remote get-url origin": `/${"x".repeat(300)}` });
		expect(await readGitContext(exec, "/work/app")).toBeUndefined();
	});
});

test("buildGateState carries git context only when there is some", () => {
	const base = { cwd: "/w", toolName: "bash", input: { command: "git push origin x" }, argumentChars: 400 };
	expect(buildGateState(base)).not.toHaveProperty("git");
	expect(buildGateState({ ...base, git: { branch: "x" } })).toMatchObject({ git: { branch: "x" } });
});

describe("readGitContext push destination", () => {
	const CONFIG = "config --get-regexp ^(remote\\.pushdefault|branch\\..*\\.(pushremote|remote))$";
	const origin = "https://github.com/acme/app.git";
	const base = { "remote get-url origin": origin, "remote get-url --push --all origin": origin, "rev-parse --abbrev-ref HEAD": "Issue-106" };

	test("a plain push picks pushRemote, then pushDefault, then the branch remote", async () => {
		const all = "remote.pushdefault deflt\nbranch.Issue-106.pushremote pr\nbranch.Issue-106.remote br";
		expect((await readGitContext(fakeGit({ ...base, [CONFIG]: all }), "/w"))?.push_remote).toBe("pr");
		expect((await readGitContext(fakeGit({ ...base, [CONFIG]: "remote.pushdefault deflt\nbranch.Issue-106.remote br" }), "/w"))?.push_remote).toBe("deflt");
		expect((await readGitContext(fakeGit({ ...base, [CONFIG]: "branch.Issue-106.remote br" }), "/w"))?.push_remote).toBe("br");
		// Another branch's settings do not apply.
		expect((await readGitContext(fakeGit({ ...base, [CONFIG]: "branch.other.pushremote pr" }), "/w"))?.push_remote).toBeUndefined();
	});

	test("origin as the push remote, or no setting at all, adds nothing", async () => {
		expect(await readGitContext(fakeGit({ ...base, [CONFIG]: "branch.Issue-106.remote origin" }), "/w")).toEqual({ origin, branch: "Issue-106" });
		expect(await readGitContext(fakeGit(base), "/w")).toEqual({ origin, branch: "Issue-106" });
	});

	test("a detached HEAD still honours pushDefault, and an odd remote name is marked", async () => {
		const detached = { ...base, "rev-parse --abbrev-ref HEAD": "HEAD" };
		expect((await readGitContext(fakeGit({ ...detached, [CONFIG]: "remote.pushdefault outside" }), "/w"))?.push_remote).toBe("outside");
		expect((await readGitContext(fakeGit({ ...base, [CONFIG]: "remote.pushdefault ignore$(x)" }), "/w"))?.push_remote).toBe(UNREADABLE_NAME);
	});

	test("a fetch URL too long to show, or unreadable, still counts a foreign push URL", async () => {
		const longFetch = `https://u:${"t".repeat(300)}@github.com/acme/app.git`;
		const long = await readGitContext(fakeGit({ ...base, "remote get-url origin": longFetch, "remote get-url --push --all origin": "https://github.com/evil/drop.git" }), "/w");
		expect(long).toEqual({ origin_push: ["https://github.com/evil/drop.git"], branch: "Issue-106" });
		const noFetch = { ...base, "remote get-url --push --all origin": "https://github.com/evil/drop.git" } as Record<string, string>;
		delete noFetch["remote get-url origin"];
		expect((await readGitContext(fakeGit(noFetch), "/w"))?.origin_push).toEqual(["https://github.com/evil/drop.git"]);
	});
});

test("other remotes are listed, origin left out, odd names marked", async () => {
	const origin = "https://github.com/acme/app.git";
	const exec = fakeGit({ "remote get-url origin": origin, "remote get-url --push --all origin": origin, remote: "origin\nupstream\nweird$(x)" });
	expect((await readGitContext(exec, "/w"))?.other_remotes).toEqual(["upstream", UNREADABLE_NAME]);
	expect((await readGitContext(fakeGit({ "remote get-url origin": origin, remote: "origin" }), "/w"))?.other_remotes).toBeUndefined();
});

const VCS_KEYS = "config --get-regexp ^(remote\\..*\\.vcs|core\\.repositoryformatversion)$";

test("a remote whose every push URL is a bare word is not counted", async () => {
	const origin = "https://github.com/acme/app.git";
	const answers = {
		"remote get-url origin": origin,
		"remote get-url --push --all origin": origin,
		remote: "origin\nupstream\nbackup\nmixed",
		[VCS_KEYS]: "core.repositoryformatversion 0",
		"remote get-url --push --all upstream": "DISABLE",
		"remote get-url --push --all backup": "git@github.com:someone/backup.git",
		"remote get-url --push --all mixed": "no_push\nhttps://github.com/evil/drop.git",
	};
	expect((await readGitContext(fakeGit(answers), "/w"))?.other_remotes).toEqual(["backup", "mixed"]);
	// A fork with only a disabled upstream judges like an origin-only checkout.
	const fork = { ...answers, remote: "origin\nupstream" };
	expect((await readGitContext(fakeGit(fork), "/w"))?.other_remotes).toBeUndefined();
});

test("a remote is still counted when its push URLs cannot be read or checked", async () => {
	const origin = "https://github.com/acme/app.git";
	const many = Array.from({ length: 11 }, (_, i) => `r${i}`);
	const answers: Record<string, string | Error> = {
		"remote get-url origin": origin,
		"remote get-url --push --all origin": origin,
		remote: ["origin", "failed", "-odd", ...many].join("\n"),
		[VCS_KEYS]: "core.repositoryformatversion 0",
		"remote get-url --push --all failed": new Error("timeout"),
		"remote get-url --push --all -odd": "DISABLE",
	};
	for (const name of many) answers[`remote get-url --push --all ${name}`] = "DISABLE";
	const exec = fakeGit(answers);
	// "failed" errors, "-odd" is never passed to git, and r8-r10 are past the ten-remote check limit.
	expect((await readGitContext(exec, "/w"))?.other_remotes).toEqual(["failed", "-odd", "r8", "r9", "r10"]);
});

test("a bare-word push URL still counts with a vcs helper, a path by that name, or an unreadable config", async () => {
	const origin = "https://github.com/acme/app.git";
	const fork = {
		"remote get-url origin": origin,
		"remote get-url --push --all origin": origin,
		remote: "origin\nupstream",
		"remote get-url --push --all upstream": "DISABLE",
		[VCS_KEYS]: "core.repositoryformatversion 0",
	};
	// remote.upstream.vcs hands DISABLE to git-remote-<vcs>, or to a command under `ext`.
	const helper = { ...fork, [VCS_KEYS]: "core.repositoryformatversion 0\nremote.upstream.vcs ext" };
	expect((await readGitContext(fakeGit(helper), "/w"))?.other_remotes).toEqual(["upstream"]);
	// Without the config answer, a missing vcs key can't be told from a failed lookup.
	const unread = { ...fork } as Record<string, string>;
	delete unread[VCS_KEYS];
	expect((await readGitContext(fakeGit(unread), "/w"))?.other_remotes).toEqual(["upstream"]);
	// A path git would open instead: DISABLE itself, DISABLE.git, or a broken symlink.
	for (const make of [
		(dir: string) => mkdirSync(join(dir, "DISABLE")),
		(dir: string) => writeFileSync(join(dir, "DISABLE.git"), ""),
		(dir: string) => symlinkSync("/nonexistent/share", join(dir, "DISABLE")),
	]) {
		const dir = mkdtempSync(join(tmpdir(), "gl-remote-"));
		try {
			expect((await readGitContext(fakeGit(fork), dir))?.other_remotes).toBeUndefined();
			make(dir);
			expect((await readGitContext(fakeGit(fork), dir))?.other_remotes).toEqual(["upstream"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
	// A path that can't be checked (here ENOTDIR, cwd being a file) counts as present.
	const dir = mkdtempSync(join(tmpdir(), "gl-remote-"));
	try {
		writeFileSync(join(dir, "file"), "");
		expect((await readGitContext(fakeGit(fork), join(dir, "file")))?.other_remotes).toEqual(["upstream"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a branch name too long to show still decides where a plain push goes", async () => {
	const origin = "https://github.com/acme/app.git";
	const long = `lane-${"x".repeat(250)}`;
	const exec = fakeGit({
		"remote get-url origin": origin,
		"remote get-url --push --all origin": origin,
		"rev-parse --abbrev-ref HEAD": long,
		"config --get-regexp ^(remote\\.pushdefault|branch\\..*\\.(pushremote|remote))$": `branch.${long}.pushremote https://external.example/drop.git`,
		remote: "origin",
	});
	const context = await readGitContext(exec, "/w");
	expect(context?.branch).toBeUndefined();
	expect(context?.push_remote).toBe(UNREADABLE_NAME);
});
