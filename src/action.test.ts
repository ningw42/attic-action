import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	copyFileSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
type Trust = "true" | "false" | "omitted" | "nonboolean" | "malformed" | "nonzero-true" | "nonzero-false" | "thrown";
type Validity = "nonzero" | "partial-nonzero" | "foreign-output" | "thrown" | "later-nonzero";
type AtticCall = { args: string[]; stdin: string };
type RunOptions = {
	env?: NodeJS.ProcessEnv;
	warnings?: (string | RegExp)[];
	postFailure?: boolean;
	node?: string;
};

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

const assertFlatGroups = (output: string): string[] => {
	let open: string | undefined;
	const groups: string[] = [];
	for (const line of output.split("\n")) {
		if (line.startsWith("::group::")) {
			assert.equal(open, undefined, `Nested group inside ${open}: ${line}\n${output}`);
			open = line.slice("::group::".length);
			groups.push(open);
		} else if (line === "::endgroup::") {
			assert.notEqual(open, undefined, `Unmatched group end\n${output}`);
			open = undefined;
		}
	}
	assert.equal(open, undefined, `Unclosed group: ${open}\n${output}`);
	return groups;
};

const queryPrefix = ["--extra-experimental-features", "nix-command"];
const trustQuery = [...queryPrefix, "store", "ping", "--json"];
const configQuery = [...queryPrefix, "config", "show", "--json"];
const legacyQuery = [...queryPrefix, "show-config", "--json"];
const validityFlags = ["--check-validity", "--print-invalid"];
const unknownTrustWarning = /^::warning::Unable to determine Nix store trust\b/;
const validationFailureWarning =
	/^::warning::Action encountered error: Error: Unable to validate Nix store paths; skipping upload:/;
