import { beforeEach, describe, expect, it, vi } from "vitest";

const audioEnhancementMocks = vi.hoisted(() => ({
	enhanceSourceAudioPathsForExport: vi.fn(
		async (input: { paths: string[]; startDelayMsByPath?: Record<string, number> }) => ({
			paths: input.paths,
			startDelayMsByPath: input.startDelayMsByPath ?? {},
		}),
	),
}));

vi.mock("@/components/video-editor/audio/audioEnhancementClient", () => ({
	enhanceSourceAudioPathsForExport: audioEnhancementMocks.enhanceSourceAudioPathsForExport,
}));

import { AudioProcessor } from "./audioEncoder";

type OfflineRenderTestHarness = AudioProcessor & {
	decodeAudioFromUrl(url: string): Promise<AudioBuffer | null>;
	getMediaDurationSec(url: string): Promise<number>;
	loadAudioFileDemuxer(audioPath: string): Promise<unknown>;
	prepareOfflineRender(
		videoUrl: string,
		trimRegions: never[],
		speedRegions: never[],
		audioRegions: never[],
		sourceAudioFallbackPaths: string[],
		sourceAudioFallbackStartDelayMsByPath?: Record<string, number>,
	): Promise<{
		mainBufferEntry: { buffer: AudioBuffer; gain: number } | null;
		companionEntries: Array<{ buffer: AudioBuffer; startDelaySec: number }>;
	}>;
	renderAndMuxOfflineAudio(
		videoUrl: string,
		trimRegions: never[],
		speedRegions: never[],
		audioRegions: never[],
		sourceAudioFallbackPaths: string[],
		sourceAudioFallbackStartDelayMsByPath: Record<string, number> | undefined,
		muxer: unknown,
	): Promise<void>;
};

beforeEach(() => {
	audioEnhancementMocks.enhanceSourceAudioPathsForExport.mockClear();
	audioEnhancementMocks.enhanceSourceAudioPathsForExport.mockImplementation(
		async (input: { paths: string[]; startDelayMsByPath?: Record<string, number> }) => ({
			paths: input.paths,
			startDelayMsByPath: input.startDelayMsByPath ?? {},
		}),
	);
});

describe("AudioProcessor offline render preparation", () => {
	it("keeps embedded source audio separate from external companion sidecars", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		const mainBuffer = { duration: 10, numberOfChannels: 2 } as AudioBuffer;
		const micBuffer = { duration: 9.5, numberOfChannels: 1 } as AudioBuffer;

		const decodeAudioFromUrl = vi
			.spyOn(processor, "decodeAudioFromUrl")
			.mockImplementation(async (url: string) => {
				if (url === "file:///tmp/recording.mp4") {
					return mainBuffer;
				}
				if (url === "/tmp/recording.mic.wav") {
					return micBuffer;
				}
				return null;
			});
		vi.spyOn(processor, "getMediaDurationSec").mockResolvedValue(10);

		const prepared = await processor.prepareOfflineRender(
			"file:///tmp/recording.mp4",
			[],
			[],
			[],
			["/tmp/recording.mp4", "/tmp/recording.mic.wav"],
		);

		expect(prepared.mainBufferEntry?.buffer).toBe(mainBuffer);
		expect(prepared.companionEntries).toHaveLength(1);
		expect(prepared.companionEntries[0]?.buffer).toBe(micBuffer);
		expect(decodeAudioFromUrl).toHaveBeenCalledWith("file:///tmp/recording.mp4");
		expect(decodeAudioFromUrl).toHaveBeenCalledWith("/tmp/recording.mic.wav");
		expect(decodeAudioFromUrl).not.toHaveBeenCalledWith("/tmp/recording.mp4");
	});

	it("does not treat a single embedded fallback path as an external sidecar", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		const loadAudioFileDemuxer = vi.spyOn(processor, "loadAudioFileDemuxer");
		const renderAndMuxOfflineAudio = vi
			.spyOn(processor, "renderAndMuxOfflineAudio")
			.mockResolvedValue();

		await processor.process(
			null,
			{} as never,
			"file:///tmp/recording.mp4",
			[],
			[],
			undefined,
			[],
			["/tmp/recording.mp4"],
		);

		expect(loadAudioFileDemuxer).not.toHaveBeenCalled();
		expect(renderAndMuxOfflineAudio).not.toHaveBeenCalled();
	});

	it("uses recorded companion start-delay metadata instead of inferring from duration gap", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		const mainBuffer = { duration: 600, numberOfChannels: 2 } as AudioBuffer;
		const micBuffer = { duration: 565, numberOfChannels: 1 } as AudioBuffer;

		vi.spyOn(processor, "decodeAudioFromUrl").mockImplementation(async (url: string) => {
			if (url === "file:///tmp/recording.mp4") {
				return mainBuffer;
			}
			if (url === "/tmp/recording.mic.webm") {
				return micBuffer;
			}
			return null;
		});

		const prepared = await processor.prepareOfflineRender(
			"file:///tmp/recording.mp4",
			[],
			[],
			[],
			["/tmp/recording.mic.webm"],
			{ "/tmp/recording.mic.webm": 3_500 },
		);

		expect(prepared.companionEntries[0]?.startDelaySec).toBeCloseTo(3.5);
	});

	it("avoids the single-sidecar fast path when companion timing metadata is present", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		const loadAudioFileDemuxer = vi.spyOn(processor, "loadAudioFileDemuxer");
		const renderAndMuxOfflineAudio = vi
			.spyOn(processor, "renderAndMuxOfflineAudio")
			.mockResolvedValue();

		await processor.process(
			null,
			{} as never,
			"file:///tmp/recording.mp4",
			[],
			[],
			undefined,
			[],
			["/tmp/recording.mic.webm"],
			{ "/tmp/recording.mic.webm": 2_000 },
		);

		expect(loadAudioFileDemuxer).not.toHaveBeenCalled();
		expect(renderAndMuxOfflineAudio).toHaveBeenCalled();
	});

	it("uses enhanced source audio paths before offline export rendering", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		const renderAndMuxOfflineAudio = vi
			.spyOn(processor, "renderAndMuxOfflineAudio")
			.mockResolvedValue();
		audioEnhancementMocks.enhanceSourceAudioPathsForExport.mockResolvedValue({
			paths: ["/tmp/recording.mic.enhanced.wav"],
			startDelayMsByPath: { "/tmp/recording.mic.enhanced.wav": 2000 },
		});

		await processor.process(
			null,
			{} as never,
			"file:///tmp/recording.mp4",
			[],
			[],
			undefined,
			[],
			["/tmp/recording.mic.wav"],
			{ "/tmp/recording.mic.wav": 2000 },
			{
				mic: {
					volume: 1,
					normalize: false,
					reduceNoise: true,
					enhanceVoice: true,
					enhanceVoiceIntensity: 75,
				},
			},
		);

		expect(audioEnhancementMocks.enhanceSourceAudioPathsForExport).toHaveBeenCalledWith({
			paths: ["/tmp/recording.mic.wav"],
			startDelayMsByPath: { "/tmp/recording.mic.wav": 2000 },
			sourceAudioTrackSettings: expect.objectContaining({
				mic: expect.objectContaining({ reduceNoise: true }),
			}),
		});
		expect(renderAndMuxOfflineAudio).toHaveBeenCalledWith(
			"file:///tmp/recording.mp4",
			[],
			[],
			[],
			["/tmp/recording.mic.enhanced.wav"],
			{ "/tmp/recording.mic.enhanced.wav": 2000 },
			expect.any(Object),
			undefined,
			expect.any(Object),
		);
	});
});
