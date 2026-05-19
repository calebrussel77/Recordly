import {
	DEFAULT_WEBCAM_SMART_BACKGROUND_COLOR,
	DEFAULT_WEBCAM_SMART_BACKGROUND_PRESET_ID,
	type WebcamSmartBackgroundPresetId,
} from "./types";

export type WebcamSmartBackgroundCategoryId = "solid" | "studio" | "gradient" | "bokeh" | "scene";

export type WebcamSmartBackgroundPresetKind = "color" | "gradient" | "bokeh" | "image";

export type WebcamSmartBackgroundGradientStop = {
	offset: number;
	color: string;
};

export type WebcamSmartBackgroundPreset = {
	id: WebcamSmartBackgroundPresetId;
	label: string;
	categoryId: WebcamSmartBackgroundCategoryId;
	kind: WebcamSmartBackgroundPresetKind;
	color?: string;
	fallbackColor: string;
	gradient?: WebcamSmartBackgroundGradientStop[];
	assetPath?: string;
	previewCss: string;
};

export const WEBCAM_SMART_BACKGROUND_CATEGORIES: Array<{
	id: WebcamSmartBackgroundCategoryId;
	label: string;
}> = [
	{ id: "solid", label: "Solids" },
	{ id: "studio", label: "Studio" },
	{ id: "gradient", label: "Gradient" },
	{ id: "bokeh", label: "Bokeh" },
	{ id: "scene", label: "Scenes" },
];