const fixture = (
	t: TestContext,
	mode: Mode,
	options: {
		format?: Format;
		skipPush?: boolean;
		query?: "legacy" | "invalid" | "missing" | "malformed" | "failed";
		trust?: Trust;
		validity?: Validity;
		originalHook?: "success" | "malformed-header" | "nonzero" | "signal" | "missing";
	} = {},
) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "attic-action-test-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const bin = join(root, "bin");
	const runnerTemp = join(root, "runner");
	const fakeStore = join(root, "fake-store");
	for (const path of [bin, runnerTemp, fakeStore]) mkdirSync(path);
	const pathsFile = join(root, "store.json");
	const registeredFile = join(root, "registered.json");
	const nixLog = join(root, "nix.jsonl");
	const validityLog = join(root, "nix-store.jsonl");
	const atticLog = join(root, "attic.jsonl");
	const chainLog = join(root, "chain.jsonl");
	const githubEnv = join(root, "github-env");
	const githubState = join(root, "github-state");
	for (const path of [nixLog, validityLog, atticLog, chainLog, githubEnv, githubState]) writeFileSync(path, "");
	writeFileSync(pathsFile, "[]");

	// Store metadata and filesystem existence are independent: an existing path
	// need not be registered, and a once-registered path may have been deleted.
	const setValidPaths = (paths: string[]) => {
		writeFileSync(registeredFile, JSON.stringify(paths));
		for (const path of paths) writeFileSync(join(fakeStore, basename(path)), "store object");
	};
	setValidPaths([existing, ...kept, ...filtered]);

	const executable = (name: string, source: string) => {
		const path = join(bin, name);
		writeFileSync(path, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
		return path;
	};
	executable(
		"nix",
		`
const assert = require("node:assert/strict");
const { appendFileSync, readFileSync, readdirSync } = require("node:fs");
const args = process.argv.slice(2);
const v2 = process.env.TEST_NIX_FORMAT === "v2";
appendFileSync(process.env.TEST_NIX_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "--extra-experimental-features") {
	const calls = readFileSync(process.env.TEST_ATTIC_LOG, "utf8").trim().split("\\n").map(line => JSON.parse(line));
	assert.equal(calls.at(-1).args[0], "use", "query effective settings only after attic use");
	assert.deepEqual(args.slice(0, 2), ["--extra-experimental-features", "nix-command"]);
	if (JSON.stringify(args.slice(2)) === JSON.stringify(["store", "ping", "--json"])) {
		assert.deepEqual(readdirSync(process.env.RUNNER_TEMP).filter(name => name.startsWith("attic-action-")), [], "trust precedes collector creation");
		const trust = process.env.TEST_TRUST;
		if (trust === "malformed") console.log("not json");
		else console.log(JSON.stringify(trust === "omitted" ? {} : { trusted: trust === "nonboolean" ? "true" : !["false", "nonzero-false"].includes(trust) }));
		process.exit(trust.startsWith("nonzero-") ? 1 : 0);
	}
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
		"nix-store",
		`
const assert = require("node:assert/strict");
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_VALIDITY_LOG, JSON.stringify(args) + "\\n");
assert.deepEqual(args.slice(0, 2), ["--check-validity", "--print-invalid"]);
const paths = args.slice(2);
assert.ok(paths.length > 0 && paths.length <= 128, "bounded, nonempty path count");
assert.ok(["nix-store", ...args].reduce((n, arg) => n + Buffer.byteLength(arg) + 1, 0) <= 16 * 1024, "bounded argv bytes");
const mode = process.env.TEST_VALIDITY;
const calls = readFileSync(process.env.TEST_VALIDITY_LOG, "utf8").trim().split("\\n").length;
if (mode === "nonzero" || mode === "partial-nonzero" || (mode === "later-nonzero" && calls > 1)) {
	if (mode === "partial-nonzero") console.log(paths[0]);
	console.error("validity database unavailable");
	process.exit(2);
}
if (mode === "foreign-output") {
	console.log("/nix/store/not-a-candidate");
	process.exit(0);
}
const registered = new Set(JSON.parse(readFileSync(process.env.TEST_REGISTERED, "utf8")));
for (const path of paths) {
	if (!registered.has(path) || !existsSync(join(process.env.TEST_FAKE_STORE, basename(path)))) console.log(path);
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
	let originalHook = options.originalHook
		? options.originalHook === "missing"
			? join(bin, "missing-original-hook")
			: executable(
					"original-hook",
					`require("node:fs").appendFileSync(process.env.TEST_CHAIN_LOG, JSON.stringify({ args: process.argv.slice(2), outPaths: process.env.OUT_PATHS }) + "\\n");
if (process.env.TEST_CHAIN === "signal") process.kill(process.pid, "SIGTERM");
else process.exit(process.env.TEST_CHAIN === "nonzero" ? 7 : 0);`,
				)
		: "";

	if (options.originalHook === "malformed-header") {
		originalHook = join(bin, "cachix's post-build-hook.sh");
		// Cachix generates a leading newline and indentation before its shebang.
		// Exercise this via the generated launcher and bundled collector on macOS.
		writeFileSync(originalHook, '\n    #!/usr/bin/env bash\n    set -eu\n    exec original-hook "$@"\n', {
			mode: 0o755,
		});
	}

	// Make getExecOutput reject only for the trust command. Removing nix itself
	// would also break the later effective-config query, obscuring policy.
	const probePreload = join(root, "throw-probe.cjs");
	writeFileSync(
		probePreload,
		`const cp = require("node:child_process");
const spawn = cp.spawn;
cp.spawn = function(command, args, ...rest) {
	if (JSON.stringify(args) === JSON.stringify(${JSON.stringify(trustQuery)})) {
		require("node:fs").appendFileSync(process.env.TEST_NIX_LOG, JSON.stringify(args) + "\\n");
		return spawn.call(this, command + "-missing-for-trust-test", args, ...rest);
	}
	return spawn.call(this, command, args, ...rest);
};\n`,
	);

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
		NIX_CONFIG: originalHook ? `post-build-hook = ${originalHook}` : "",
		NODE_OPTIONS: options.trust === "thrown" ? `--require=${probePreload}` : undefined,
		NODE_V8_COVERAGE: "",
		TEST_NIX_FORMAT: options.format ?? "v2",
		TEST_QUERY: options.query,
		TEST_TRUST: options.trust ?? "true",
		TEST_VALIDITY: options.validity,
		TEST_ACTIVE_HOOK: originalHook,
		TEST_CHAIN: options.originalHook,
		TEST_CHAIN_LOG: chainLog,
		TEST_STORE_PATHS: pathsFile,
		TEST_REGISTERED: registeredFile,
		TEST_FAKE_STORE: fakeStore,
		TEST_NIX_LOG: nixLog,
		TEST_VALIDITY_LOG: validityLog,
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

	const execute = (command: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
		spawnSync(command, args, {
			cwd: root,
			env: { ...env, ...extraEnv },
			encoding: "utf8",
			timeout: 15_000,
		});
	const run = (command: string, args: string[], options: RunOptions = {}) => {
		const result = execute(command, args, options.env);
		const output = `${result.stdout}\n${result.stderr}`;
		assert.ifError(result.error);
		assert.equal(result.status, 0, output);
		// The post step catches errors without setting a failing exit code.
		const warnings = output.split("\n").filter((line) => line.startsWith("::warning::"));
		assert.equal(warnings.length, options.warnings?.length ?? 0, output);
		for (const [index, expected] of (options.warnings ?? []).entries()) {
			if (typeof expected === "string") assert.equal(warnings[index], expected, output);
			else assert.match(warnings[index]!, expected, output);
		}
		assert.doesNotMatch(output, /::error\b|Action failed with error|^error:/m);
		if (options.postFailure) {
			assert.match(output, /Not considering errors during push a failure/);
		} else {
			assert.doesNotMatch(output, /Action encountered error|Not considering errors during push a failure/);
		}
		assert.equal(result.stderr, "", output);
		assertFlatGroups(output);
		return output;
	};

	const state = () => readCommandFile(githubState);
	const wrapper = () => join(dirname(state()["post_build_hook-paths-dir"]!), "post-build-hook.sh");
	return {
		root,
		state,
		wrapper,
		runnerTemp,
		githubEnv,
		snapshot: join(runnerTemp, "attic-action-store-paths"),
		setValidPaths,
		setPaths: (paths: string[]) => {
			writeFileSync(pathsFile, JSON.stringify(paths));
			setValidPaths(paths);
		},
		deleteStorePath: (path: string) => rmSync(join(fakeStore, basename(path))),
		unregisterStorePath: (path: string) => {
			assert.ok(existsSync(join(fakeStore, basename(path))), "unregistered path must still exist");
			const registered = JSON.parse(readFileSync(registeredFile, "utf8")) as string[];
			writeFileSync(registeredFile, JSON.stringify(registered.filter((candidate) => candidate !== path)));
		},
		nixCalls: () => readLog<string[]>(nixLog),
		validityCalls: () => readLog<string[]>(validityLog),
		atticCalls: () => readLog<AtticCall>(atticLog),
		chainCalls: () => readLog<{ args: string[]; outPaths: string }>(chainLog),
		setup: (options: RunOptions = {}) => run(options.node ?? process.execPath, [join(bundleDir, "index.js")], options),
		setupFailure: (extraEnv: NodeJS.ProcessEnv = {}) =>
			execute(process.execPath, [join(bundleDir, "index.js")], extraEnv),
		// Replay only GitHub's saved state. Tests may explicitly add inherited exports
		// to prove a second action instance cannot borrow the first one's collector.
		post: (options: RunOptions = {}) => {
			if (options.env?.["TEST_VALIDITY"] === "thrown" || env["TEST_VALIDITY"] === "thrown") {
				rmSync(join(bin, "nix-store"));
			}
			return run(process.execPath, [join(bundleDir, "index.js")], {
				...options,
				env: {
					...options.env,
					...Object.fromEntries(Object.entries(state()).map(([key, value]) => ["STATE_" + key, value])),
				},
			});
		},
		hook: (outPaths: string, args: string[] = []) => run(wrapper(), args, { env: { OUT_PATHS: outPaths } }),
		hookResult: (outPaths: string) => execute(wrapper(), [], { OUT_PATHS: outPaths }),
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
		assert.deepEqual(f.validityCalls(), [[...validityFlags, ...kept]]);
		const scan = ["path-info", "--all", "--json", ...(format === "v2" ? ["--json-format", "2"] : [])];
		assert.deepEqual(f.nixCalls(), [["path-info", "--help"], scan, ["path-info", "--help"], scan]);
	});
}

test("default post-build-hook pushes unique filtered outputs without warnings, an original hook, or a store scan", (t) => {
	const f = fixture(t, "post-build-hook");
	assert.match(f.setup(), /No existing post-build hook found/);
	assert.deepEqual(f.atticCalls(), loginCalls);
	// Exercise the generated executable itself, with no node executable available on PATH.
	f.hook([kept[1], ...filtered, kept[0], kept[0]].join(" \t"));
	f.hook(kept.join("\n"));
	const output = f.post();
	assert.deepEqual(assertFlatGroups(output), ["Attic post-build hook capture log", "Push to Attic"]);
	assert.deepEqual(f.atticCalls(), [...loginCalls, { args: expectedPushArgs, stdin: kept.join("\n") }]);
	assert.deepEqual(f.validityCalls(), [[...validityFlags, ...kept]]);
	assert.deepEqual(f.nixCalls(), [trustQuery, configQuery]);
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

for (const originalHook of ["success", "malformed-header"] as const) {
	test(`an explicitly configured ${originalHook} hook is still chained with its arguments and outputs`, (t) => {
		const f = fixture(t, "post-build-hook", { originalHook });
		assert.match(f.setup(), /Composing with existing post-build hook:/);
		const args = ["one argument", "", "it's literal; $(exit 99) *", "--flag"];
		f.hook(kept.join(" "), args);
		assert.deepEqual(f.chainCalls(), [{ args, outPaths: kept.join(" ") }]);
		f.post();
		assert.deepEqual(f.atticCalls(), [...loginCalls, { args: expectedPushArgs, stdin: kept.join("\n") }]);
	});
}

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
		assert.deepEqual(f.validityCalls(), []);
		assert.deepEqual(readdirSync(f.runnerTemp), [], "no snapshot or hook collector should be created");
		assert.equal(readFileSync(f.githubEnv, "utf8"), "", "discovery should not export environment variables");
	});

	test(`${mode} drops deleted and existing-but-unregistered paths but pushes valid siblings`, (t) => {
		const f = fixture(t, mode);
		const deleted = "/nix/store/ddd-keep-deleted";
		const unregistered = "/nix/store/eee-keep-unregistered";
		const candidates = [...kept, deleted, unregistered];
		f.setup();
		f.setPaths(candidates);
		if (mode === "post-build-hook") f.hook(candidates.join(" "));
		f.deleteStorePath(deleted);
		f.unregisterStorePath(unregistered);
		const output = f.post({ warnings: [/^::warning::Skipping 2 Nix-invalid store path\(s\):/] });
		const warning = output.split("\n").find((line) => line.startsWith("::warning::"))!;
		assert.ok(warning.includes(deleted));
		assert.ok(warning.includes(unregistered));
		assert.ok(!warning.includes(kept[0]!));
		assert.deepEqual(f.validityCalls(), [[...validityFlags, ...candidates]]);
		assert.deepEqual(f.atticCalls(), [...loginCalls, { args: expectedPushArgs, stdin: kept.join("\n") }]);
	});

	test(`${mode} skips upload when all candidates are Nix-invalid`, (t) => {
		const f = fixture(t, mode);
		f.setup();
		f.setPaths(kept);
		if (mode === "post-build-hook") f.hook(kept.join(" "));
		f.deleteStorePath(kept[0]!);
		f.unregisterStorePath(kept[1]!);
		assert.match(f.post({ warnings: [/^::warning::Skipping 2 Nix-invalid store path\(s\):/] }), /No valid store paths/);
		assert.deepEqual(f.validityCalls(), [[...validityFlags, ...kept]]);
		assert.deepEqual(f.atticCalls(), loginCalls);
	});

	for (const empty of ["no outputs", "all filtered"] as const) {
		test(`${mode} skips validity queries and upload for ${empty}`, (t) => {
			const f = fixture(t, mode);
			f.setup();
			if (empty === "all filtered") {
				f.setPaths(filtered);
				if (mode === "post-build-hook") f.hook(filtered.join(" "));
			}
			const output = f.post();
			if (mode === "post-build-hook" && empty === "no outputs") {
				assert.match(output, /nothing (?:new )?was built locally|nothing (?:new )?built locally/i);
				assert.match(output, /untrusted/i);
				assert.match(output, /NIX_CONFIG/);
			}
			assert.deepEqual(f.validityCalls(), []);
			assert.deepEqual(f.atticCalls(), loginCalls);
		});
	}

	for (const validity of ["nonzero", "partial-nonzero", "foreign-output", "thrown"] as const) {
		test(`${mode} treats ${validity} validity query as unknown and skips the entire upload`, (t) => {
			const f = fixture(t, mode, { validity });
			f.setup();
			f.setPaths(kept);
			if (mode === "post-build-hook") f.hook(kept.join(" "));
			const output = f.post({ warnings: [validationFailureWarning], postFailure: true });
			assert.doesNotMatch(output, /Skipping \d+ Nix-invalid|No valid store paths/);
			if (validity === "nonzero" || validity === "partial-nonzero") {
				assert.match(output, /exited with code 2: validity database unavailable/);
			} else if (validity === "foreign-output") {
				assert.match(output, /non-candidate path: \/nix\/store\/not-a-candidate/);
			}
			assert.deepEqual(f.atticCalls(), loginCalls);
			assert.deepEqual(f.validityCalls(), validity === "thrown" ? [] : [[...validityFlags, ...kept]]);
		});
	}
}

