import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

// Exercise the shipped CJS entrypoints without touching dist or relying on TS import resolution.
const bundleDir = mkdtempSync(join(tmpdir(), "attic-action-bundle-"));
before(() => {
	buildSync({
		entryPoints: ["index.ts", "post-build-hook.ts"].map((name) => fileURLToPath(new URL(name, import.meta.url))),
		outdir: bundleDir,
		bundle: true,
		platform: "node",
		format: "cjs",
		logLevel: "silent",
	});
});
after(() => rmSync(bundleDir, { recursive: true, force: true }));

type Mode = "store-scan" | "post-build-hook";
type Format = "v2" | "legacy";
type AtticCall = { args: string[]; stdin: string };

const pushArgs = `--jobs 2 --filter "two words" --filter 'three more words'`;
const expectedPushArgs = [
	"push",
	"--jobs",
	"2",
	"--filter",
	"two words",
	"--filter",
	"three more words",
	"--stdin",
	"test-cache",
];
const existing = "/nix/store/aaa-keep-existing";
const kept = ["/nix/store/bbb-keep-new", "/nix/store/ccc-also-new"];
const filtered = [
	"/nix/store/ddd-keep-excluded",
	"/nix/store/eee-unmatched",
	"/nix/store/fff-keep-build.drv",
	"/nix/store/ggg-keep-build.drv.chroot",
	"/nix/store/hhh-keep-build.check",
	"/nix/store/iii-keep-build.lock",
];
const loginCalls: AtticCall[] = [
	{ args: ["login", "--set-default", "test-cache", "https://cache.invalid", "test-token"], stdin: "" },
	{ args: ["use", "test-cache"], stdin: "" },
];

const readLog = <T>(path: string): T[] =>
	readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as T);

