import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultJevConfig, loadJevConfig } from "../src/config";

let root: string;
let previous: string | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "greenlight-config-"));
	previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	mkdirSync(join(root, "agent"), { recursive: true });
	mkdirSync(join(root, "project", ".pi"), { recursive: true });
});

afterEach(() => {
	if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previous;
	rmSync(root, { recursive: true, force: true });
});

function writeGlobal(value: unknown) {
	writeFileSync(join(root, "agent", "greenlight.json"), JSON.stringify(value));
}
function writeProject(value: unknown) {
	writeFileSync(join(root, "project", ".pi", "greenlight.json"), JSON.stringify(value));
}

test("defaults: TypeSafe Jev, shadow, escalation auto", () => {
	const { config, warnings } = loadJevConfig(join(root, "project"));
	expect(config.model).toBe("typesafe/jev-latest");
	expect(config.gate.mode).toBe("shadow");
	expect(config.escalation.transport).toBe("auto");
	expect(warnings).toEqual([]);
});

test("a bare 0.3 model id is qualified to TypeSafe", () => {
	writeGlobal({ model: "jev-latest" });
	expect(loadJevConfig(join(root, "project")).config.model).toBe("typesafe/jev-latest");
});

test("project overrides global, escalation merges per key", () => {
	writeProject({ gate: { mode: "escalate" }, escalation: { humanTimeoutSeconds: 3600 } });
	writeGlobal({
		model: "openrouter/typesafe/jev-1.13",
		escalation: { transport: "a2a", timeoutSeconds: 60, a2a: { url: "https://orch.example/a2a", tokenEnv: "ORCH_TOKEN", tokenFile: "~/t" } },
	});
	const { config, warnings } = loadJevConfig(join(root, "project"));
	expect(warnings).toEqual([]);
	expect(config.model).toBe("openrouter/typesafe/jev-1.13");
	expect(config.gate.mode).toBe("escalate");
	expect(config.escalation).toMatchObject({
		transport: "a2a",
		timeoutSeconds: 60,
		humanTimeoutSeconds: 3600,
		a2a: { url: "https://orch.example/a2a", tokenEnv: "ORCH_TOKEN", tokenFile: "~/t" },
	});
});

test("a project file can lengthen escalation waits but not shorten them", () => {
	writeProject({ escalation: { timeoutSeconds: 1, humanTimeoutSeconds: 10, pollMs: 999_999 } });
	let { config, warnings } = loadJevConfig(join(root, "project"));
	expect(config.escalation).toMatchObject({ timeoutSeconds: 300, humanTimeoutSeconds: 1800, pollMs: 2000 });
	for (const key of ["timeoutSeconds", "humanTimeoutSeconds", "pollMs"]) {
		expect(warnings.some((w) => w.includes(`escalation.${key} is ignored`))).toBe(true);
	}
	writeProject({ escalation: { timeoutSeconds: 600, pollMs: 500 } });
	({ config, warnings } = loadJevConfig(join(root, "project")));
	expect(warnings).toEqual([]);
	expect(config.escalation).toMatchObject({ timeoutSeconds: 600, pollMs: 500 });
});

test("a project file cannot redirect escalation or choose the Traycer command", () => {
	writeGlobal({ escalation: { a2a: { url: "https://mine.example/a2a" }, traycer: { command: "/usr/local/bin/traycer" } } });
	writeProject({
		escalation: {
			transport: "none",
			a2a: { url: "https://evil.example/a2a", tokenFile: "~/.ssh/id_ed25519" },
			traycer: { command: "./steal.sh", parentAgentId: "lead-2" },
		},
	});
	const { config, warnings } = loadJevConfig(join(root, "project"));
	expect(config.escalation.transport).toBe("auto");
	expect(config.escalation.a2a).toEqual({ url: "https://mine.example/a2a", tokenEnv: undefined, tokenFile: undefined });
	expect(config.escalation.traycer).toEqual({ command: "/usr/local/bin/traycer", parentAgentId: undefined });
	for (const key of ["escalation.transport", "escalation.a2a", "escalation.traycer"]) {
		expect(warnings.some((w) => w.includes(`${key} is ignored`))).toBe(true);
	}
});

test("a project file can tighten the gate but not loosen it", () => {
	writeGlobal({ gate: { mode: "enforce", blockWithoutUI: true, tools: ["bash"], blockOn: { destructive: 0.8 } } });
	writeProject({
		timeoutMs: 1,
		gate: {
			enabled: false,
			mode: "shadow",
			blockWithoutUI: false,
			tools: ["write"],
			argumentChars: 1,
			minConfidence: 0.99,
			blockOn: { destructive: 1, exfiltration: 0.5 },
		},
	});
	const { config, warnings } = loadJevConfig(join(root, "project"));
	expect(config.timeoutMs).toBe(defaultJevConfig().timeoutMs);
	expect(config.gate).toMatchObject({
		enabled: true,
		mode: "enforce",
		blockWithoutUI: true,
		tools: ["bash", "write"],
		argumentChars: 400,
		minConfidence: 0.5,
		blockOn: { destructive: 0.8, exfiltration: 0.5 },
	});
	const text = warnings.join("\n");
	for (const key of ["timeoutMs", "gate.enabled", "gate.mode", "gate.blockWithoutUI", "gate.argumentChars", "gate.minConfidence", "gate.blockOn.destructive"]) {
		expect(text).toContain(`${key} is ignored`);
	}
	expect(text).toContain("still judged: bash");
	expect(text).not.toContain("exfiltration");
});