for (const bound of ["count", "bytes"] as const) {
	test(`validity queries obey the ${bound} bound without losing or duplicating candidates`, (t) => {
		const f = fixture(t, "post-build-hook");
		const paths = Array.from(
			{ length: bound === "count" ? 300 : 100 },
			(_, index) => `/nix/store/${index.toString().padStart(32, "0")}-keep-${"x".repeat(bound === "count" ? 1 : 200)}`,
		);
		f.setValidPaths(paths);
		f.setup();
		f.hook(paths.join(" "));
		f.post();
		const calls = f.validityCalls();
		assert.ok(calls.length > 1, "large captures require multiple queries");
		assert.deepEqual(
			calls.flatMap((args) => args.slice(2)),
			paths,
		);
		for (const args of calls) {
			assert.deepEqual(args.slice(0, 2), validityFlags);
			assert.ok(args.length - 2 <= 128);
			assert.ok(["nix-store", ...args].reduce((bytes, arg) => bytes + Buffer.byteLength(arg) + 1, 0) <= 16 * 1024);
		}
		if (bound === "count") assert.equal(calls[0]!.length - 2, 128);
		else assert.ok(calls[0]!.length - 2 < 100, "byte limit splits a batch below the count limit");
		assert.deepEqual(f.atticCalls(), [...loginCalls, { args: expectedPushArgs, stdin: paths.join("\n") }]);
	});
}

