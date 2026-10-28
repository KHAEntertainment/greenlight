import { describe, expect, test } from "bun:test";
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
