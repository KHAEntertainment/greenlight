import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadJevConfig } from "../src/config";

let root: string;
let previous: string | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-jev-config-"));
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
	writeFileSync(join(root, "agent", "pi-jev.json"), JSON.stringify(value));
}
function writeProject(value: unknown) {
	writeFileSync(join(root, "project", ".pi", "pi-jev.json"), JSON.stringify(value));
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
	writeGlobal({
		model: "openrouter/typesafe/jev-1.13",
		gate: { mode: "enforce" },
		escalation: { timeoutSeconds: 60, a2a: { url: "https://orch.example/a2a", tokenEnv: "ORCH_TOKEN" } },
	});
	writeProject({ gate: { mode: "escalate" }, escalation: { transport: "a2a", a2a: { tokenFile: "~/t" } } });
	const { config, warnings } = loadJevConfig(join(root, "project"));
	expect(warnings).toEqual([]);
	expect(config.model).toBe("openrouter/typesafe/jev-1.13");
	expect(config.gate.mode).toBe("escalate");
	expect(config.escalation).toMatchObject({
		transport: "a2a",
		timeoutSeconds: 60,
		humanTimeoutSeconds: 1800,
		a2a: { url: "https://orch.example/a2a", tokenEnv: "ORCH_TOKEN", tokenFile: "~/t" },
	});
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