test("a failed later validity chunk prevents uploading even previously validated paths", (t) => {
	const f = fixture(t, "post-build-hook", { validity: "later-nonzero" });
	const paths = Array.from({ length: 130 }, (_, index) => `/nix/store/${index.toString().padStart(3, "0")}-keep-chunk`);
	f.setValidPaths(paths);
	f.setup();
	f.hook(paths.join(" "));
	f.post({ warnings: [validationFailureWarning], postFailure: true });
	assert.equal(f.validityCalls().length, 2);
	assert.deepEqual(f.atticCalls(), loginCalls);
});

for (const character of ["x", "é"]) {
	test(`an oversized ${character === "x" ? "ASCII" : "UTF-8"} candidate never reaches a subprocess`, (t) => {
		const f = fixture(t, "post-build-hook");
		f.setup();
		// This intentionally exceeds valid Nix name lengths. The UTF-8 case fits
		// the limit in characters but not bytes: neither may bypass the bound.
		writeFileSync(
			join(f.state()["post_build_hook-paths-dir"]!, "paths.oversized"),
			`/nix/store/oversized-keep-${character.repeat((16 * 1024) / Buffer.byteLength(character))}`,
		);
		const output = f.post({ warnings: [validationFailureWarning], postFailure: true });
		assert.match(output, /candidate path exceeds the validity-query argument limit/);
		assert.deepEqual(f.validityCalls(), []);
		assert.deepEqual(f.atticCalls(), loginCalls);
	});
}

