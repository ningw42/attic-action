import * as core from "@actions/core";
import { exec, getExecOutput } from "@actions/exec";
import stringArgv from "string-argv";

import {
	applyPathFilters,
	excludeTemporaryPaths,
	getPathDiscovery,
	getPostBuildHookPaths,
	getStorePaths,
	INTERNAL_DRY_RUN,
	PATH_DISCOVERY_STORE_SCAN,
	printPostBuildHookCaptureLog,
	saveStorePaths,
} from "../utils";

// Leave ample room below platform argv limits for the inherited environment
// and pointer overhead, even when a build produces many long store paths.
const VALIDITY_MAX_PATHS = 128;
const VALIDITY_MAX_ARG_BYTES = 16 * 1024;
const VALIDITY_ARGS = ["--check-validity", "--print-invalid"];
const VALIDITY_BASE_BYTES = ["nix-store", ...VALIDITY_ARGS].reduce(
	(bytes, arg) => bytes + Buffer.byteLength(arg) + 1,
	0,
);

const keepValidStorePaths = async (paths: string[]): Promise<string[]> => {
	const invalid = new Set<string>();
	try {
		let offset = 0;
		while (offset < paths.length) {
			const chunk: string[] = [];
			let bytes = VALIDITY_BASE_BYTES;
			while (offset < paths.length && chunk.length < VALIDITY_MAX_PATHS) {
				const path = paths[offset]!;
				const pathBytes = Buffer.byteLength(path) + 1;
				if (VALIDITY_BASE_BYTES + pathBytes > VALIDITY_MAX_ARG_BYTES) {
					throw new Error("A candidate path exceeds the validity-query argument limit");
				}
				if (bytes + pathBytes > VALIDITY_MAX_ARG_BYTES) break;
				chunk.push(path);
				bytes += pathBytes;
				offset++;
			}

			const result = await getExecOutput("nix-store", [...VALIDITY_ARGS, ...chunk], {
				ignoreReturnCode: true,
				silent: true,
			});
			if (result.exitCode !== 0) {
				throw new Error(`nix-store exited with code ${result.exitCode}: ${result.stderr.trim()}`);
			}
			const candidates = new Set(chunk);
			for (const line of result.stdout.split(/\r?\n/)) {
				const path = line.trim();
				if (!path) continue;
				if (!candidates.has(path)) {
					throw new Error(`nix-store returned a non-candidate path: ${path}`);
				}
				invalid.add(path);
			}
		}
	} catch (error) {
		throw new Error(`Unable to validate Nix store paths; skipping upload: ${error}`);
	}

	if (invalid.size > 0) {
		core.warning(`Skipping ${invalid.size} Nix-invalid store path(s):\n${Array.from(invalid).join("\n")}`);
	}
	return paths.filter((path) => !invalid.has(path));
};

export const push = async () => {
	try {
		if (core.getInput("skip-push") === "true") {
			core.info("Pushing to cache is disabled by skip-push");
			return;
		}

		const cache = core.getInput("cache");
		const pathDiscovery = getPathDiscovery();
		const pushArgs = stringArgv(core.getInput("push-args"));

		let pushPaths: string[];
		if (pathDiscovery === PATH_DISCOVERY_STORE_SCAN) {
			const oldPaths = new Set(await getStorePaths());
			await saveStorePaths();
			const newPaths = await getStorePaths();
			pushPaths = newPaths.filter((path) => !oldPaths.has(path));
		} else {
			pushPaths = await getPostBuildHookPaths();
			// Diagnostics own their group, outside the upload group. A damaged log
			// must not prevent independently collected paths from reaching Attic.
			try {
				await printPostBuildHookCaptureLog();
			} catch (error) {
				core.warning(`Unable to print post-build hook capture log: ${error}`);
			}
		}

		await core.group("Push to Attic", async () => {
			// Keep the same temporary-path guard and filters in both modes.
			pushPaths = applyPathFilters(excludeTemporaryPaths(pushPaths));
			core.info(`Discovered ${pushPaths.length} store path(s) to push using ${pathDiscovery}`);
			pushPaths = await keepValidStorePaths(pushPaths);
			if (pushPaths.length === 0) {
				core.info("No valid store paths to push; skipping upload.");
				return;
			}

			// This narrows, but cannot eliminate, the check-to-push GC race:
			// validation does not create GC roots to pin the paths during upload.
			core.info("Pushing to cache");
			if (!INTERNAL_DRY_RUN) {
				await exec("attic", ["push", ...pushArgs, "--stdin", cache], {
					input: Buffer.from(pushPaths.join("\n")),
				});
			} else {
				console.log("Pushing paths", pushPaths);
			}
		});
	} catch (error) {
		core.warning(`Action encountered error: ${error}`);
		core.info("Not considering errors during push a failure.");
	}
};
