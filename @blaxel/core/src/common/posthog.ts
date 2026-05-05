import { fs, os, path } from "../common/node.js";
import { settings } from "./settings.js";

// PostHog API key injected at build time via build:replace-imports
const BUILD_POSTHOG_KEY = "__BUILD_POSTHOG_KEY__";

// PostHog API endpoint
const POSTHOG_HOST = "https://us.i.posthog.com";

// Telemetry state file path: ~/.blaxel/telemetry.json
type TelemetryState = {
	distinct_id: string;
	cli?: string;
	sdks?: Record<string, string>;
};

let telemetryState: TelemetryState | null = null;

/**
 * Get the PostHog API key (injected at build time).
 */
function getPosthogKey(): string {
	const key = BUILD_POSTHOG_KEY;
	// If the placeholder was not replaced, treat as empty
	if (!key || key === "__BUILD_POSTHOG_KEY__") {
		return "";
	}
	return key;
}

/**
 * Get the telemetry file path.
 */
function getTelemetryPath(): string | null {
	if (os === null || path === null) {
		return null;
	}
	try {
		return path.join(os.homedir(), ".blaxel", "telemetry.json");
	} catch {
		return null;
	}
}

/**
 * Load telemetry state from disk.
 */
function loadTelemetryState(): TelemetryState {
	if (telemetryState !== null) {
		return telemetryState;
	}

	telemetryState = { distinct_id: "", sdks: {} };

	if (fs === null) {
		return telemetryState;
	}

	const telemetryPath = getTelemetryPath();
	if (!telemetryPath) {
		return telemetryState;
	}

	try {
		const data = fs.readFileSync(telemetryPath, "utf8");
		const parsed = JSON.parse(data) as TelemetryState;
		telemetryState = {
			distinct_id: parsed.distinct_id || "",
			cli: parsed.cli,
			sdks: parsed.sdks || {},
		};
	} catch {
		// File doesn't exist or is invalid - use defaults
	}

	return telemetryState;
}

/**
 * Save telemetry state to disk.
 */
function saveTelemetryState(state: TelemetryState): void {
	if (fs === null || path === null || os === null) {
		return;
	}

	const telemetryPath = getTelemetryPath();
	if (!telemetryPath) {
		return;
	}

	try {
		const dir = path.dirname(telemetryPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(telemetryPath, JSON.stringify(state, null, 2), {
			mode: 0o600,
		});
	} catch {
		// Silently fail
	}
}

/**
 * Generate a UUID v4 without external dependencies.
 */
function generateUUID(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
	const hex = Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Get or create a persistent distinct ID for PostHog events.
 */
function getDistinctID(): string {
	const state = loadTelemetryState();
	if (state.distinct_id) {
		return state.distinct_id;
	}
	state.distinct_id = generateUUID();
	saveTelemetryState(state);
	return state.distinct_id;
}

/**
 * Send an event to PostHog via HTTP POST. Fire-and-forget.
 */
function capturePosthogEvent(
	event: string,
	properties: Record<string, string>,
): void {
	const apiKey = getPosthogKey();
	if (!apiKey) {
		return;
	}

	const distinctId = getDistinctID();

	const payload = {
		api_key: apiKey,
		event,
		distinct_id: distinctId,
		timestamp: new Date().toISOString(),
		properties,
	};

	try {
		fetch(`${POSTHOG_HOST}/capture/`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(5000),
		}).catch(() => {
			// Silently fail - telemetry should never break the SDK
		});
	} catch {
		// Silently fail
	}
}

/**
 * Track SDK installation. Fires "Installed SDK" once per new version.
 * Called during SDK autoload.
 */
export function trackSDKInstalled(): void {
	const apiKey = getPosthogKey();
	if (!apiKey) {
		return;
	}

	// Only track if tracking is enabled
	if (!settings.tracking) {
		return;
	}

	const sdkVersion = settings.version;
	if (
		!sdkVersion ||
		sdkVersion === "unknown" ||
		sdkVersion === "__BUILD_VERSION__"
	) {
		return;
	}

	// Only run in Node.js (not in browsers)
	if (typeof process === "undefined" || !process.versions?.node) {
		return;
	}

	const state = loadTelemetryState();
	const sdkName = "typescript";

	if (state.sdks && state.sdks[sdkName] === sdkVersion) {
		return; // Already tracked this version
	}

	capturePosthogEvent("Installed SDK", {
		version: sdkVersion,
		language: sdkName,
	});

	if (!state.sdks) {
		state.sdks = {};
	}
	state.sdks[sdkName] = sdkVersion;
	saveTelemetryState(state);
}
