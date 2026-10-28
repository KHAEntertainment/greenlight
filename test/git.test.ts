import { describe, expect, test } from "bun:test";
import { buildGateState } from "../src/gate";
import { type GitExec, publicRemoteUrl, readGitContext, UNREADABLE_URL } from "../src/git";

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
