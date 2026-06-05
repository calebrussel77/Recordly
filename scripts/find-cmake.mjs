import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Locate a CMake executable across the common Windows install locations.
 *
 * Search order:
 *   1. `cmake` on PATH
 *   2. Standalone CMake installs (both Program Files roots)
 *   3. Visual Studio bundled CMake (both roots, 2022/2019, all editions)
 *
 * @param {{ quote?: boolean }} [options] When `quote` is true the returned path
 *   is wrapped in double quotes so it can be safely interpolated into a shell
 *   command string (e.g. `execSync(`${cmake} ...`)`). Leave it false (the
 *   default) when passing the result as the file argument to `execFileSync`,
 *   which does not go through a shell and would treat the quotes as part of the
 *   literal filename.
 * @returns {string | null} The cmake invocation token, or null if not found.
 */
export function findCmake({ quote = false } = {}) {
	// `cmake` on PATH needs no quoting in either mode.
	try {
		execSync("cmake --version", { stdio: "pipe" });
		return "cmake";
	} catch {
		// not on PATH; probe common Windows install locations below.
	}

	if (process.platform !== "win32") {
		return null;
	}

	const format = (cmakePath) => (quote ? `"${cmakePath}"` : cmakePath);

	// Standalone CMake installs.
	const standaloneCmakePaths = [
		path.join("C:", "Program Files", "CMake", "bin", "cmake.exe"),
		path.join("C:", "Program Files (x86)", "CMake", "bin", "cmake.exe"),
	];
	for (const cmakePath of standaloneCmakePaths) {
		if (existsSync(cmakePath)) {
			return format(cmakePath);
		}
	}

	// Visual Studio bundled CMake. Build Tools (and other editions) may be
	// installed under either Program Files root, so check both.
	const vsRoots = [
		path.join("C:", "Program Files", "Microsoft Visual Studio"),
		path.join("C:", "Program Files (x86)", "Microsoft Visual Studio"),
	];
	const vsVersions = ["2022", "2019"];
	const vsEditions = ["Preview", "Community", "Professional", "Enterprise", "BuildTools"];
	for (const root of vsRoots) {
		for (const version of vsVersions) {
			for (const edition of vsEditions) {
				const cmakePath = path.join(
					root,
					version,
					edition,
					"Common7",
					"IDE",
					"CommonExtensions",
					"Microsoft",
					"CMake",
					"CMake",
					"bin",
					"cmake.exe",
				);
				if (existsSync(cmakePath)) {
					return format(cmakePath);
				}
			}
		}
	}

	return null;
}
