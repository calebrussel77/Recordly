import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("recording session manifest", () => {
	let tempRoot: string;
	let appDataPath: string;
	let userDataPath: string;
	let tempPath: string;
	let appPath: string;

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-session-"));
		appDataPath = path.join(tempRoot, "AppData");
		userDataPath = path.join(tempRoot, "UserData");
		tempPath = path.join(tempRoot, "Temp");
		appPath = path.join(tempRoot, "App");
		await Promise.all(
			[appDataPath, userDataPath, tempPath, appPath].map((dirPath) =>
				fs.mkdir(dirPath, { recursive: true }),
			),
		);

		vi.resetModules();
		vi.doMock("electron", () => ({
			app: {
				isPackaged: false,
				getAppPath: () => appPath,
				getPath: (name: string) => {
					if (name === "appData") return appDataPath;
					if (name === "userData") return userDataPath;
					if (name === "temp") return tempPath;
					return tempRoot;
				},
				setPath: () => undefined,
			},
		}));
	});

	afterEach(async () => {
		vi.resetModules();
		vi.restoreAllMocks();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("persists and restores source audio fallback paths with timing metadata", async () => {
		const {
			getRecordingSessionManifestPath,
			persistRecordingSessionManifest,
			resolveRecordingSessionManifest,
		} = await import("./session");
		const videoPath = path.join(tempRoot, "recording.mp4");
		const micPath = path.join(tempRoot, "recording.mic.wav");

		await fs.writeFile(videoPath, "video");
		await fs.writeFile(micPath, "audio");

		await persistRecordingSessionManifest({
			videoPath,
			webcamPath: null,
			sourceAudioFallbackPaths: [micPath],
			sourceAudioFallbackStartDelayMsByPath: {
				[micPath]: 187.4,
			},
		});

		const manifestPath = getRecordingSessionManifestPath(videoPath);
		const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
		expect(manifest).toMatchObject({
			version: 3,
			webcamFileName: null,
			sourceAudioFallbackFileNames: ["recording.mic.wav"],
			sourceAudioFallbackStartDelayMsByFileName: {
				"recording.mic.wav": 187,
			},
		});

		await expect(resolveRecordingSessionManifest(videoPath)).resolves.toMatchObject({
			videoPath,
			webcamPath: null,
			sourceAudioFallbackPaths: [micPath],
			sourceAudioFallbackStartDelayMsByPath: {
				[micPath]: 187,
			},
		});
	});

	it("merges a discovered system sidecar into a mic-only base without dropping or duplicating", async () => {
		const { mergeSourceAudioFallbackPaths } = await import("./session");
		const micPath = "/r/recording.mic.wav";
		const systemPath = "/r/recording.system.wav";

		const merged = mergeSourceAudioFallbackPaths(
			{ paths: [micPath], startDelayMsByPath: { [micPath]: 187 } },
			{
				// Discovery re-reports the mic with different timing and adds system audio.
				paths: [systemPath, micPath],
				startDelayMsByPath: { [systemPath]: 40, [micPath]: 999 },
			},
		);

		expect(merged.paths).toEqual([micPath, systemPath]);
		// Base (recorder-provided) timing wins; discovered system timing is kept.
		expect(merged.startDelayMsByPath).toEqual({
			[micPath]: 187,
			[systemPath]: 40,
		});
	});

	it("returns the base selection unchanged when there is nothing to merge", async () => {
		const { mergeSourceAudioFallbackPaths } = await import("./session");
		const micPath = "/r/recording.mic.wav";

		const merged = mergeSourceAudioFallbackPaths(
			{ paths: [micPath], startDelayMsByPath: { [micPath]: 5 } },
			{ paths: [], startDelayMsByPath: {} },
		);

		expect(merged.paths).toEqual([micPath]);
		expect(merged.startDelayMsByPath).toEqual({ [micPath]: 5 });
	});
});
