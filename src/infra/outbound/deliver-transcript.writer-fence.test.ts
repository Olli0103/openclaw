// Mirror fence tests cover which session's writer claim a delivery mirror carries.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { projectChatDisplayMessages } from "../../gateway/chat-display-projection.js";
import type { DeliverOutboundPayloadsCoreParams } from "./deliver-contracts.js";
import { mirrorDeliveredPayloads } from "./deliver-transcript.js";
import type { NormalizedOutboundPayload } from "./payloads.js";

const mocks = vi.hoisted(() => ({
  // Typed with the append params so the recorded call is inspectable without a cast.
  appendAssistantMessageToSessionTranscript: vi.fn(async (params: Record<string, unknown>) => {
    const onMessageCommitted = params.onMessageCommitted as
      | ((result: { appended: boolean; messageId: string; message: unknown }) => void)
      | undefined;
    onMessageCommitted?.({
      appended: true,
      messageId: "mirror-1",
      message: { openclawDisplayContent: params.displayContent },
    });
    return { ok: true, messageId: "mirror-1" } as const;
  }),
  createManagedOutgoingMediaBlocks: vi.fn(async () => [] as Array<Record<string, unknown>>),
  removeManagedOutgoingMediaBlocks: vi.fn(async () => undefined),
  attachManagedOutgoingMediaToMessage: vi.fn(() => true),
  getAgentScopedMediaLocalRootsForSources: vi.fn(() => ["/tmp"]),
  loadExactSessionEntry: vi.fn(() => undefined),
  resolveSessionEntrySelection: vi.fn((scope: { sessionKey: string }) => ({
    normalizedKey: scope.sessionKey,
  })),
  findTranscriptEvent: vi.fn(async () => null),
  readTranscriptEventId: vi.fn(() => undefined),
  readTranscriptEventMessage: vi.fn(() => undefined),
}));

vi.mock("../../config/sessions/transcript.runtime.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../config/sessions/transcript.runtime.js")
  >("../../config/sessions/transcript.runtime.js");
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
  };
});

vi.mock("../../gateway/managed-image-attachments.js", () => ({
  createManagedOutgoingMediaBlocks: mocks.createManagedOutgoingMediaBlocks,
  removeManagedOutgoingMediaBlocks: mocks.removeManagedOutgoingMediaBlocks,
  attachManagedOutgoingMediaToMessage: mocks.attachManagedOutgoingMediaToMessage,
}));

vi.mock("../../media/local-roots.js", () => ({
  getAgentScopedMediaLocalRootsForSources: mocks.getAgentScopedMediaLocalRootsForSources,
}));

vi.mock("../../config/sessions/session-accessor.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
    "../../config/sessions/session-accessor.js",
  );
  return {
    ...actual,
    loadExactSessionEntry: mocks.loadExactSessionEntry,
    resolveSessionEntrySelection: mocks.resolveSessionEntrySelection,
  };
});

vi.mock("../../config/sessions/session-accessor.sqlite-read.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../config/sessions/session-accessor.sqlite-read.js")
  >("../../config/sessions/session-accessor.sqlite-read.js");
  return {
    ...actual,
    findTranscriptEvent: mocks.findTranscriptEvent,
    readTranscriptEventId: mocks.readTranscriptEventId,
    readTranscriptEventMessage: mocks.readTranscriptEventMessage,
  };
});

const RUNNING_SESSION_KEY = "agent:wolf:discord:channel:1497965766035640391";
const OTHER_SESSION_KEY = "agent:arthur:discord:channel:1538510183024689305";

function payload(text: string): NormalizedOutboundPayload {
  return { text, mediaUrls: [] };
}

async function mirrorInto(sessionKey: string): Promise<void> {
  await mirrorDeliveredPayloads({
    delivery: {
      cfg: {},
      mirror: { agentId: "wolf", sessionKey },
    } as unknown as DeliverOutboundPayloadsCoreParams,
    payloads: [payload("delivered to the user")],
    channel: "discord",
    to: "1497965766035640391",
  });
}