export const WEBCAM_SMART_BACKGROUND_PRESETS: WebcamSmartBackgroundPreset[] = [
	{
		id: "solid-midnight",
		label: "Midnight",
		categoryId: "solid",
		kind: "color",
		color: "#111827",
		fallbackColor: "#111827",
		previewCss: "#111827",
	},
	{
		id: "solid-blue",
		label: "Blue",
		categoryId: "solid",
		kind: "color",
		color: "#2563EB",
		fallbackColor: "#2563EB",
		previewCss: "#2563EB",
	},
	{
		id: "solid-teal",
		label: "Teal",
		categoryId: "solid",
		kind: "color",
		color: "#0F766E",
		fallbackColor: "#0F766E",
		previewCss: "#0F766E",
	},
	{
		id: "solid-rose",
		label: "Rose",
		categoryId: "solid",
		kind: "color",
		color: "#E11D48",
		fallbackColor: "#E11D48",
		previewCss: "#E11D48",
	},
	{
		id: "studio-charcoal",
		label: "Charcoal",
		categoryId: "studio",
		kind: "gradient",
		fallbackColor: "#1F2937",
		gradient: [
			{ offset: 0, color: "#4B5563" },
			{ offset: 0.48, color: "#1F2937" },
			{ offset: 1, color: "#030712" },
		],
		previewCss: "radial-gradient(circle at 50% 18%, #6B7280 0%, #1F2937 45%, #030712 100%)",
	},
	{
		id: "studio-ivory",
		label: "Ivory",
		categoryId: "studio",
		kind: "gradient",
		fallbackColor: "#E7DFD2",
		gradient: [
			{ offset: 0, color: "#FFFFFF" },
			{ offset: 0.5, color: "#E7DFD2" },
			{ offset: 1, color: "#A89F91" },
		],
		previewCss: "radial-gradient(circle at 50% 22%, #FFFFFF 0%, #E7DFD2 52%, #A89F91 100%)",
	},
	{
		id: "studio-sky",
		label: "Sky",
		categoryId: "studio",
		kind: "gradient",
		fallbackColor: "#C7D2FE",
		gradient: [
			{ offset: 0, color: "#F8FAFC" },
			{ offset: 0.5, color: "#C7D2FE" },
			{ offset: 1, color: "#334155" },
		],
		previewCss: "radial-gradient(circle at 50% 20%, #F8FAFC 0%, #C7D2FE 52%, #334155 100%)",
	},
	{
		id: "gradient-aurora",
		label: "Aurora",
		categoryId: "gradient",
		kind: "gradient",
		fallbackColor: DEFAULT_WEBCAM_SMART_BACKGROUND_COLOR,
		gradient: [
			{ offset: 0, color: "#0EA5E9" },
			{ offset: 0.45, color: "#8B5CF6" },
			{ offset: 0.72, color: "#EC4899" },
			{ offset: 1, color: "#0F172A" },
		],
		previewCss: "linear-gradient(135deg, #0EA5E9 0%, #8B5CF6 45%, #EC4899 72%, #0F172A 100%)",
	},
	{
		id: "gradient-sunset",
		label: "Sunset",
		categoryId: "gradient",
		kind: "gradient",
		fallbackColor: "#F97316",
		gradient: [
			{ offset: 0, color: "#FDE68A" },
			{ offset: 0.36, color: "#FB7185" },
			{ offset: 0.72, color: "#7C3AED" },
			{ offset: 1, color: "#111827" },
		],
		previewCss: "linear-gradient(135deg, #FDE68A 0%, #FB7185 36%, #7C3AED 72%, #111827 100%)",
	},
	{
		id: "gradient-mint",
		label: "Mint",
		categoryId: "gradient",
		kind: "gradient",
		fallbackColor: "#14B8A6",
		gradient: [
			{ offset: 0, color: "#A7F3D0" },
			{ offset: 0.42, color: "#22D3EE" },
			{ offset: 1, color: "#0F172A" },
		],
		previewCss: "linear-gradient(135deg, #A7F3D0 0%, #22D3EE 42%, #0F172A 100%)",
	},
	{
		id: "bokeh-warm",
		label: "Warm lights",
		categoryId: "bokeh",
		kind: "bokeh",
		fallbackColor: "#B45309",
		gradient: [
			{ offset: 0, color: "#F9A8D4" },
			{ offset: 0.48, color: "#FDE68A" },
			{ offset: 1, color: "#7C2D12" },
		],
		previewCss:
			"radial-gradient(circle at 26% 24%, rgba(255,255,255,.9), transparent 14%), radial-gradient(circle at 70% 30%, rgba(253,186,116,.85), transparent 16%), linear-gradient(135deg, #F9A8D4, #FDE68A 48%, #7C2D12)",
	},
	{
		id: "bokeh-cool",
		label: "Cool lights",
		categoryId: "bokeh",
		kind: "bokeh",
		fallbackColor: "#1D4ED8",
		gradient: [
			{ offset: 0, color: "#0F172A" },
			{ offset: 0.5, color: "#2563EB" },
			{ offset: 1, color: "#A78BFA" },
		],
		previewCss:
			"radial-gradient(circle at 30% 26%, rgba(255,255,255,.88), transparent 14%), radial-gradient(circle at 72% 38%, rgba(125,211,252,.78), transparent 18%), linear-gradient(135deg, #0F172A, #2563EB 50%, #A78BFA)",
	},
	{
		id: "bokeh-blush",
		label: "Blush lights",
		categoryId: "bokeh",
		kind: "bokeh",
		fallbackColor: "#BE185D",
		gradient: [
			{ offset: 0, color: "#BE185D" },
			{ offset: 0.55, color: "#FBCFE8" },
			{ offset: 1, color: "#312E81" },
		],
		previewCss:
			"radial-gradient(circle at 24% 32%, rgba(255,255,255,.85), transparent 13%), radial-gradient(circle at 68% 24%, rgba(251,207,232,.85), transparent 18%), linear-gradient(135deg, #BE185D, #FBCFE8 55%, #312E81)",
	},
	{
		id: "scene-glass",
		label: "Glass",
		categoryId: "scene",
		kind: "image",
		assetPath: "/wallpapers/glassmorphism-4.jpg",
		fallbackColor: "#475569",
		previewCss: "url('/wallpapers/glassmorphism-4.jpg')",
	},
	{
		id: "scene-iridescent",
		label: "Iridescent",
		categoryId: "scene",
		kind: "image",
		assetPath: "/wallpapers/iridescent-9.jpg",
		fallbackColor: "#7C3AED",
		previewCss: "url('/wallpapers/iridescent-9.jpg')",
	},
	{
		id: "scene-city",
		label: "City",
		categoryId: "scene",
		kind: "image",
		assetPath: "/wallpapers/cityscape.jpg",
		fallbackColor: "#1E293B",
		previewCss: "url('/wallpapers/cityscape.jpg')",
	},
	{
		id: "scene-clouds",
		label: "Clouds",
		categoryId: "scene",
		kind: "image",
		assetPath: "/wallpapers/sonoma-clouds.jpg",
		fallbackColor: "#64748B",
		previewCss: "url('/wallpapers/sonoma-clouds.jpg')",
	},
];

const WEBCAM_SMART_BACKGROUND_PRESET_BY_ID = new Map(
	WEBCAM_SMART_BACKGROUND_PRESETS.map((preset) => [preset.id, preset]),
);

export function getWebcamSmartBackgroundPreset(
	presetId?: string | null,
): WebcamSmartBackgroundPreset {
	return (
		(presetId ? WEBCAM_SMART_BACKGROUND_PRESET_BY_ID.get(presetId) : null) ??
		WEBCAM_SMART_BACKGROUND_PRESET_BY_ID.get(DEFAULT_WEBCAM_SMART_BACKGROUND_PRESET_ID) ??
		WEBCAM_SMART_BACKGROUND_PRESETS[0]!
	);
}

export function isWebcamSmartBackgroundPresetId(
	value: unknown,
): value is WebcamSmartBackgroundPresetId {
	return typeof value === "string" && WEBCAM_SMART_BACKGROUND_PRESET_BY_ID.has(value);
}