for (const trust of [
	"true",
	"omitted",
	"nonboolean",
	"malformed",
	"nonzero-true",
	"nonzero-false",
	"thrown",
] as const) {
	test(`trust preflight ${trust} ${trust === "true" ? "passes silently" : "warns as unknown and continues"}`, (t) => {
		const f = fixture(t, "post-build-hook", { trust });
		f.setup({ warnings: trust === "true" ? [] : [unknownTrustWarning] });
		assert.deepEqual(f.nixCalls(), [trustQuery, configQuery]);
		assert.ok(f.state()["post_build_hook-paths-dir"]);
		f.hook(kept.join(" "));
		f.post();
		assert.deepEqual(f.atticCalls(), [...loginCalls, { args: expectedPushArgs, stdin: kept.join("\n") }]);
	});
}

test("successful trusted=false probe fails configure before querying config or creating a collector", (t) => {
	const f = fixture(t, "post-build-hook", { trust: "false" });
	const result = f.setupFailure();
	assert.ifError(result.error);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stdout, /Action failed with error.*trusted=false/);
	assert.doesNotMatch(result.stdout, /::warning::Unable to determine Nix store trust/);
	assert.deepEqual(f.nixCalls(), [trustQuery]);
	assert.deepEqual(readdirSync(f.runnerTemp), []);
	assert.deepEqual(f.state(), { isPost: "true" });
	assert.equal(readFileSync(f.githubEnv, "utf8"), "");
	assertFlatGroups(result.stdout);
});

