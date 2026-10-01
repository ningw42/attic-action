import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

const readCommandFile = (path: string): Record<string, string> => {
	const result: Record<string, string> = {};
	const lines = readFileSync(path, "utf8").split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i]) continue;
		const [key, delimiter] = lines[i]!.split("<<");
		assert.ok(key && delimiter);
		const value = [];
		while (lines[++i] !== delimiter) {
			assert.ok(i < lines.length);
			value.push(lines[i]);
		}
		result[key] = value.join("\n");
	}
	return result;
};

const queryPrefix = ["--extra-experimental-features", "nix-command"];
const configQuery = [...queryPrefix, "config", "show", "--json"];
const legacyQuery = [...queryPrefix, "show-config", "--json"];
const fixture = (
	t: TestContext,
	mode: Mode,
	options: {
		format?: Format;
		skipPush?: boolean;
		query?: "legacy" | "invalid" | "missing" | "malformed" | "failed";
	} = {},
) => {
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
if (args[0] === "--extra-experimental-features") {
	const calls = readFileSync(process.env.TEST_ATTIC_LOG, "utf8").trim().split("\\n").map(line => JSON.parse(line));
	assert.equal(calls.at(-1).args[0], "use", "query effective settings only after attic use");
	assert.deepEqual(args.slice(0, 2), ["--extra-experimental-features", "nix-command"]);
	const modern = JSON.stringify(args.slice(2)) === JSON.stringify(["config", "show", "--json"]);
	assert.ok(modern || JSON.stringify(args.slice(2)) === JSON.stringify(["show-config", "--json"]));
	if (process.env.TEST_QUERY === "failed" || (modern && process.env.TEST_QUERY === "legacy")) process.exit(1);
	if (process.env.TEST_QUERY === "malformed") console.log("not json");
	else console.log(JSON.stringify(process.env.TEST_QUERY === "invalid" ? { "post-build-hook": { value: null } }
		: process.env.TEST_QUERY === "missing" ? {} : { "post-build-hook": { value: process.env.TEST_ACTIVE_HOOK } }));
} else if (JSON.stringify(args) === JSON.stringify(["path-info", "--help"])) {
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
		TEST_QUERY: options.query,
		TEST_ACTIVE_HOOK: originalHook,
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

	const run = (command: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}, warning?: string) => {
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
		assert.deepEqual(
			output.split("\n").filter((line) => line.startsWith("::warning::")),
			warning ? [warning] : [],
		);
		assert.doesNotMatch(
			output,
			/::error\b|Action (?:failed with|encountered) error|Not considering errors during push a failure|^\s*error:/m,
		);
		assert.equal(result.stderr, "", output);
	};

	const state = () => readCommandFile(githubState);
	const wrapper = () => join(dirname(state()["post_build_hook-paths-dir"]!), "post-build-hook.js");
	return {
		root,
		state,
		wrapper,
		runnerTemp,
		githubEnv,
		snapshot: join(runnerTemp, "attic-action-store-paths"),
		setPaths: (paths: string[]) => writeFileSync(pathsFile, JSON.stringify(paths)),
		nixCalls: () => readLog<string[]>(nixLog),
		atticCalls: () => readLog<AtticCall>(atticLog),
		setup: () => run(process.execPath, [join(bundleDir, "index.js")]),
		setupFailure: () =>
			spawnSync(process.execPath, [join(bundleDir, "index.js")], { cwd: root, env, encoding: "utf8" }),
		// Replay only GitHub's saved state, not exported ATTIC_* environment variables.
		post: (warning?: string) =>
			run(
				process.execPath,
				[join(bundleDir, "index.js")],
				Object.fromEntries(Object.entries(state()).map(([key, value]) => ["STATE_" + key, value])),
				warning,
			),
		hook: (outPaths: string) => run(wrapper(), [], { OUT_PATHS: outPaths }),
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
	assert.deepEqual(f.nixCalls(), [configQuery]);
	assert.deepEqual(Object.keys(f.state()).sort(), [
		"isPost",
		"post_build_hook-events-log",
		"post_build_hook-paths-dir",
	]);
	assert.deepEqual(Object.keys(readCommandFile(f.githubEnv)).sort(), [
		"ATTIC_POST_BUILD_EVENTS_LOG",
		"ATTIC_POST_BUILD_PATHS_DIR",
		"NIX_CONFIG",
	]);
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

test("hook discovery falls back to the legacy Nix/Lix configuration query", (t) => {
	const f = fixture(t, "post-build-hook", { query: "legacy" });
	f.setup();
	f.hook(kept.join(" "));
	f.post();
	assert.deepEqual(f.nixCalls(), [configQuery, legacyQuery]);
	assert.deepEqual(f.atticCalls(), [...loginCalls, { args: expectedPushArgs, stdin: kept.join("\n") }]);
});

for (const query of ["invalid", "missing", "malformed", "failed"] as const) {
	test(`hook configuration fails safely on ${query} effective configuration`, (t) => {
		const f = fixture(t, "post-build-hook", { query });
		const result = f.setupFailure();
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.match(result.stdout, /Action failed with error/);
		assert.deepEqual(readdirSync(f.runnerTemp), [], "must not replace a hook whose effective value is unknown");
	});
}

test("malformed diagnostic records cannot prevent pushing legitimate hook captures", (t) => {
	const f = fixture(t, "post-build-hook");
	f.setup();
	f.hook(kept.join(" "));
	const invalid = [null, 42, "scalar", { paths: "not-an-array" }, { chained: { status: {} } }, { error: null }];
	appendFileSync(
		f.state()["post_build_hook-events-log"]!,
		invalid.map((value) => JSON.stringify(value)).join("\n") + "\n",
	);
	f.post("::warning::Ignored 6 malformed event log line(s).");
	assert.deepEqual(f.atticCalls(), [...loginCalls, { args: expectedPushArgs, stdin: kept.join("\n") }]);
});

test("collector directories stay private and event log stays runner-owned", (t) => {
	const f = fixture(t, "post-build-hook");
	f.setup();
	f.hook(kept.join(" "));
	const paths = f.state()["post_build_hook-paths-dir"]!;
	const log = f.state()["post_build_hook-events-log"]!;
	assert.equal(statSync(dirname(paths)).mode & 0o7777, 0o700);
	assert.equal(statSync(paths).mode & 0o7777, 0o700);
	assert.equal(statSync(log).mode & 0o7777, 0o600);
	assert.equal(statSync(log).uid, process.getuid!());
	f.post();
});

test(
	"unrelated UID cannot inject captures; root hook outputs remain readable by runner",
	{
		skip:
			process.env["ATTIC_TEST_PRIVILEGED"] !== "1" &&
			"set ATTIC_TEST_PRIVILEGED=1 with passwordless sudo for cross-UID proof",
	},
	(t) => {
		assert.notEqual(process.getuid!(), 0, "run as a non-root runner to exercise cross-owner readback");
		const f = fixture(t, "post-build-hook");
		f.setup();
		chmodSync(f.root, 0o755);
		chmodSync(f.runnerTemp, 0o755);
		const probe = join(f.runnerTemp, "public-probe");
		writeFileSync(probe, "reachable", { mode: 0o644 });
		const paths = f.state()["post_build_hook-paths-dir"]!;
		const log = f.state()["post_build_hook-events-log"]!;
		const attack = spawnSync(
			"sudo",
			[
				"-n",
				"-u",
				"#65534",
				"--",
				"/bin/sh",
				"-c",
				// The project's downloaded Node may itself live under a private home.
				// A public shell makes the capture directory the actual access barrier.
				'read -r marker < "$1"; test "$marker" = reachable || exit 10; if (: > "$2/paths.untrusted") 2>/dev/null; then exit 11; fi; if (printf null >> "$3") 2>/dev/null; then exit 12; fi; if ln -s "$1" "$2/paths.link" 2>/dev/null; then exit 13; fi; exit 0',
				"capture-injection-test",
				probe,
				paths,
				log,
			],
			{ encoding: "utf8" },
		);
		assert.equal(attack.status, 0, attack.stdout + attack.stderr);

		const daemon = spawnSync(
			"sudo",
			[
				"-n",
				"--",
				process.execPath,
				"-e",
				'process.umask(0o077); require("node:child_process").execFileSync(process.argv[1], [], {env: {...process.env, OUT_PATHS:process.argv[2]}, stdio:"inherit"});',
				f.wrapper(),
				kept.join(" "),
			],
			{ encoding: "utf8", env: { ...process.env, NODE_V8_COVERAGE: "" } },
		);
		assert.equal(daemon.status, 0, daemon.stdout + daemon.stderr);
		const captured = readdirSync(paths).filter((name) => name.startsWith("paths."));
		assert.equal(captured.length, 1);
		assert.equal(statSync(join(paths, captured[0]!)).uid, 0);
		assert.equal(statSync(join(paths, captured[0]!)).mode & 0o777, 0o644);
		assert.equal(statSync(paths).uid, process.getuid!());
		assert.equal(statSync(paths).mode & 0o777, 0o700);
		assert.equal(statSync(log).uid, process.getuid!());
		f.post();
		assert.deepEqual(f.atticCalls(), [...loginCalls, { args: expectedPushArgs, stdin: kept.join("\n") }]);
	},
);
