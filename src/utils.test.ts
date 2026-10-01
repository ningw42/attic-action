import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	applyPathFilters,
	excludeTemporaryPaths,
	getPostBuildHookPaths,
	summarizeHookEvent,
	type HookEventRecord,
} from "./utils.ts";

// Run `printPostBuildHookCaptureLog` in a subprocess and capture its stdout.
//
// Why not just monkey-patch `process.stdout.write` in-process? Because
// `@actions/core` writes via the same stream that `node --test`'s reporter
// uses; patching it silently swallows other tests' reporter output and
// causes them to be dropped from the run. A subprocess keeps the two
// streams cleanly separated.
const runPrintInSubprocess = (env: Record<string, string | undefined>) => {
	const modulePath = new URL("./utils.ts", import.meta.url).pathname;
	const driver = `
		import("${modulePath}").then(m => m.printPostBuildHookCaptureLog())
			.then(() => process.exit(0))
			.catch(e => { console.error(e); process.exit(1); });
	`;
	const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) delete cleanEnv[k];
		else cleanEnv[k] = v;
	}
	return spawnSync(process.execPath, ["--input-type=module", "-e", driver], {
		env: cleanEnv,
		encoding: "utf8",
	});
};

import { createTestEnv } from "./env-fixture.ts";

describe("excludeTemporaryPaths", () => {
	test("drops .drv, .drv.chroot, .check, .lock", () => {
		const input = [
			"/nix/store/a",
			"/nix/store/b.drv",
			"/nix/store/c.drv.chroot",
			"/nix/store/d.check",
			"/nix/store/e.lock",
			"/nix/store/f",
		];
		assert.deepEqual(excludeTemporaryPaths(input), ["/nix/store/a", "/nix/store/f"]);
	});

	test("identity on clean inputs", () => {
		const input = ["/nix/store/a", "/nix/store/b", "/nix/store/c"];
		assert.deepEqual(excludeTemporaryPaths(input), input);
	});

	test("empty array → empty array", () => {
		assert.deepEqual(excludeTemporaryPaths([]), []);
	});
});

describe("applyPathFilters", () => {
	const { setEnv, restoreEnv } = createTestEnv();
	afterEach(() => restoreEnv());

	const paths = [
		"/nix/store/aaa-foo-1.0",
		"/nix/store/bbb-bar-2.0",
		"/nix/store/ccc-baz-3.0",
		"/nix/store/ddd-foo-4.0",
	];

	test("no inputs → identity", () => {
		setEnv("INPUT_INCLUDE-PATHS", undefined);
		setEnv("INPUT_EXCLUDE-PATHS", undefined);
		assert.deepEqual(applyPathFilters(paths), paths);
	});

	test("include-paths keeps only matching", () => {
		setEnv("INPUT_INCLUDE-PATHS", "foo");
		assert.deepEqual(applyPathFilters(paths), ["/nix/store/aaa-foo-1.0", "/nix/store/ddd-foo-4.0"]);
	});

	test("exclude-paths drops matching", () => {
		setEnv("INPUT_EXCLUDE-PATHS", "foo");
		assert.deepEqual(applyPathFilters(paths), ["/nix/store/bbb-bar-2.0", "/nix/store/ccc-baz-3.0"]);
	});

	test("include then exclude applied in order", () => {
		setEnv("INPUT_INCLUDE-PATHS", "foo\nbar");
		setEnv("INPUT_EXCLUDE-PATHS", "ddd");
		assert.deepEqual(applyPathFilters(paths), ["/nix/store/aaa-foo-1.0", "/nix/store/bbb-bar-2.0"]);
	});

	test("multiline include treated as OR", () => {
		setEnv("INPUT_INCLUDE-PATHS", "foo\nbaz");
		assert.deepEqual(applyPathFilters(paths), [
			"/nix/store/aaa-foo-1.0",
			"/nix/store/ccc-baz-3.0",
			"/nix/store/ddd-foo-4.0",
		]);
	});
});

