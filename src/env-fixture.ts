// Each caller owns its mutations; importing this helper never shares mutable state.
export const createTestEnv = () => {
	const saved = new Map<string, string | undefined>();
	return {
		setEnv(key: string, value: string | undefined) {
			if (!saved.has(key)) saved.set(key, process.env[key]);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		},
		restoreEnv() {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			saved.clear();
		},
	};
};
