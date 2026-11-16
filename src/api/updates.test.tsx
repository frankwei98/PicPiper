import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { bridgeCall } = vi.hoisted(() => ({ bridgeCall: vi.fn() }));
vi.mock("mygo-runtime", () => ({ isMyGo: () => true }));
vi.mock("../mygo", () => ({ Backend: { call: bridgeCall }, events: {} }));
import { beginUpdateActivity, useUpdateActivity } from "./updates";

const payloads = () => bridgeCall.mock.calls.map((args) => JSON.parse(args[1] as string) as { busy: boolean; id?: string });

describe("update activity leases", () => {
  beforeEach(() => { vi.useFakeTimers(); bridgeCall.mockReset(); bridgeCall.mockResolvedValue('{"data":null}'); });
  afterEach(() => vi.useRealTimers());

  it("renews gallery leases and stops heartbeats after release", async () => {
    const release = await beginUpdateActivity("gallery");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(payloads().filter((item) => item.busy)).toHaveLength(2);
    await release();
    const count = bridgeCall.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bridgeCall).toHaveBeenCalledTimes(count);
    expect(payloads().slice(-1)[0]?.busy).toBe(false);
  });

  it("finishes an in-flight heartbeat before releasing a gallery lease", async () => {
    let finishHeartbeat: ((reply: string) => void) | undefined;
    bridgeCall.mockResolvedValueOnce('{"data":null}').mockImplementationOnce(() => new Promise<string>((resolve) => { finishHeartbeat = resolve; }));
    const release = await beginUpdateActivity("gallery");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(finishHeartbeat).toBeDefined();
    const released = release();
    expect(payloads().slice(-1)[0]?.busy).toBe(true);
    finishHeartbeat?.('{"data":null}');
    await released;
    expect(payloads().slice(-1)[0]?.busy).toBe(false);
  });

  it("renews active optimization and clears its lease on unmount", async () => {
    const hook = renderHook(() => useUpdateActivity("optimize", true));
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(payloads().filter((item) => item.busy)).toHaveLength(2);
    hook.unmount();
    await vi.advanceTimersByTimeAsync(0);
    expect(payloads().slice(-1)[0]?.busy).toBe(false);
    const count = bridgeCall.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bridgeCall).toHaveBeenCalledTimes(count);
  });
});