test("hook discovery falls back to the legacy Nix/Lix configuration query", (t) => {
	const f = fixture(t, "post-build-hook", { query: "legacy" });
	f.setup();
	f.hook(kept.join(" "));
	f.post();
	assert.deepEqual(f.nixCalls(), [trustQuery, configQuery, legacyQuery]);
	assert.deepEqual(f.atticCalls(), [...loginCalls, { args: expectedPushArgs, stdin: kept.join("\n") }]);
});

for (const query of ["invalid", "missing", "malformed", "failed"] as const) {
	test(`hook configuration fails safely on ${query} effective configuration`, (t) => {
		const f = fixture(t, "post-build-hook", { query });
		const result = f.setupFailure();
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.match(result.stdout, /Action failed with error/);
		assert.deepEqual(
			f.nixCalls(),
			query === "failed" ? [trustQuery, configQuery, legacyQuery] : [trustQuery, configQuery],
		);
		assert.deepEqual(readdirSync(f.runnerTemp), [], "must not replace a hook whose effective value is unknown");
	});
}

test("an actual ENOENT capture failure leaves the hook successful but warns about lost captures in post", (t) => {
	const f = fixture(t, "post-build-hook");
	f.setup();
	rmSync(f.state()["post_build_hook-paths-dir"]!, { recursive: true });
	f.hook(kept.join(" "));
	const events = readLog<{ error: { message: string }; chained: null }>(f.state()["post_build_hook-events-log"]!);
	assert.equal(events.length, 1);
	assert.match(events[0]!.error.message, /ENOENT/);
	assert.equal(events[0]!.chained, null);
	f.post({ warnings: [/^::warning::.*1.*failed to capture output paths/] });
	assert.deepEqual(f.atticCalls(), loginCalls);
	assert.deepEqual(f.validityCalls(), []);
});

for (const originalHook of ["nonzero", "signal", "missing"] as const) {
	test(`a ${originalHook} chained-hook failure is reported separately, not as a lost capture`, (t) => {
		const f = fixture(t, "post-build-hook", { originalHook });
		f.setup();
		const result = f.hookResult(kept.join(" "));
		assert.ifError(result.error);
		if (originalHook === "signal") assert.equal(result.signal, "SIGTERM", result.stdout + result.stderr);
		else assert.equal(result.status, originalHook === "nonzero" ? 7 : 1, result.stdout + result.stderr);
		const output = f.post({ warnings: [/^::warning::.*1.*chained post-build hook invocation\(s\) failed/] });
		assert.doesNotMatch(output, /failed to capture output paths/);
		assert.deepEqual(f.atticCalls(), [...loginCalls, { args: expectedPushArgs, stdin: kept.join("\n") }]);
	});
}