/** Runs a mirror inside a run that owns `RUNNING_SESSION_KEY`, the way a live delivery does. */
async function withRunningSession(run: () => Promise<void>): Promise<void> {
  await withOwnedSessionTranscriptWrites(
    {
      sessionKey: RUNNING_SESSION_KEY,
      sessionTarget: {
        agentId: "wolf",
        sessionKey: RUNNING_SESSION_KEY,
        storePath: "/state/agents/wolf/openclaw-agent.sqlite",
        expectedLifecycleRevision: "rev-7",
        expectedWriterRunId: "run-running",
      },
      withTranscriptWrite: async (operation) => await operation(),
    },
    run,
  );
}

function appendedArgs() {
  return mocks.appendAssistantMessageToSessionTranscript.mock.calls[0]?.[0];
}

describe("outbound delivery mirror writer fence", () => {
  beforeEach(() => {
    mocks.appendAssistantMessageToSessionTranscript.mockClear();
    mocks.createManagedOutgoingMediaBlocks.mockClear();
    mocks.createManagedOutgoingMediaBlocks.mockResolvedValue([]);
    mocks.removeManagedOutgoingMediaBlocks.mockClear();
    mocks.attachManagedOutgoingMediaToMessage.mockClear();
    mocks.getAgentScopedMediaLocalRootsForSources.mockClear();
    mocks.loadExactSessionEntry.mockClear();
    mocks.loadExactSessionEntry.mockReturnValue(undefined);
    mocks.resolveSessionEntrySelection.mockClear();
    mocks.findTranscriptEvent.mockClear();
    mocks.findTranscriptEvent.mockResolvedValue(null);
    mocks.readTranscriptEventId.mockClear();
    mocks.readTranscriptEventMessage.mockClear();
  });

  it("carries the running run's fence when it mirrors into that run's own session", async () => {
    await withRunningSession(async () => {
      await mirrorInto(RUNNING_SESSION_KEY);
    });

    expect(appendedArgs()).toMatchObject({
      sessionKey: RUNNING_SESSION_KEY,
      expectedWriterRunId: "run-running",
      expectedLifecycleRevision: "rev-7",
    });
  });

  it("withholds that fence when it mirrors into a different session", async () => {
    await withRunningSession(async () => {
      await mirrorInto(OTHER_SESSION_KEY);
    });

    const args = appendedArgs();
    expect(args).toMatchObject({ sessionKey: OTHER_SESSION_KEY });
    // A claim about the delivering session is not a claim about this one. Passing it made
    // the transcript guards refuse the append as "session rebound", and the refusal is
    // warn-only after a successful channel send, so the mirror was lost for good.
    expect(args).not.toHaveProperty("expectedWriterRunId");
    expect(args).not.toHaveProperty("expectedLifecycleRevision");
  });

  it("mirrors unfenced when no run owns a transcript write", async () => {
    await mirrorInto(RUNNING_SESSION_KEY);

    const args = appendedArgs();
    expect(args).toMatchObject({ sessionKey: RUNNING_SESSION_KEY });
    expect(args).not.toHaveProperty("expectedWriterRunId");
  });

  it("forwards payload mediaUrls instead of baking filenames into the mirrored text", async () => {
    const mediaUrls = ["https://example.com/chart.png"];
    await mirrorDeliveredPayloads({
      delivery: {
        cfg: {},
        mirror: { agentId: "wolf", sessionKey: RUNNING_SESSION_KEY },
      } as unknown as DeliverOutboundPayloadsCoreParams,
      payloads: [{ text: "photo", mediaUrls }],
      channel: "discord",
      to: "1497965766035640391",
    });

    expect(appendedArgs()).toMatchObject({
      text: "photo",
      mediaUrls,
    });
  });

  it("forwards media-only payloads without synthesizing filename text", async () => {
    const mediaUrls = ["https://example.com/voice-note.ogg"];
    await mirrorDeliveredPayloads({
      delivery: {
        cfg: {},
        mirror: { agentId: "wolf", sessionKey: RUNNING_SESSION_KEY },
      } as unknown as DeliverOutboundPayloadsCoreParams,
      payloads: [{ text: "", mediaUrls }],
      channel: "discord",
      to: "1497965766035640391",
    });

    expect(appendedArgs()).toMatchObject({
      text: "",
      mediaUrls,
    });
  });

  it("persists managed display attachments so Control UI projection can render them", async () => {
    const mediaUrls = ["https://example.com/chart.png"];
    const imageBlock = {
      type: "image",
      source: { type: "url", url: "https://example.test/chart.png" },
    };
    mocks.createManagedOutgoingMediaBlocks.mockResolvedValueOnce([imageBlock]);

    await mirrorDeliveredPayloads({
      delivery: {
        cfg: {},
        mirror: { agentId: "wolf", sessionKey: RUNNING_SESSION_KEY },
      } as unknown as DeliverOutboundPayloadsCoreParams,
      payloads: [{ text: "photo", mediaUrls }],
      channel: "discord",
      to: "1497965766035640391",
    });

    const args = appendedArgs();
    expect(args).toMatchObject({
      text: "photo",
      mediaUrls,
      displayContent: [{ type: "text", text: "photo" }, imageBlock],
    });
    expect(mocks.attachManagedOutgoingMediaToMessage).toHaveBeenCalledWith({
      messageId: "mirror-1",
      blocks: [imageBlock],
    });

    const displayed = projectChatDisplayMessages([
      {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: [{ type: "text", text: "photo" }],
        openclawDisplayContent: args?.displayContent,
        openclawDeliveryMirror: { kind: "channel-final" },
      },
    ]);
    expect(displayed).toHaveLength(1);
    expect(displayed[0]).toMatchObject({
      content: expect.arrayContaining([imageBlock]),
    });
  });

  it("keeps committed attachments when transcript append later reports not-ok", async () => {
    const mediaUrls = ["https://example.com/chart.png"];
    const imageBlock = {
      type: "image",
      source: { type: "url", url: "https://example.test/chart.png" },
    };
    mocks.createManagedOutgoingMediaBlocks.mockResolvedValueOnce([imageBlock]);
    mocks.appendAssistantMessageToSessionTranscript.mockImplementationOnce(async (params) => {
      const onMessageCommitted = params.onMessageCommitted as
        | ((result: { appended: boolean; messageId: string; message: unknown }) => void)
        | undefined;
      onMessageCommitted?.({
        appended: true,
        messageId: "mirror-1",
        message: { openclawDisplayContent: params.displayContent },
      });
      return { ok: false, reason: "session entry touch failed" } as const;
    });

    await mirrorDeliveredPayloads({
      delivery: {
        cfg: {},
        mirror: { agentId: "wolf", sessionKey: RUNNING_SESSION_KEY },
      } as unknown as DeliverOutboundPayloadsCoreParams,
      payloads: [{ text: "photo", mediaUrls }],
      channel: "discord",
      to: "1497965766035640391",
    });

    expect(mocks.attachManagedOutgoingMediaToMessage).toHaveBeenCalledWith({
      messageId: "mirror-1",
      blocks: [imageBlock],
    });
    expect(mocks.removeManagedOutgoingMediaBlocks).not.toHaveBeenCalled();
  });

  it("reuses committed attachments for a keyed delivery mirror replay", async () => {
    const imageBlock = {
      type: "image",
      source: { type: "url", url: "https://example.test/chart.png" },
    };
    const existing = {
      role: "assistant",
      provider: "openclaw",
      model: "delivery-mirror",
      idempotencyKey: "idem-1",
      openclawDisplayContent: [{ type: "text", text: "photo" }, imageBlock],
    };
    mocks.findTranscriptEvent.mockResolvedValueOnce({ event: { message: existing } });
    mocks.readTranscriptEventId.mockReturnValue("mirror-existing");
    mocks.readTranscriptEventMessage.mockReturnValue(existing);

    await mirrorDeliveredPayloads({
      delivery: {
        cfg: {},
        mirror: {
          agentId: "wolf",
          sessionKey: RUNNING_SESSION_KEY,
          expectedSessionId: "sess-1",
          idempotencyKey: "idem-1",
        },
      } as unknown as DeliverOutboundPayloadsCoreParams,
      payloads: [{ text: "photo", mediaUrls: ["https://example.com/chart.png"] }],
      channel: "discord",
      to: "1497965766035640391",
    });

    expect(mocks.createManagedOutgoingMediaBlocks).not.toHaveBeenCalled();
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    expect(mocks.attachManagedOutgoingMediaToMessage).toHaveBeenCalledWith({
      messageId: "mirror-existing",
      blocks: [imageBlock],
    });
  });
});
