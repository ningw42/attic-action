import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

test("real Nix validity drops deleted and existing-unregistered captures while pushing a valid sibling", (t) => {
	const selectedNix = process.env["ATTIC_TEST_NIX"];
	const nix = selectedNix || "nix";
	const nixStore = selectedNix ? join(dirname(selectedNix), "nix-store") : "nix-store";
	for (const command of [nix, nixStore]) {
		const result = spawnSync(command, ["--version"], { encoding: "utf8" });
		if (!selectedNix && (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
			t.skip("Nix/nix-store not installed; this test runs after installation in the CI matrix");
			return;
		}
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr);
	}

	const root = realpathSync(mkdtempSync(join(tmpdir(), "attic-validity-test-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const runtime = join(root, "runtime");
	const bin = join(root, "bin");
	const home = join(root, "home");
	const system = join(root, "system");
	const runner = join(root, "runner");
	for (const directory of [runtime, bin, home, system, runner]) mkdirSync(directory);
	const built = buildSync({
		entryPoints: ["index.ts", "post-build-hook.ts"].map((name) => fileURLToPath(new URL(name, import.meta.url))),
		outdir: runtime,
		bundle: true,
		platform: "node",
		format: "cjs",
		logLevel: "silent",
	});
	assert.deepEqual(built.warnings, [], "packaged production sources must build without warnings");

	const calls = join(root, "attic.jsonl");
	const state = join(root, "github-state");
	const githubEnv = join(root, "github-env");
	for (const file of [calls, state, githubEnv]) writeFileSync(file, "");
	writeFileSync(
		join(bin, "attic"),
		`#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = args[0] === "push" ? fs.readFileSync(0, "utf8") : "";
fs.appendFileSync(process.env.TEST_ATTIC_LOG, JSON.stringify({ args, stdin }) + "\\n");
`,
		{ mode: 0o755 },
	);
	const store = join(root, "store");
	const env: NodeJS.ProcessEnv = {
		PATH: [bin, ...(selectedNix ? [dirname(selectedNix)] : []), process.env["PATH"]].join(delimiter),
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_CONFIG_DIRS: join(root, "xdg-config"),
		XDG_CACHE_HOME: join(root, "cache"),
		NIX_CONF_DIR: system,
		NIX_USER_CONF_FILES: "",
		NIX_CONFIG: "experimental-features = nix-command flakes\nbuild-users-group =\nsubstituters =\n",
		// All registration and deletion happen in a disposable store, never the host store.
		NIX_REMOTE: `local?store=${store}&real=${store}&state=${join(root, "state")}&log=${join(root, "log")}`,
		RUNNER_TEMP: runner,
		GITHUB_STATE: state,
		GITHUB_ENV: githubEnv,
		TEST_ATTIC_LOG: calls,
		INPUT_ENDPOINT: "https://unused.invalid",
		INPUT_CACHE: "test-cache",
		INPUT_TOKEN: "unused",
		"INPUT_PATH-DISCOVERY-MODE": "post-build-hook",
	};
	const run = (command: string, args: string[], extra: NodeJS.ProcessEnv = {}) => {
		const result = spawnSync(command, args, { env: { ...env, ...extra }, cwd: root, encoding: "utf8" });
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		return result.stdout;
	};
	const add = (name: string) => {
		const source = join(root, name);
		writeFileSync(source, name);
		return run(nixStore, ["--add", source]).trim();
	};
	const kept = add("kept");
	const removed = add("removed");
	const unregistered = join(store, "00000000000000000000000000000000-unregistered");
	writeFileSync(unregistered, "exists but was never registered with Nix");
	const setup = run(process.execPath, [join(runtime, "index.js")]);
	assert.doesNotMatch(setup, /::(?:error|warning)::/);

	// Replay the actual file-command state, not job-wide ATTIC_* exports.
	const saved = Object.fromEntries(
		Array.from(
			readFileSync(state, "utf8").matchAll(/^([^\n<]+)<<([^\n]+)\n([\s\S]*?)\n\2(?:\n|$)/gm),
			([, name, , value]) => ["STATE_" + name, value],
		),
	);
	assert.equal(saved["STATE_isPost"], "true");
	const pathsDir = saved["STATE_post_build_hook-paths-dir"]!;
	assert.ok(pathsDir);
	run(join(dirname(pathsDir), "post-build-hook.sh"), [], { OUT_PATHS: [kept, removed, unregistered].join(" ") });
	run(nixStore, ["--delete", removed]);
	assert.equal(existsSync(removed), false);
	assert.equal(existsSync(unregistered), true, "filesystem existence alone must not pass the check");

	const post = run(process.execPath, [join(runtime, "index.js")], saved);
	assert.doesNotMatch(post, /Action encountered error|::error::/);
	assert.match(post, /::warning::/);
	assert.ok(post.includes(removed) && post.includes(unregistered), "list both dropped candidates");
	const pushes = readFileSync(calls, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.filter((call) => call.args[0] === "push");
	assert.deepEqual(pushes, [{ args: ["push", "--stdin", "test-cache"], stdin: kept }]);
});