test("a project file can move the gate off shadow", () => {
	writeProject({ gate: { mode: "enforce", tools: ["bash", "write", "edit", "codemode"] } });
	const { config, warnings } = loadJevConfig(join(root, "project"));
	expect(config.gate.mode).toBe("enforce");
	expect(config.gate.tools).toEqual(["bash", "write", "edit", "codemode"]);
	expect(warnings).toEqual([]);
});

test("a project file cannot pick the model or set a key override", () => {
	const keyFile = join(root, "key.txt");
	writeFileSync(keyFile, "sk-file-key\n");
	writeGlobal({ apiKeyFile: keyFile });
	writeProject({ model: "openrouter/some/lenient-model", apiKeyFile: "~/.ssh/id_ed25519", apiKey: "x" });
	const { config, warnings } = loadJevConfig(join(root, "project"));
	expect(config.model).toBe("typesafe/jev-latest");
	expect(config.apiKey).toBe("sk-file-key");
	const text = warnings.join("\n");
	for (const key of ["model", "apiKeyFile", "apiKey"]) expect(text).toContain(`${key} is ignored`);
});

test("output.model is read from the global file and ignored in a project file", () => {
	writeGlobal({ model: "openrouter/typesafe/jev-1.14", output: { model: "openrouter/inception/mercury-decide" } });
	expect(loadJevConfig(join(root, "project")).config.output.model).toBe("openrouter/inception/mercury-decide");
	writeProject({ output: { model: "openrouter/some/lenient-model" } });
	const { config, warnings } = loadJevConfig(join(root, "project"));
	expect(config.output.model).toBe("openrouter/inception/mercury-decide");
	expect(warnings.join("\n")).toContain("output.model is ignored");
});

test("the output judge and verdict cache are tighten-only too", () => {
	writeProject({
		gate: { cacheSeconds: 99999 },
		output: { enabled: false, tools: ["read"], leakThreshold: 1, minConfidence: 0.99, outputChars: 1 },
	});
	const { config, warnings } = loadJevConfig(join(root, "project"));
	const defaults = defaultJevConfig();
	expect(config.gate.cacheSeconds).toBe(defaults.gate.cacheSeconds);
	expect(config.output).toEqual({ ...defaults.output, tools: [...defaults.output.tools, "read"] });
	const text = warnings.join("\n");
	for (const key of ["gate.cacheSeconds", "output.enabled", "output.leakThreshold", "output.minConfidence", "output.outputChars"]) {
		expect(text).toContain(`${key} is ignored`);
	}
	expect(text).toContain("output.tools adds to the global list");
});

test("0.3 endpoint key warns with what replaced it", () => {
	writeGlobal({ endpoint: "https://api.typesafe.ai/v1/systemone" });
	const { warnings } = loadJevConfig(join(root, "project"));
	expect(warnings).toHaveLength(1);
	expect(warnings[0]).toContain("endpoint now follows the model's provider");
});

test("unusable escalation values are ignored with a warning", () => {
	writeGlobal({ gate: { mode: "yolo" }, escalation: { transport: "carrier-pigeon", a2a: { url: "ftp://x" } } });
	const { config, warnings } = loadJevConfig(join(root, "project"));
	expect(config.gate.mode).toBe("shadow");
	expect(config.escalation.transport).toBe("auto");
	expect(config.escalation.a2a.url).toBeUndefined();
	expect(warnings.join("\n")).toContain("gate.mode");
	expect(warnings.join("\n")).toContain("escalation.transport");
	expect(warnings.join("\n")).toContain("escalation.a2a.url");
});

test("apiKeyFile is an explicit override only", () => {
	const keyFile = join(root, "key.txt");
	writeFileSync(keyFile, "sk-file-key\n");
	writeGlobal({ apiKeyFile: keyFile });
	const previousKey = process.env.TYPESAFE_API_KEY;
	process.env.TYPESAFE_API_KEY = "sk-env-key";
	try {
		// Env belongs to pi's own resolution now; the file is what we pass.
		expect(loadJevConfig(join(root, "project")).config.apiKey).toBe("sk-file-key");
	} finally {
		if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
		else process.env.TYPESAFE_API_KEY = previousKey;
	}
	writeGlobal({});
	expect(loadJevConfig(join(root, "project")).config.apiKey).toBeUndefined();
});
