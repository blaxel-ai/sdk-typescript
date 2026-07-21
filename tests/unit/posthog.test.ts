import { describe, expect, it, vi } from "vitest";
import { createSDKInstallTracker } from "../../@blaxel/core/src/common/posthog.js";

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
