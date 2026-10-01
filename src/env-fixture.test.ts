import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestEnv } from "./env-fixture.ts";

test("environment helpers restore first values, delete absent keys, and keep independent state", () => {
	const outer = createTestEnv();
	const first = createTestEnv();
	const second = createTestEnv();
	const present = "ATTIC_ENV_HELPER_PRESENT";
	const absent = "ATTIC_ENV_HELPER_ABSENT";
	try {
		outer.setEnv(present, "original");
		outer.setEnv(absent, undefined);
		first.setEnv(present, "changed");
		first.setEnv(present, undefined);
		second.setEnv(absent, "created");
		first.restoreEnv();
		assert.equal(process.env[present], "original");
		assert.equal(process.env[absent], "created");
		second.restoreEnv();
		assert.equal(Object.hasOwn(process.env, absent), false);
		first.setEnv(present, "again");
		first.restoreEnv();
		assert.equal(process.env[present], "original");
	} finally {
		first.restoreEnv();
		second.restoreEnv();
		outer.restoreEnv();
	}
});
