import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEEPFILTER_VERSION = "0.5.6";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const targets = {
	"win32-x64": {
		asset: `deep-filter-${DEEPFILTER_VERSION}-x86_64-pc-windows-msvc.exe`,
		binary: "deep-filter.exe",
	},
	"darwin-x64": {
		asset: `deep-filter-${DEEPFILTER_VERSION}-x86_64-apple-darwin`,
		binary: "deep-filter",
	},
	"darwin-arm64": {
		asset: `deep-filter-${DEEPFILTER_VERSION}-aarch64-apple-darwin`,
		binary: "deep-filter",
	},
	"linux-x64": {
		asset: `deep-filter-${DEEPFILTER_VERSION}-x86_64-unknown-linux-musl`,
		binary: "deep-filter",
	},
};

function getArchTag() {
	if (process.platform === "darwin") {
		return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
	}
	if (process.platform === "win32") {
		return process.arch === "arm64" ? "win32-arm64" : "win32-x64";
	}
	if (process.platform === "linux") {
		return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
	}
	return `${process.platform}-${process.arch}`;
}

async function exists(filePath) {
	try {
		await fs.access(filePath, fsConstants.X_OK);
		return true;
	} catch {
		try {
			await fs.access(filePath, fsConstants.F_OK);
			return true;
		} catch {
			return false;
		}
	}
}

async function main() {
	const archTag = getArchTag();
	const target = targets[archTag];
	if (!target) {
		console.warn(`[deepfilter] No prebuilt DeepFilterNet binary for ${archTag}; skipping`);
		return;
	}

	const outputDir = path.join(rootDir, "electron", "native", "bin", archTag);
	const outputPath = path.join(outputDir, target.binary);
	if (await exists(outputPath)) {
		console.log(`[deepfilter] Runtime already present at ${outputPath}`);
		return;
	}

	const url = `https://github.com/Rikorose/DeepFilterNet/releases/download/v${DEEPFILTER_VERSION}/${target.asset}`;
	console.log(`[deepfilter] Downloading ${url}`);
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(
			`Failed to download DeepFilterNet runtime: ${response.status} ${response.statusText}`,
		);
	}

	await fs.mkdir(outputDir, { recursive: true });
	const bytes = new Uint8Array(await response.arrayBuffer());
	await fs.writeFile(outputPath, bytes);
	if (process.platform !== "win32") {
		await fs.chmod(outputPath, 0o755);
	}
	console.log(`[deepfilter] Runtime saved to ${outputPath}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