for (const debug of [false, true]) {
	test(`malformed diagnostic records cannot prevent pushing legitimate captures (debug=${debug})`, (t) => {
		const f = fixture(t, "post-build-hook");
		f.setup();
		f.hook(kept.join(" "));
		const invalid = [null, 42, "scalar", { paths: "not-an-array" }, { chained: { status: {} } }, { error: null }];
		appendFileSync(
			f.state()["post_build_hook-events-log"]!,
			invalid.map((value) => JSON.stringify(value)).join("\n") + "\n",
		);
		const output = f.post({
			env: { RUNNER_DEBUG: debug ? "1" : "0" },
			warnings: ["::warning::Ignored 6 malformed event log line(s)."],
		});
		assert.deepEqual(assertFlatGroups(output), ["Attic post-build hook capture log", "Push to Attic"]);
		if (debug) assert.match(output, /::debug::/);
		assert.deepEqual(f.atticCalls(), [...loginCalls, { args: expectedPushArgs, stdin: kept.join("\n") }]);
	});

	test(`unreadable events log cannot prevent valid pushes or leave nested/unbalanced groups (debug=${debug})`, (t) => {
		const f = fixture(t, "post-build-hook");
		f.setup();
		f.hook(kept.join(" "));
		const log = f.state()["post_build_hook-events-log"]!;
		rmSync(log);
		mkdirSync(log); // Deterministic read failure even when the tests run as root.
		const output = f.post({
			env: { RUNNER_DEBUG: debug ? "1" : "0" },
			warnings: [/^::warning::Unable to print post-build hook capture log:.*EISDIR/],
		});
		assert.deepEqual(assertFlatGroups(output), ["Attic post-build hook capture log", "Push to Attic"]);
		assert.deepEqual(f.atticCalls(), [...loginCalls, { args: expectedPushArgs, stdin: kept.join("\n") }]);
	});
}

test(
	"permission-denied events log does not suppress a valid sibling capture",
	{
		skip: process.getuid?.() === 0 && "permission denial requires an unprivileged runner",
	},
	(t) => {
		const f = fixture(t, "post-build-hook");
		f.setup();
		f.hook(kept.join(" "));
		const log = f.state()["post_build_hook-events-log"]!;
		chmodSync(log, 0o000);
		try {
			f.post({ warnings: [/^::warning::Unable to print post-build hook capture log:.*EACCES/] });
			assert.deepEqual(f.atticCalls(), [...loginCalls, { args: expectedPushArgs, stdin: kept.join("\n") }]);
		} finally {
			chmodSync(log, 0o600);
		}
	},
);

test("a failed second setup cannot borrow the first action's captures from inherited ATTIC exports", (t) => {
	const a = fixture(t, "post-build-hook");
	a.setup();
	a.hook(kept.join(" "));
	const inherited = readCommandFile(a.githubEnv);
	assert.ok(inherited["ATTIC_POST_BUILD_PATHS_DIR"]);
	assert.ok(inherited["ATTIC_POST_BUILD_EVENTS_LOG"]);
	const b = fixture(t, "post-build-hook", { trust: "false" });
	const result = b.setupFailure(inherited);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stdout, /trusted=false/);
	assert.deepEqual(b.state(), { isPost: "true" });
	const output = b.post({ env: inherited });
	assert.match(output, /No hook invocations were captured/);
	assert.ok(!output.includes(kept[0]!), "B must not read A's event log either");
	assert.deepEqual(b.atticCalls(), loginCalls);
	assert.deepEqual(b.validityCalls(), []);
	assert.deepEqual(a.atticCalls(), loginCalls);
	a.post();
	assert.deepEqual(a.atticCalls(), [...loginCalls, { args: expectedPushArgs, stdin: kept.join("\n") }]);
});

test("the generated launcher works beneath a runner-temp ancestor with package type module", (t) => {
	const f = fixture(t, "post-build-hook");
	writeFileSync(join(f.runnerTemp, "package.json"), JSON.stringify({ type: "module" }));
	f.setup();
	assert.ok(existsSync(join(dirname(f.wrapper()), "post-build-hook.cjs")));
	f.hook(kept.join(" "));
	f.post();
	assert.deepEqual(f.atticCalls(), [...loginCalls, { args: expectedPushArgs, stdin: kept.join("\n") }]);
});

