import * as core from "@actions/core";
import { getExecOutput } from "@actions/exec";

import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import type { HookConfig, HookEvent } from "./post-build-hook";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const INTERNAL_DRY_RUN = ["true", "1", "yes"].includes(
	core.getInput("__internal-dry-run", { required: false, trimWhitespace: true }),
);

const TEMPORARY_PATH_SUFFIXES = [".drv", ".drv.chroot", ".check", ".lock"];

export const excludeTemporaryPaths = (paths: string[]): string[] =>
	paths.filter((p) => !TEMPORARY_PATH_SUFFIXES.some((suffix) => p.endsWith(suffix)));

export const applyPathFilters = (paths: string[]): string[] => {
	let result = paths;

	const includePaths = core.getMultilineInput("include-paths").map((v) => new RegExp(v));
	if (includePaths.length > 0) {
		result = result.filter((p) => includePaths.some((v) => v.test(p)));
	}

	const excludePaths = core.getMultilineInput("exclude-paths").map((v) => new RegExp(v));
	if (excludePaths.length > 0) {
		result = result.filter((p) => !excludePaths.some((v) => v.test(p)));
	}

	return result;
};

export const PATH_DISCOVERY_STORE_SCAN = "store-scan";
export const PATH_DISCOVERY_POST_BUILD_HOOK = "post-build-hook";

export type PathDiscovery = typeof PATH_DISCOVERY_STORE_SCAN | typeof PATH_DISCOVERY_POST_BUILD_HOOK;

const POST_BUILD_HOOK_STATE_PREFIX = "post_build_hook";

type PostBuildHookState = Pick<HookConfig, "pathsDir" | "eventsLog">;

export const getPathDiscovery = (): PathDiscovery => {
	const pathDiscovery = core.getInput("path-discovery-mode") || PATH_DISCOVERY_STORE_SCAN;

	if (pathDiscovery === PATH_DISCOVERY_STORE_SCAN || pathDiscovery === PATH_DISCOVERY_POST_BUILD_HOOK) {
		return pathDiscovery;
	}

	throw new Error(
		`Unsupported path-discovery-mode value: ${pathDiscovery}. Expected '${PATH_DISCOVERY_STORE_SCAN}' or '${PATH_DISCOVERY_POST_BUILD_HOOK}'.`,
	);
};

const STORE_PATHS = `${process.env["RUNNER_TEMP"] || "/tmp"}/attic-action-store-paths`;

export const saveStorePaths = async () => {
	const supportsJSONFormat = await getExecOutput("nix", ["path-info", "--help"], {
		ignoreReturnCode: true,
		silent: true,
	}).then(({ stdout }) => stdout.includes("--json-format"));

	let paths = [];

	if (supportsJSONFormat) {
		const { stdout } = await getExecOutput("nix", ["path-info", "--all", "--json", "--json-format", "2"], {
			silent: true,
		});
		const data = JSON.parse(stdout) as { info: Record<string, unknown>; storeDir: string };
		paths = Object.keys(data.info).map((k) => `${data.storeDir}/${k}`);
	} else {
		const { stdout } = await getExecOutput("nix", ["path-info", "--all", "--json"], { silent: true });
		const data = JSON.parse(stdout) as { path: string }[];
		paths = data.map((drv) => drv.path);
	}

	await writeFile(STORE_PATHS, paths.join("\n"));
};

export const getStorePaths = async () => {
	return readFile(STORE_PATHS, { encoding: "utf8" }).then((raw) => raw.split("\n").filter(Boolean));
};

export const getPostBuildHookPaths = async () => {
	const state = getPostBuildHookState();
	const paths = new Set<string>();

	if (!state.pathsDir || !(await exists(state.pathsDir))) {
		return [];
	}

	const entries = await readdir(state.pathsDir);
	for (const entry of entries) {
		if (!entry.startsWith("paths.")) continue;

		const content = await readFile(join(state.pathsDir, entry), "utf8");
		for (const line of content.split(/\r?\n/)) {
			const path = line.trim();
			if (path !== "") paths.add(path);
		}
	}

	return Array.from(paths).sort();
};

