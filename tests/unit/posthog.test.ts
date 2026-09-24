import { describe, expect, it, vi } from "vitest";
import {
	POSTHOG_FLUSH_BUDGET_MS,
	createSDKInstallTracker,
	mergeTelemetryState,
} from "../../@blaxel/core/src/common/posthog.js";

type TestState = {
	distinct_id: string;
	sdks?: Record<string, string>;
};

function createTracker(
	fetch: typeof globalThis.fetch,
	state: TestState = { distinct_id: "test-distinct-id", sdks: {} },
) {
	const saveState = vi.fn();
	const track = createSDKInstallTracker({
		getApiKey: () => "test-api-key",
		isTrackingEnabled: () => true,
		getVersion: () => "1.2.3",
		isNode: () => true,
		loadState: () => state,
		saveState,
		getDistinctId: () => state.distinct_id,
		fetch,
		getSignal: () => undefined,
	});

	return { state, saveState, track };
}

describe("Installed SDK telemetry", () => {
	it("sends the ENG-2277 payload schema", async () => {
		const fetch = vi.fn<Parameters<typeof globalThis.fetch>, ReturnType<typeof globalThis.fetch>>().mockResolvedValue(
			new Response(null, { status: 200 }),
		);
		const { track } = createTracker(fetch);

		await track();

		expect(fetch).toHaveBeenCalledOnce();
		const [, request] = fetch.mock.calls[0];
		const payload: unknown = JSON.parse(String(request?.body));
		expect(payload).toMatchObject({
			event: "Installed SDK",
			properties: {
				language: "typescript",
				sdk: "core",
				version: "1.2.3",
			},
		});
	});

	it("does not persist failed delivery and retries on the next call", async () => {
		const fetch = vi
			.fn<Parameters<typeof globalThis.fetch>, ReturnType<typeof globalThis.fetch>>()
			.mockResolvedValueOnce(new Response(null, { status: 503 }))
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		const { saveState, state, track } = createTracker(fetch);

		await track();
		expect(state.sdks?.typescript).toBeUndefined();
		expect(saveState).not.toHaveBeenCalled();

		await track();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(state.sdks?.typescript).toBe("1.2.3");
		expect(saveState).toHaveBeenCalledOnce();
	});

	it("deduplicates pending and successfully delivered versions", async () => {
		let resolveDelivery: ((response: Response) => void) | undefined;
		const delivery = new Promise<Response>((resolve) => {
			resolveDelivery = resolve;
		});
		const fetch = vi
			.fn<Parameters<typeof globalThis.fetch>, ReturnType<typeof globalThis.fetch>>()
			.mockReturnValue(delivery);
		const { saveState, track } = createTracker(fetch);

		const firstDelivery = track();
		expect(track()).toBeUndefined();
		expect(fetch).toHaveBeenCalledOnce();

		resolveDelivery?.(new Response(null, { status: 200 }));
		await firstDelivery;
		expect(track()).toBeUndefined();
		expect(fetch).toHaveBeenCalledOnce();
		expect(saveState).toHaveBeenCalledOnce();
	});
});

describe("telemetry delivery budget", () => {
	it("keeps a stalled send from holding the process open", () => {
		// Node keeps the event loop alive while a fetch is outstanding, so this
		// ceiling is what a short-lived script waits for when the endpoint accepts
		// the connection and never answers. A capture against us.i.posthog.com
		// takes ~250-350ms end to end, so a second leaves ample headroom.
		expect(POSTHOG_FLUSH_BUDGET_MS).toBeLessThanOrEqual(1000);
	});
});

describe("shared telemetry.json merging", () => {
	// The CLI and both SDKs share this file and each caches it in memory for the
	// lifetime of its process. Writing a stale snapshot back wholesale rolls back
	// whatever another process recorded, which makes that process re-send its
	// "Installed" event on every later run.
	it("keeps fields written by another process after this one loaded", () => {
		const ours = { distinct_id: "shared-id", sdks: { typescript: "1.2.3" } };
		const onDisk = {
			distinct_id: "shared-id",
			cli: "9.9.9",
			sdks: { python: "2.0.0" },
			future_field: true,
		};

		const merged = mergeTelemetryState(onDisk, ours) as Record<string, unknown>;

		expect(merged.cli).toBe("9.9.9");
		expect(merged.future_field).toBe(true);
		expect(merged.sdks).toEqual({ python: "2.0.0", typescript: "1.2.3" });
		expect(merged.distinct_id).toBe("shared-id");
	});

	it("still writes this process's own entry when the file is absent", () => {
		const ours = { distinct_id: "fresh-id", sdks: { typescript: "1.2.3" } };

		const merged = mergeTelemetryState({}, ours) as Record<string, unknown>;

		expect(merged.distinct_id).toBe("fresh-id");
		expect(merged.sdks).toEqual({ typescript: "1.2.3" });
	});
});