describe("summarizeHookEvent", () => {
	test("full event renders all fields", () => {
		const event: HookEventRecord = {
			ts: "2026-05-31T13:00:00.000Z",
			pid: 12345,
			drvPath: "/nix/store/xxx.drv",
			rawOutPaths: "/nix/store/a /nix/store/b",
			paths: ["/nix/store/a", "/nix/store/b"],
			pathsFile: "/tmp/paths.abc",
			chained: { hook: "/orig.sh", status: 0 },
		};
		const out = summarizeHookEvent(event, 0);
		assert.match(out, /^#1 2026-05-31T13:00:00\.000Z pid=12345$/m);
		assert.match(out, /drv:\s+\/nix\/store\/xxx\.drv/);
		assert.match(out, /paths:\s+2 \(\/nix\/store\/a, \/nix\/store\/b\)/);
		assert.match(out, /file:\s+\/tmp\/paths\.abc/);
		assert.match(out, /chained:\s+\/orig\.sh \(status=0\)/);
	});

	test("skipped event renders reason", () => {
		const event: HookEventRecord = {
			ts: "2026-05-31T13:00:00.000Z",
			pid: 1,
			paths: [],
			skipped: { reason: "empty OUT_PATHS" },
		};
		assert.match(summarizeHookEvent(event, 5), /skipped:\s+empty OUT_PATHS/);
		assert.match(summarizeHookEvent(event, 5), /^#6/);
	});

	test("chained error renders", () => {
		const event: HookEventRecord = {
			ts: "x",
			pid: 1,
			paths: [],
			chained: { hook: "/orig", status: null, error: "boom" },
		};
		assert.match(summarizeHookEvent(event, 0), /chained:\s+\/orig \(status=n\/a, error=boom\)/);
	});

	test("chained signal renders", () => {
		assert.match(
			summarizeHookEvent({ chained: { hook: "/orig", status: null, signal: "SIGTERM" } }, 0),
			/chained:\s+\/orig \(status=n\/a, signal=SIGTERM\)/,
		);
	});

	test("error field renders", () => {
		const event: HookEventRecord = {
			ts: "x",
			pid: 1,
			paths: [],
			error: { message: "disk full" },
		};
		assert.match(summarizeHookEvent(event, 0), /error:\s+disk full/);
	});

	test("missing optional fields do not throw", () => {
		assert.doesNotThrow(() => summarizeHookEvent({}, 0));
	});
});

describe("printPostBuildHookCaptureLog", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "attic-utils-test-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const run = (env: Record<string, string | undefined> = {}) =>
		runPrintInSubprocess({
			RUNNER_TEMP: root,
			"STATE_post_build_hook-events-log": join(root, "events.log"),
			...env,
		});

	test("missing events.log explains normal and possible misconfiguration causes without warning", () => {
		const result = run();
		assert.equal(result.status, 0, `stderr=${result.stderr}`);
		assert.match(result.stdout, /No hook invocations were captured/);
		assert.match(result.stdout, /nothing was built locally/);
		assert.match(result.stdout, /untrusted daemon client/);
		assert.match(result.stdout, /NIX_CONFIG/);
		assert.doesNotMatch(result.stdout, /::warning::/);
	});

	test("empty events.log is informational", () => {
		writeFileSync(join(root, "events.log"), "");
		const result = run();
		assert.equal(result.status, 0, `stderr=${result.stderr}`);
		assert.match(result.stdout, /No hook invocations were captured/);
		assert.doesNotMatch(result.stdout, /::warning::/);
	});

	test("multi-event log: summary totals correct", () => {
		const events = [
			{ ts: "t1", pid: 1, paths: ["/nix/store/a", "/nix/store/b"], pathsFile: "/tmp/p1" },
			{ ts: "t2", pid: 2, paths: ["/nix/store/c"], pathsFile: "/tmp/p2" },
			{ ts: "t3", pid: 3, paths: [], skipped: { reason: "empty OUT_PATHS" } },
		];
		writeFileSync(join(root, "events.log"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");

		const result = run();
		assert.equal(result.status, 0, `stderr=${result.stderr}`);
		assert.match(result.stdout, /Captured 3 hook invocation\(s\); 3 path\(s\) reported by Nix\./);
		assert.match(result.stdout, /#1 t1 pid=1/);
		assert.match(result.stdout, /#2 t2 pid=2/);
		assert.match(result.stdout, /#3 t3 pid=3/);
		assert.match(result.stdout, /skipped:\s+empty OUT_PATHS/);
	});

	test("invalid JSON shapes are skipped while valid partial records remain readable", () => {
		const invalid = [
			null,
			1,
			"text",
			true,
			[],
			{ paths: "bad" },
			{ paths: [null] },
			{ pid: {} },
			{ ts: [] },
			{ drvPath: 42 },
			{ pathsFile: false },
			{ rawOutPaths: [] },
			{ chained: [] },
			{ chained: { hook: [], status: 0 } },
			{ chained: { hook: "/hook", status: {} } },
			{ skipped: null },
			{ skipped: { reason: {} } },
			{ error: [] },
			{ error: { message: [] } },
		];
		const records = [...invalid, {}, { paths: ["/nix/store/valid"] }];
		writeFileSync(join(root, "events.log"), records.map((value) => JSON.stringify(value)).join("\n"));
		const result = run();
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Captured 2 hook invocation\(s\); 1 path\(s\)/);
		assert.match(result.stdout, /Ignored 19 malformed event log line\(s\)/);
	});

	test("capture and chained-hook failures have separate counted warning annotations", () => {
		const records = [
			{ paths: ["/nix/store/lost"], error: { message: "ENOENT: paths directory removed" } },
			{ paths: ["/nix/store/good"], chained: { hook: "/orig", status: 42 } },
			{ chained: { hook: "/orig", status: null, signal: "SIGTERM" } },
			{ chained: { hook: "/missing", status: null, error: "ENOENT" } },
			{ chained: { hook: "/ok", status: 0 } },
		];
		writeFileSync(join(root, "events.log"), records.map((record) => JSON.stringify(record)).join("\n"));
		const result = run();
		assert.equal(result.status, 0, result.stderr);
		const warnings = result.stdout.split("\n").filter((line) => line.startsWith("::warning::"));
		assert.equal(warnings.length, 2, result.stdout);
		assert.match(warnings[0]!, /1 post-build hook invocation\(s\) failed to capture output paths/);
		assert.match(warnings[1]!, /3 chained post-build hook invocation\(s\) failed/);
	});

	test("debug output is flat and diagnostics groups close even on read errors", () => {
		writeFileSync(join(root, "events.log"), '{"paths":[]}\nnot-json\n');
		const debug = run({ RUNNER_DEBUG: "1" });
		assert.equal(debug.status, 0, debug.stderr);
		assert.deepEqual(
			debug.stdout.split("\n").filter((line) => /^::(?:group|endgroup)::/.test(line)),
			["::group::Attic post-build hook capture log", "::endgroup::"],
		);
		const unreadable = run({ "STATE_post_build_hook-events-log": root });
		assert.equal(unreadable.status, 1);
		assert.deepEqual(
			unreadable.stdout.split("\n").filter((line) => /^::(?:group|endgroup)::/.test(line)),
			["::group::Attic post-build hook capture log", "::endgroup::"],
		);
	});

	test("malformed lines tolerated, warning emitted", () => {
		const log = [
			JSON.stringify({ ts: "t1", pid: 1, paths: ["/nix/store/a"] }),
			"not json at all",
			JSON.stringify({ ts: "t2", pid: 2, paths: [] }),
			"{ broken: ",
		].join("\n");
		writeFileSync(join(root, "events.log"), log + "\n");

		const result = run();
		assert.equal(result.status, 0, `stderr=${result.stderr}`);
		assert.match(result.stdout, /Captured 2 hook invocation\(s\); 1 path\(s\)/);
		assert.match(result.stdout, /::warning::Ignored 2 malformed event log line\(s\)/);
	});
});

describe("getPostBuildHookPaths (round-trip with hook output)", () => {
	const { setEnv, restoreEnv } = createTestEnv();
	let root: string;
	let pathsDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "attic-readback-test-"));
		pathsDir = join(root, "paths");
		mkdirSync(pathsDir, { recursive: true });
		// Point the state-lookup at our temp dir.
		setEnv("STATE_post_build_hook-paths-dir", pathsDir);
	});

	afterEach(() => {
		restoreEnv();
		rmSync(root, { recursive: true, force: true });
	});

	test("reads back paths written by the hook, sorted and de-duplicated", async () => {
		writeFileSync(join(pathsDir, "paths.aaa"), "/nix/store/zzz\n/nix/store/aaa\n");
		writeFileSync(join(pathsDir, "paths.bbb"), "/nix/store/mmm\n/nix/store/aaa\n");

		const paths = await getPostBuildHookPaths();
		assert.deepEqual(paths, ["/nix/store/aaa", "/nix/store/mmm", "/nix/store/zzz"]);
	});

	test("ignores non-paths.* files in the directory", async () => {
		writeFileSync(join(pathsDir, "paths.aaa"), "/nix/store/a\n");
		writeFileSync(join(pathsDir, "events.log"), '{"foo":1}\n');
		writeFileSync(join(pathsDir, "random.txt"), "/nix/store/should-not-appear\n");

		assert.deepEqual(await getPostBuildHookPaths(), ["/nix/store/a"]);
	});

	test("missing paths dir → empty array (no throw)", async () => {
		setEnv("STATE_post_build_hook-paths-dir", join(root, "does-not-exist"));
		assert.deepEqual(await getPostBuildHookPaths(), []);
	});

	test("empty paths.* files are tolerated", async () => {
		writeFileSync(join(pathsDir, "paths.empty"), "");
		writeFileSync(join(pathsDir, "paths.real"), "/nix/store/x\n");
		assert.deepEqual(await getPostBuildHookPaths(), ["/nix/store/x"]);
	});
});