export type HookEventRecord = Partial<HookEvent>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isHookEventRecord = (value: unknown): value is HookEventRecord => {
	if (!isRecord(value)) return false;
	const optionalString = (object: Record<string, unknown>, key: string) =>
		object[key] === undefined || typeof object[key] === "string";
	for (const key of ["ts", "rawOutPaths"]) {
		if (!optionalString(value, key)) return false;
	}
	for (const key of ["drvPath", "pathsFile"]) {
		if (value[key] !== null && !optionalString(value, key)) return false;
	}
	if (value["pid"] !== undefined && (typeof value["pid"] !== "number" || !Number.isFinite(value["pid"]))) return false;
	if (
		value["paths"] !== undefined &&
		(!Array.isArray(value["paths"]) || !value["paths"].every((path) => typeof path === "string"))
	)
		return false;
	const chained = value["chained"];
	if (
		chained !== undefined &&
		chained !== null &&
		(!isRecord(chained) ||
			typeof chained["hook"] !== "string" ||
			(chained["status"] !== null && (typeof chained["status"] !== "number" || !Number.isFinite(chained["status"]))) ||
			!optionalString(chained, "error") ||
			(chained["signal"] !== null && !optionalString(chained, "signal")))
	)
		return false;
	const skipped = value["skipped"];
	if (
		skipped !== undefined &&
		(!isRecord(skipped) || typeof skipped["reason"] !== "string" || !optionalString(skipped, "detail"))
	)
		return false;
	const error = value["error"];
	if (
		error !== undefined &&
		(!isRecord(error) || typeof error["message"] !== "string" || !optionalString(error, "stack"))
	)
		return false;
	return true;
};

export const summarizeHookEvent = (event: HookEventRecord, index: number): string => {
	const parts: string[] = [];
	parts.push(`#${index + 1} ${event.ts ?? "?"} pid=${event.pid ?? "?"}`);
	if (event.drvPath) parts.push(`  drv:     ${event.drvPath}`);
	const paths = event.paths ?? [];
	parts.push(`  paths:   ${paths.length}${paths.length > 0 ? ` (${paths.join(", ")})` : ""}`);
	if (event.pathsFile) parts.push(`  file:    ${event.pathsFile}`);
	if (event.skipped) {
		parts.push(`  skipped: ${event.skipped.reason}${event.skipped.detail ? ` — ${event.skipped.detail}` : ""}`);
	}
	if (event.chained) {
		const { hook, status, signal, error } = event.chained;
		parts.push(
			`  chained: ${hook} (status=${status ?? "n/a"}${signal ? `, signal=${signal}` : ""}${error ? `, error=${error}` : ""})`,
		);
	}
	if (event.error) parts.push(`  error:   ${event.error.message}`);
	return parts.join("\n");
};

export const printPostBuildHookCaptureLog = async () => {
	const { eventsLog } = getPostBuildHookState();

	core.startGroup("Attic post-build hook capture log");

	const emptyMessage =
		"No hook invocations were captured. This usually means no new paths were built (e.g. all outputs were already in the store or fetched from a substituter), or less commonly that the collector was not installed in Nix's active config.";

	if (!eventsLog || !(await exists(eventsLog))) {
		core.warning(emptyMessage);
		core.endGroup();
		return;
	}

	const content = await readFile(eventsLog, "utf8");
	const lines = content.split(/\r?\n/).filter((l) => l.trim() !== "");

	if (lines.length === 0) {
		core.warning(emptyMessage);
		core.endGroup();
		return;
	}

	const events: HookEventRecord[] = [];
	const malformed: string[] = [];
	for (const line of lines) {
		try {
			const event: unknown = JSON.parse(line);
			if (isHookEventRecord(event)) events.push(event);
			else malformed.push(line);
		} catch {
			malformed.push(line);
		}
	}

	const totalPaths = events.reduce((sum, e) => sum + (e.paths?.length ?? 0), 0);
	core.info(`Captured ${events.length} hook invocation(s); ${totalPaths} path(s) reported by Nix.`);

	for (let i = 0; i < events.length; i++) {
		core.info(summarizeHookEvent(events[i]!, i));
	}

	if (malformed.length > 0) {
		core.warning(`Ignored ${malformed.length} malformed event log line(s).`);
		if (core.isDebug()) {
			for (const line of malformed) core.debug(`malformed line: ${line}`);
		}
	}

	if (core.isDebug()) {
		core.startGroup("Raw event log (JSONL)");
		core.debug(content.trimEnd());
		core.endGroup();
	}

	core.endGroup();
};