const fixture = (t: TestContext, mode: Mode, options: { format?: Format; skipPush?: boolean } = {}) => {
	const root = mkdtempSync(join(tmpdir(), "attic-action-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const bin = join(root, "bin");
	const runnerTemp = join(root, "runner");
	mkdirSync(bin);
	mkdirSync(runnerTemp);
	const pathsFile = join(root, "store.json");
	const nixLog = join(root, "nix.jsonl");
	const atticLog = join(root, "attic.jsonl");
	const githubEnv = join(root, "github-env");
	const githubState = join(root, "github-state");
	for (const path of [nixLog, atticLog, githubEnv, githubState]) writeFileSync(path, "");
	writeFileSync(pathsFile, "[]");

	const executable = (name: string, source: string) => {
		const path = join(bin, name);
		writeFileSync(path, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
		return path;
	};
	executable(
		"nix",
		`
const assert = require("node:assert/strict");
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const v2 = process.env.TEST_NIX_FORMAT === "v2";
appendFileSync(process.env.TEST_NIX_LOG, JSON.stringify(args) + "\\n");
if (JSON.stringify(args) === JSON.stringify(["path-info", "--help"])) {
	console.log(v2 ? "path-info --json --json-format" : "path-info --json");
} else {
	assert.deepEqual(args, ["path-info", "--all", "--json", ...(v2 ? ["--json-format", "2"] : [])]);
	const paths = JSON.parse(readFileSync(process.env.TEST_STORE_PATHS, "utf8"));
	console.log(JSON.stringify(v2
		? { storeDir: "/nix/store", info: Object.fromEntries(paths.map(path => [path.slice("/nix/store/".length), {}])) }
		: paths.map(path => ({ path }))));
}
`,
	);
	executable(
		"attic",
		`
const assert = require("node:assert/strict");
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
assert.ok(["login", "use", "push"].includes(args[0]), "Unexpected attic invocation: " + args);
const stdin = args[0] === "push" ? readFileSync(0, "utf8") : "";
appendFileSync(process.env.TEST_ATTIC_LOG, JSON.stringify({ args, stdin }) + "\\n");
`,
	);
	// A harmless existing hook avoids the intentional "No existing post-build hook" warning.
	const originalHook = executable("original-hook", "process.exit(0);");

	// Deliberately do not inherit INPUT_*, STATE_*, NIX_*, NODE_OPTIONS, or the user's PATH/config.
	const env: NodeJS.ProcessEnv = {
		PATH: bin,
		HOME: root,
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_CACHE_HOME: join(root, "cache"),
		TMPDIR: root,
		RUNNER_TEMP: runnerTemp,
		GITHUB_ENV: githubEnv,
		GITHUB_STATE: githubState,
		NIX_CONFIG: `post-build-hook = ${originalHook}`,
		TEST_NIX_FORMAT: options.format ?? "v2",
		TEST_STORE_PATHS: pathsFile,
		TEST_NIX_LOG: nixLog,
		TEST_ATTIC_LOG: atticLog,
		INPUT_ENDPOINT: "https://cache.invalid",
		INPUT_CACHE: "test-cache",
		INPUT_TOKEN: "test-token",
		"INPUT_PATH-DISCOVERY-MODE": mode,
		"INPUT_PUSH-ARGS": pushArgs,
		"INPUT_INCLUDE-PATHS": "-keep-\n-also-",
		"INPUT_EXCLUDE-PATHS": "-excluded$",
		"INPUT_SKIP-PUSH": options.skipPush ? "true" : "false",
	};

	const run = (command: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) => {
		const result = spawnSync(command, args, {
			cwd: root,
			env: { ...env, ...extraEnv },
			encoding: "utf8",
			timeout: 15_000,
		});
		const output = `${result.stdout}\n${result.stderr}`;
		assert.ifError(result.error);
		assert.equal(result.status, 0, output);
		// The post step catches errors without setting a failing exit code.
		assert.doesNotMatch(
			output,
			/::(?:error|warning)\b|Action (?:failed with|encountered) error|Not considering errors during push a failure|^\s*error:/m,
		);
		assert.equal(result.stderr, "", output);
	};

	return {
		runnerTemp,
		githubEnv,
		snapshot: join(runnerTemp, "attic-action-store-paths"),
		setPaths: (paths: string[]) => writeFileSync(pathsFile, JSON.stringify(paths)),
		nixCalls: () => readLog<string[]>(nixLog),
		atticCalls: () => readLog<AtticCall>(atticLog),
		setup: () => run(process.execPath, [join(bundleDir, "index.js")]),
		post: () => run(process.execPath, [join(bundleDir, "index.js")], { STATE_isPost: "true" }),
		hook: (outPaths: string) =>
			run(join(runnerTemp, "attic-action-post-build-hook", "post-build-hook.js"), [], { OUT_PATHS: outPaths }),
	};
};

for (const format of ["v2", "legacy"] as const) {
	test(`store-scan selects only new filtered paths from ${format} JSON and preserves quoted push-args`, (t) => {
		const f = fixture(t, "store-scan", { format });
		const beforePaths = [existing, "/nix/store/zzz-keep-removed"];
		f.setPaths(beforePaths);
		f.setup();
		assert.deepEqual(f.atticCalls(), loginCalls);
		assert.equal(readFileSync(f.snapshot, "utf8"), beforePaths.join("\n"));

		const afterPaths = [existing, ...kept, ...filtered];
		f.setPaths(afterPaths);
		f.post();
		assert.equal(readFileSync(f.snapshot, "utf8"), afterPaths.join("\n"));
		assert.deepEqual(f.atticCalls(), [...loginCalls, { args: expectedPushArgs, stdin: kept.join("\n") }]);
		const scan = ["path-info", "--all", "--json", ...(format === "v2" ? ["--json-format", "2"] : [])];
		assert.deepEqual(f.nixCalls(), [["path-info", "--help"], scan, ["path-info", "--help"], scan]);
	});
}

test("post-build-hook pushes unique filtered outputs with quoted push-args and no store scan", (t) => {
	const f = fixture(t, "post-build-hook");
	f.setup();
	assert.deepEqual(f.atticCalls(), loginCalls);
	// Exercise the generated executable itself, with no node executable available on PATH.
	f.hook([kept[1], ...filtered, kept[0], kept[0]].join(" \t"));
	f.hook(kept.join("\n"));
	f.post();
	assert.deepEqual(f.atticCalls(), [...loginCalls, { args: expectedPushArgs, stdin: kept.join("\n") }]);
	assert.deepEqual(f.nixCalls(), []);
});

for (const mode of ["store-scan", "post-build-hook"] as const) {
	test(`skip-push avoids all discovery and pushes in ${mode} mode`, (t) => {
		const f = fixture(t, mode, { skipPush: true });
		f.setPaths([existing]);
		f.setup();
		assert.deepEqual(f.atticCalls(), loginCalls);
		f.setPaths([existing, ...kept]);
		f.post();
		assert.deepEqual(f.atticCalls(), loginCalls);
		assert.deepEqual(f.nixCalls(), []);
		assert.deepEqual(readdirSync(f.runnerTemp), [], "no snapshot or hook collector should be created");
		assert.equal(readFileSync(f.githubEnv, "utf8"), "", "discovery should not export environment variables");
	});
}
