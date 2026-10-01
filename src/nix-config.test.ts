import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { describe, test, type TestContext } from "node:test";

const resolveNix = (): string | undefined => {
	const override = process.env["ATTIC_TEST_NIX"];
	if (override !== undefined) {
		assert.ok(isAbsolute(override), "ATTIC_TEST_NIX must name an absolute Nix executable");
		accessSync(override, constants.X_OK);
		assert.ok(statSync(override).isFile(), "ATTIC_TEST_NIX must name an executable file");
		return override;
	}

	for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
		const candidate = resolve(directory, "nix");
		try {
			accessSync(candidate, constants.X_OK);
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			// Keep looking; a machine without Nix can still run the other unit tests.
		}
	}
	return undefined;
};

const nixExecutable = resolveNix();
const cache = "https://attic-test.invalid/test-cache";
const publicKey = "attic-test:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

type SetupResult = {
	currentHook: unknown;
	installedHook: unknown;
	env: NodeJS.ProcessEnv;
};

const fixture = (t: TestContext) => {
	assert.ok(nixExecutable);
	const root = mkdtempSync(join(tmpdir(), "attic-nix-config-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const configHome = join(home, ".config");
	const configDirs = join(root, "xdg-config");
	const systemConfig = join(root, "system", "nix.conf");
	const userConfig = join(configHome, "nix", "nix.conf");
	const runnerTemp = join(root, "runner");
	const bin = join(root, "bin");
	const githubEnv = join(root, "github-env");
	const githubState = join(root, "github-state");
	const resultFile = join(root, "result.json");
	const netrc = join(root, "netrc");
	for (const directory of [dirname(userConfig), dirname(systemConfig), configDirs, runnerTemp, bin]) {
		mkdirSync(directory, { recursive: true });
	}
	// Both the public helper's PATH lookup and the independent oracle use the
	// same real executable, including when ATTIC_TEST_NIX selects Lix.
	symlinkSync(nixExecutable, join(bin, "nix"));
	for (const path of [githubEnv, githubState, systemConfig]) writeFileSync(path, "");
	writeFileSync(netrc, "machine attic-test.invalid login test password unused\n", { mode: 0o600 });
	const cacheConfig = `substituters = ${cache}\ntrusted-public-keys = ${publicKey}\nnetrc-file = ${netrc}\n`;
	// Model settings already written by `attic use`, before hook setup runs.
	writeFileSync(userConfig, cacheConfig);

	// Deliberately inherit nothing: neither Nix's system/user configuration nor
	// Actions file commands, NODE_OPTIONS, INPUT_*, STATE_* or Cachix state may
	// leak from the test runner. All configuration roots point into this fixture.
	const env: NodeJS.ProcessEnv = {
		PATH: bin,
		HOME: home,
		XDG_CONFIG_HOME: configHome,
		XDG_CONFIG_DIRS: configDirs,
		XDG_CACHE_HOME: join(root, "cache"),
		XDG_DATA_HOME: join(root, "data"),
		NIX_CONF_DIR: dirname(systemConfig),
		TMPDIR: root,
		RUNNER_TEMP: runnerTemp,
		GITHUB_ENV: githubEnv,
		GITHUB_STATE: githubState,
	};

	const run = (executable: string, args: string[], childEnv = env) => {
		const result = spawnSync(executable, args, {
			cwd: root,
			env: childEnv,
			encoding: "utf8",
			timeout: 15_000,
			maxBuffer: 8 * 1024 * 1024,
		});
		assert.ifError(result.error);
		assert.equal(result.status, 0, `${executable} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
		return result.stdout;
	};

	const effectiveSettings = (childEnv = env): Record<string, unknown> => {
		// Do not use currentPostBuildHook or mirror its modern-command/fallback
		// logic as the oracle. This legacy spelling works with both Nix and Lix.
		const raw = JSON.parse(
			run(nixExecutable, ["--extra-experimental-features", "nix-command", "show-config", "--json"], childEnv),
		) as Record<string, { value: unknown }>;
		assert.ok(raw && typeof raw === "object" && !Array.isArray(raw));
		const values: Record<string, unknown> = {};
		for (const [name, setting] of Object.entries(raw)) {
			assert.ok(setting && typeof setting === "object" && "value" in setting, `Invalid setting: ${name}`);
			values[name] = setting.value;
		}
		assert.equal(typeof values["post-build-hook"], "string");
		return values;
	};

	const configure = (): SetupResult => {
		// Each invocation models a fresh action step with its own file commands.
		writeFileSync(githubEnv, "");
		writeFileSync(githubState, "");
		const driver = `
			import { writeFileSync } from "node:fs";
			const { currentPostBuildHook, configurePostBuildHookPathDiscovery } =
				await import(${JSON.stringify(new URL("./utils.ts", import.meta.url).href)});
			const currentHook = await currentPostBuildHook();
			await configurePostBuildHookPathDiscovery();
			const installedHook = await currentPostBuildHook();
			writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ currentHook, installedHook, env: process.env }));
		`;
		// Keep @actions/core output inside the child, away from node:test's reporter.
		run(process.execPath, ["--input-type=module", "-e", driver]);
		return JSON.parse(readFileSync(resultFile, "utf8")) as SetupResult;
	};

	const hook = (name: string) => {
		const path = join(root, name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
		return path;
	};

	return {
		root,
		env,
		systemConfig,
		userConfig,
		runnerTemp,
		githubEnv,
		netrc,
		cacheConfig,
		effectiveSettings,
		configure,
		hook,
	};
};

type Fixture = ReturnType<typeof fixture>;

const assertSetup = (f: Fixture, before: Record<string, unknown>, result: SetupResult) => {
	const after = f.effectiveSettings(result.env);
	for (const name of ["substituters", "trusted-public-keys", "netrc-file"]) {
		assert.deepEqual(after[name], before[name], `${name} must survive installing the collector`);
	}
	const { "post-build-hook": previousHook, ...previousSettings } = before;
	const { "post-build-hook": installedHook, ...installedSettings } = after;
	assert.deepEqual(installedSettings, previousSettings, "only post-build-hook may change in Nix's effective settings");
	assert.equal(result.currentHook, previousHook, "currentPostBuildHook must agree with real Nix before setup");

	const pathsDir = result.env["ATTIC_POST_BUILD_PATHS_DIR"];
	const eventsLog = result.env["ATTIC_POST_BUILD_EVENTS_LOG"];
	assert.ok(pathsDir && isAbsolute(pathsDir));
	assert.ok(eventsLog && isAbsolute(eventsLog));
	const stateDir = dirname(pathsDir);
	const wrapper = join(stateDir, "post-build-hook.js");
	assert.equal(dirname(stateDir), f.runnerTemp);
	assert.equal(statSync(stateDir).mode & 0o777, 0o700, "hook state must be private to the runner");
	assert.ok(statSync(pathsDir).isDirectory());
	assert.ok(statSync(eventsLog).isFile());
	assert.equal(dirname(eventsLog), stateDir);
	accessSync(wrapper, constants.X_OK);
	assert.equal(installedHook, wrapper, "Nix must actually select the generated wrapper");
	assert.equal(result.installedHook, wrapper);
	assert.equal(result.env["NIX_USER_CONF_FILES"], f.env["NIX_USER_CONF_FILES"], "do not replace user config discovery");
	assert.equal(result.env["ATTIC_POST_BUILD_HOOK"], undefined);
	assert.equal(result.env["ATTIC_ORIGINAL_POST_BUILD_HOOK"], undefined);

	const oldInline = f.env["NIX_CONFIG"] ?? "";
	const newInline = result.env["NIX_CONFIG"];
	assert.ok(
		typeof newInline === "string" && newInline.startsWith(oldInline),
		"preserve existing inline config verbatim",
	);
	const appended = newInline.slice(oldInline.length);
	assert.ok(
		!oldInline || oldInline.endsWith("\n") || appended.startsWith("\n"),
		"separate the appended setting with a newline",
	);
	assert.equal(appended.trim(), `post-build-hook = ${wrapper}`, "append exactly one hook setting to NIX_CONFIG");

	const exports = Array.from(readFileSync(f.githubEnv, "utf8").matchAll(/^([A-Z_][A-Z_0-9]*)<</gm), ([, name]) => name);
	assert.deepEqual(exports.sort(), ["ATTIC_POST_BUILD_EVENTS_LOG", "ATTIC_POST_BUILD_PATHS_DIR", "NIX_CONFIG"]);

	// Inspect the actual generated shim, not postBuildHookScript directly: the
	// daemon must receive the effective original hook in its baked configuration.
	const shim = readFileSync(wrapper, "utf8");
	const match = shim.match(/runHook\((\{.+\})\);/s);
	assert.ok(match, "generated wrapper must pass baked JSON to runHook");
	const baked = JSON.parse(match[1]!);
	assert.deepEqual(baked, { pathsDir, eventsLog, wrapper, originalHook: previousHook });
	return stateDir;
};

const assertCacheSettings = (f: Fixture, settings: Record<string, unknown>) => {
	assert.deepEqual(settings["substituters"], [cache], "fixture cache must be active before setup");
	assert.deepEqual(settings["trusted-public-keys"], [publicKey]);
	assert.equal(settings["netrc-file"], f.netrc);
};

const checkConfiguration = (f: Fixture, expectedHook: string | string[]) => {
	const before = f.effectiveSettings();
	assertCacheSettings(f, before);
	if (typeof expectedHook === "string") {
		assert.equal(before["post-build-hook"], expectedHook, "fixture must select the intended hook before setup");
	} else {
		// The oracle, not a hand-coded ordering rule, decides precedence between
		// multiple explicit user files on the selected Nix implementation.
		assert.ok(expectedHook.includes(before["post-build-hook"] as string));
	}
	return assertSetup(f, before, f.configure());
};

describe(
	"post-build-hook configuration with real Nix",
	{
		skip: nixExecutable
			? false
			: "Nix is not installed: install Nix or set ATTIC_TEST_NIX to an absolute Nix/Lix executable",
	},
	() => {
		test("preserves default user config when NIX_CONFIG and NIX_USER_CONF_FILES are unset", (t) => {
			checkConfiguration(fixture(t), "");
		});

		test("preserves explicit user config files and follows real Nix's hook precedence", (t) => {
			const f = fixture(t);
			const firstConfig = join(f.root, "first.conf");
			const secondConfig = join(f.root, "second.conf");
			const firstHook = f.hook("first-hook");
			const secondHook = f.hook("second-hook");
			const ignoredHook = f.hook("ignored-default-hook");
			writeFileSync(firstConfig, `${f.cacheConfig}post-build-hook = ${firstHook}\n`);
			writeFileSync(secondConfig, `post-build-hook = ${secondHook}\n`);
			writeFileSync(f.userConfig, `substituters = https://ignored.invalid\npost-build-hook = ${ignoredHook}\n`);
			f.env["NIX_USER_CONF_FILES"] = `${firstConfig}:${secondConfig}`;
			checkConfiguration(f, [firstHook, secondHook]);
		});

		test("preserves inline cache settings and appends after a final line without a newline", (t) => {
			const f = fixture(t);
			writeFileSync(f.userConfig, "substituters = https://overridden.invalid\n");
			f.env["NIX_CONFIG"] = `${f.cacheConfig}connect-timeout = 17`;
			checkConfiguration(f, "");
		});

		test("installs via NIX_CONFIG even when its existing value is explicitly empty", (t) => {
			const f = fixture(t);
			f.env["NIX_CONFIG"] = "";
			checkConfiguration(f, "");
		});

		test("chains an existing system hook while retaining default user cache settings", (t) => {
			const f = fixture(t);
			const hook = f.hook("system-hook");
			writeFileSync(f.systemConfig, `post-build-hook = ${hook}\n`);
			checkConfiguration(f, hook);
		});

		test("finds a hook through a relative include in the default user config", (t) => {
			const f = fixture(t);
			const hook = f.hook("included-hook");
			writeFileSync(join(dirname(f.userConfig), "hook.conf"), `post-build-hook = ${hook}\n`);
			writeFileSync(f.userConfig, `${f.cacheConfig}include hook.conf\n`);
			checkConfiguration(f, hook);
		});

		test("uses Nix's interpretation of a hook with a trailing inline comment", (t) => {
			const f = fixture(t);
			const hook = f.hook("commented-hook");
			f.env["NIX_CONFIG"] = `post-build-hook = ${hook} # this comment is not part of the hook\n`;
			checkConfiguration(f, hook);
		});

		test("chains the final inline override instead of the system or user hook", (t) => {
			const f = fixture(t);
			const systemHook = f.hook("system-hook");
			const userHook = f.hook("user-hook");
			const inlineHook = f.hook("inline-hook");
			writeFileSync(f.systemConfig, `post-build-hook = ${systemHook}\n`);
			writeFileSync(f.userConfig, `${f.cacheConfig}post-build-hook = ${userHook}\n`);
			f.env["NIX_CONFIG"] = `post-build-hook = ${userHook}\npost-build-hook = ${inlineHook}\n`;
			checkConfiguration(f, inlineHook);
		});

		test("an explicit empty user hook cancels an earlier system hook", (t) => {
			const f = fixture(t);
			writeFileSync(f.systemConfig, `post-build-hook = ${f.hook("system-hook")}\n`);
			writeFileSync(f.userConfig, `${f.cacheConfig}post-build-hook =\n`);
			checkConfiguration(f, "");
		});

		test("an explicit empty inline hook cancels user and earlier inline hooks", (t) => {
			const f = fixture(t);
			writeFileSync(f.userConfig, `${f.cacheConfig}post-build-hook = ${f.hook("user-hook")}\n`);
			f.env["NIX_CONFIG"] = `post-build-hook = ${f.hook("inline-hook")}\npost-build-hook =\n`;
			checkConfiguration(f, "");
		});

		test("does not resurrect a stale Cachix hook when no effective hook is configured", (t) => {
			const f = fixture(t);
			f.env["CACHIX_DAEMON_DIR"] = dirname(f.hook("stale-cachix/post-build-hook.sh"));
			checkConfiguration(f, "");
		});

		test("does not prefer a stale Cachix hook over the active user hook", (t) => {
			const f = fixture(t);
			const hook = f.hook("active-user-hook");
			writeFileSync(f.userConfig, `${f.cacheConfig}post-build-hook = ${hook}\n`);
			f.env["CACHIX_DAEMON_DIR"] = dirname(f.hook("stale-cachix/post-build-hook.sh"));
			checkConfiguration(f, hook);
		});

		test("an explicit empty hook does not fall back to stale Cachix daemon state", (t) => {
			const f = fixture(t);
			writeFileSync(f.userConfig, `${f.cacheConfig}post-build-hook = ${f.hook("user-hook")}\n`);
			f.env["NIX_CONFIG"] = "post-build-hook =\n";
			f.env["CACHIX_DAEMON_DIR"] = dirname(f.hook("stale-cachix/post-build-hook.sh"));
			checkConfiguration(f, "");
		});

		test("separate setups sharing RUNNER_TEMP get distinct private state directories", (t) => {
			const f = fixture(t);
			const firstStateDir = checkConfiguration(f, "");
			const firstWrapper = join(firstStateDir, "post-build-hook.js");
			const originalShim = readFileSync(firstWrapper, "utf8");
			const secondStateDir = checkConfiguration(f, "");
			assert.notEqual(secondStateDir, firstStateDir, "a later action must not overwrite an earlier collector");
			assert.equal(readFileSync(firstWrapper, "utf8"), originalShim);
		});
	},
);