export const configurePostBuildHookPathDiscovery = async () => {
	// Ask Nix after attic use has updated the configuration; don't guess which
	// config source wins or resurrect an inactive hook from another action.
	const originalHook = await currentPostBuildHook();
	const runnerTemp = process.env["RUNNER_TEMP"] || tmpdir();
	const stateDir = await mkdtemp(join(runnerTemp, "attic-action-post-build-hook-"));
	const pathsDir = join(stateDir, "paths");
	const eventsLog = join(stateDir, "events.log");
	const wrapper = join(stateDir, "post-build-hook.js");

	// The runner owns these private directories. Root can write through them,
	// but unrelated UIDs cannot inject captures even in a traversable RUNNER_TEMP.
	await chmod(stateDir, 0o700);
	await mkdir(pathsDir, { mode: 0o700 });
	await chmod(pathsDir, 0o700);
	await writeFile(eventsLog, "", { mode: 0o600 });
	await chmod(eventsLog, 0o600);
	await writeFile(wrapper, postBuildHookScript({ pathsDir, eventsLog, wrapper, originalHook }), { mode: 0o700 });
	await chmod(wrapper, 0o700);

	savePostBuildHookState({ pathsDir, eventsLog });
	core.exportVariable("ATTIC_POST_BUILD_PATHS_DIR", pathsDir);
	core.exportVariable("ATTIC_POST_BUILD_EVENTS_LOG", eventsLog);

	// Overlay only the hook. Setting NIX_USER_CONF_FILES would hide default
	// user configuration, including substituters/credentials written by attic use.
	core.exportVariable("NIX_CONFIG", `${process.env["NIX_CONFIG"] || ""}\npost-build-hook = ${wrapper}`);

	core.info(`Installed Attic post-build hook collector at ${wrapper}`);
	if (originalHook) {
		core.info(`Composing with existing post-build hook: ${originalHook}`);
	} else {
		core.warning("No existing post-build hook found");
	}
};

const savePostBuildHookState = ({ pathsDir, eventsLog }: PostBuildHookState) => {
	core.saveState(`${POST_BUILD_HOOK_STATE_PREFIX}-paths-dir`, pathsDir);
	core.saveState(`${POST_BUILD_HOOK_STATE_PREFIX}-events-log`, eventsLog);
};

const getPostBuildHookState = (): Partial<PostBuildHookState> => ({
	pathsDir: core.getState(`${POST_BUILD_HOOK_STATE_PREFIX}-paths-dir`) || process.env["ATTIC_POST_BUILD_PATHS_DIR"],
	eventsLog: core.getState(`${POST_BUILD_HOOK_STATE_PREFIX}-events-log`) || process.env["ATTIC_POST_BUILD_EVENTS_LOG"],
});

export const currentPostBuildHook = async (): Promise<string> => {
	const flags = ["--extra-experimental-features", "nix-command"];
	const options = { ignoreReturnCode: true, silent: true };
	let result = await getExecOutput("nix", [...flags, "config", "show", "--json"], options);
	if (result.exitCode !== 0) {
		// Older Nix and Lix expose this command under the original name.
		result = await getExecOutput("nix", [...flags, "show-config", "--json"], options);
	}
	if (result.exitCode !== 0) throw new Error("Could not query effective Nix configuration for post-build-hook");

	let config: unknown;
	try {
		config = JSON.parse(result.stdout);
	} catch {
		throw new Error("Invalid effective Nix configuration JSON");
	}
	const setting = isRecord(config) ? config["post-build-hook"] : undefined;
	if (!isRecord(setting) || typeof setting["value"] !== "string") {
		throw new Error("Effective Nix configuration does not contain a string post-build-hook setting");
	}
	return setting["value"];
};

// The wrapper installed into Nix's `post-build-hook` is a tiny Node shim
// that requires the bundled `dist/post-build-hook.js` and invokes it with
// the absolute paths baked in. We do this instead of relying on environment
// variables because the nix-daemon strips/normalizes the env it passes to
// hooks. Bundling lets us write the hook in TypeScript with the same
// toolchain as the rest of the action while keeping the runtime artifact
// fully self-contained (no `node_modules` lookup at hook time).
export const postBuildHookScript = (state: HookConfig) => {
	// `__dirname` is defined in the bundled CJS output (`dist/index.js`) and
	// resolves to the dist directory at runtime, so the sibling bundle
	// `post-build-hook.js` is discoverable. When loaded as ESM (e.g. tests),
	// fall back to `import.meta.url`-derived path.
	const here = typeof __dirname !== "undefined" ? __dirname : new URL(".", import.meta.url).pathname;
	const bundlePath = join(here, "post-build-hook.js");
	const config = JSON.stringify(state);
	// Bake in the absolute path to the node binary running the action rather
	// than relying on `/usr/bin/env node`. On macOS the nix-daemon is launched
	// by launchd with a minimal PATH that does not include the node installed
	// by `actions/setup-node`, so a PATH lookup fails with ENOENT.
	return `#!${process.execPath}
require(${JSON.stringify(bundlePath)}).runHook(${config});
`;
};

const exists = async (path: string) => {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
};