test("the actual launcher invokes a copied Node binary whose absolute path contains spaces and an apostrophe", (t) => {
	const f = fixture(t, "post-build-hook");
	const nodeDir = join(f.root, "node's directory with spaces");
	mkdirSync(nodeDir);
	const spacedNode = join(nodeDir, "node");
	copyFileSync(process.execPath, spacedNode); // A symlink would resolve back to the original execPath.
	chmodSync(spacedNode, 0o755);
	const probe = spawnSync(spacedNode, ["-p", "process.execPath"], {
		encoding: "utf8",
		env: { NODE_V8_COVERAGE: "" },
	});
	assert.ifError(probe.error);
	assert.equal(probe.status, 0, probe.stdout + probe.stderr);
	assert.equal(probe.stdout.trim(), spacedNode);
	f.setup({ node: spacedNode });
	assert.match(readFileSync(f.wrapper(), "utf8"), /^#!\/bin\/sh\n/);
	// Observe the launched process without replacing the launcher or collector.
	const actualExecPath = join(f.root, "hook-exec-path");
	appendFileSync(
		join(dirname(f.wrapper()), "post-build-hook.cjs"),
		`require("node:fs").writeFileSync(${JSON.stringify(actualExecPath)}, process.execPath);\n`,
	);
	f.hook(kept.join(" "));
	assert.equal(readFileSync(actualExecPath, "utf8"), spacedNode);
	f.post();
	assert.deepEqual(f.atticCalls(), [...loginCalls, { args: expectedPushArgs, stdin: kept.join("\n") }]);
});

test(
	"an unreadable capture file is warned and skipped while a readable sibling is pushed",
	{ skip: process.getuid?.() === 0 && "permission denial requires an unprivileged runner" },
	(t) => {
		const f = fixture(t, "post-build-hook");
		f.setup();
		f.hook(kept.join(" "));
		const unreadable = join(f.state()["post_build_hook-paths-dir"]!, "paths.unreadable");
		writeFileSync(unreadable, "/nix/store/xxx-keep-unreadable\n", { mode: 0o000 });
		const output = f.post({ warnings: [/^::warning::Skipping unreadable post-build hook capture file.*EACCES/] });
		assert.ok(output.includes(unreadable));
		assert.ok(
			output.indexOf("Skipping unreadable post-build hook capture file") <
				output.indexOf("::group::Attic post-build hook capture log"),
			"collect captures before printing diagnostics",
		);
		assert.deepEqual(f.validityCalls(), [[...validityFlags, ...kept]]);
		assert.deepEqual(f.atticCalls(), [...loginCalls, { args: expectedPushArgs, stdin: kept.join("\n") }]);
	},
);

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
	"unrelated UID cannot inject captures; root hook outputs remain readable and an unreadable root file is skipped",
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
			{ encoding: "utf8", env: { ...process.env, NODE_V8_COVERAGE: "" } },
		);
		assert.equal(attack.status, 0, attack.stdout + attack.stderr);

		const unreadable = join(paths, "paths.root-private");
		const daemon = spawnSync(
			"sudo",
			[
				"-n",
				"--",
				process.execPath,
				"-e",
				'process.umask(0o077); require("node:child_process").execFileSync(process.argv[1], [], {env: {...process.env, OUT_PATHS:process.argv[2], NODE_V8_COVERAGE:""}, stdio:"inherit"}); require("node:fs").writeFileSync(process.argv[3], "/nix/store/xxx-keep-private", {mode:0o600});',
				f.wrapper(),
				kept.join(" "),
				unreadable,
			],
			{ encoding: "utf8", env: { ...process.env, NODE_V8_COVERAGE: "" } },
		);
		assert.equal(daemon.status, 0, daemon.stdout + daemon.stderr);
		const captured = readdirSync(paths).filter((name) => name.startsWith("paths.") && name !== basename(unreadable));
		assert.equal(captured.length, 1);
		assert.equal(statSync(join(paths, captured[0]!)).uid, 0);
		assert.equal(statSync(join(paths, captured[0]!)).mode & 0o777, 0o644);
		assert.equal(statSync(unreadable).uid, 0);
		assert.equal(statSync(unreadable).mode & 0o777, 0o600);
		assert.equal(statSync(paths).uid, process.getuid!());
		assert.equal(statSync(paths).mode & 0o777, 0o700);
		assert.equal(statSync(log).uid, process.getuid!());
		f.post({ warnings: [/^::warning::Skipping unreadable post-build hook capture file.*EACCES/] });
		assert.deepEqual(f.atticCalls(), [...loginCalls, { args: expectedPushArgs, stdin: kept.join("\n") }]);
	},
);
