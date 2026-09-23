// Mirrors successful outbound payloads into the configured session transcript.
import { resolveMirroredTranscriptText } from "../../config/sessions/transcript-mirror.js";
import { getOwnedSessionTranscriptWriterFence } from "../../config/sessions/transcript-write-context.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { formatErrorMessage } from "../errors.js";
import type { DeliverOutboundPayloadsCoreParams } from "./deliver-contracts.js";
import { resolveOutboundPayloadMirrorText, type NormalizedOutboundPayload } from "./payloads.js";

const log = createSubsystemLogger("outbound/deliver");
const loadTranscriptRuntime = createLazyRuntimeModule(
  () => import("../../config/sessions/transcript.runtime.js"),
);
const loadManagedAttachments = createLazyRuntimeModule(
  () => import("../../gateway/managed-image-attachments.js"),
);
const loadMediaLocalRoots = createLazyRuntimeModule(() => import("../../media/local-roots.js"));
const loadSessionPaths = createLazyRuntimeModule(() => import("../../config/sessions/paths.js"));
const loadSessionAccessor = createLazyRuntimeModule(
  () => import("../../config/sessions/session-accessor.js"),
);
const loadSessionSqliteRead = createLazyRuntimeModule(
  () => import("../../config/sessions/session-accessor.sqlite-read.js"),
);
const loadAssistantDisplayContent = createLazyRuntimeModule(
  () => import("../../shared/assistant-display-content.js"),
);
const loadDeliveryMirrorPredicate = createLazyRuntimeModule(
  () => import("../../shared/transcript-only-openclaw-assistant.js"),
);

async function reusePersistedDeliveryMirror(params: {
  cfg: DeliverOutboundPayloadsCoreParams["cfg"];
  agentId?: string;
  sessionKey: string;
  expectedSessionId?: string;
  idempotencyKey: string;
}): Promise<boolean> {
  try {
    const { resolveSessionStorePathCore } = await loadSessionPaths();
    const { loadExactSessionEntry, resolveSessionEntrySelection } = await loadSessionAccessor();
    const { findTranscriptEvent, readTranscriptEventId, readTranscriptEventMessage } =
      await loadSessionSqliteRead();
    const { isOpenClawDeliveryMirrorAssistantMessage } = await loadDeliveryMirrorPredicate();
    const { attachManagedOutgoingMediaToMessage } = await loadManagedAttachments();
    const { readAssistantDisplayContent } = await loadAssistantDisplayContent();
    const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
      agentId: params.agentId,
    });
    const scope = {
      agentId: params.agentId,
      sessionId: params.expectedSessionId,
      sessionKey: params.sessionKey,
      storePath,
    };
    scope.sessionKey = resolveSessionEntrySelection(scope).normalizedKey;
    const sessionId = params.expectedSessionId ?? loadExactSessionEntry(scope)?.sessionId;
    if (!sessionId) {
      return false;
    }
    const found = await findTranscriptEvent({ ...scope, sessionId }, (event) => {
      const message = readTranscriptEventMessage(event);
      return (
        message?.idempotencyKey === params.idempotencyKey &&
        isOpenClawDeliveryMirrorAssistantMessage(message)
      );
    });
    if (!found) {
      return false;
    }
    const messageId = readTranscriptEventId(found.event);
    const message = readTranscriptEventMessage(found.event);
    if (!messageId || !message) {
      return false;
    }
    const blocks = readAssistantDisplayContent(message).filter((block) => block.type !== "text");
    if (blocks.length > 0) {
      attachManagedOutgoingMediaToMessage({ messageId, blocks });
    }
    return true;
  } catch {
    return false;
  }
}

export async function mirrorDeliveredPayloads(params: {
  delivery: DeliverOutboundPayloadsCoreParams;
  payloads: readonly NormalizedOutboundPayload[];
  channel: string;
  to: string;
}): Promise<void> {
  const mirror = params.delivery.mirror;
  if (!mirror || params.payloads.length === 0) {
    return;
  }
  const deliveredMirror = {
    text: params.payloads
      .map((payload) => payload.hookContent ?? resolveOutboundPayloadMirrorText(payload))
      .filter((text) => text.trim())
      .join("\n"),
    mediaUrls: params.payloads.flatMap((payload) => payload.mediaUrls),
  };
  const mirrorText = resolveMirroredTranscriptText({
    text: deliveredMirror.text,
    mediaUrls: deliveredMirror.mediaUrls,
  });
  if (!mirrorText) {
    return;
  }
  // Transcript mirroring is best-effort bookkeeping after platform send.
  // Keep mirror failures non-fatal so callers do not retry an already-sent payload.
  let mediaBlocks: Array<Record<string, unknown>> = [];
  let committed = false;
  try {
    if (mirror.idempotencyKey) {
      const reused = await reusePersistedDeliveryMirror({
        cfg: params.delivery.cfg,
        agentId: mirror.agentId,
        sessionKey: mirror.sessionKey,
        expectedSessionId: mirror.expectedSessionId,
        idempotencyKey: mirror.idempotencyKey,
      });
      if (reused) {
        return;
      }
    }
    const { appendAssistantMessageToSessionTranscript } = await loadTranscriptRuntime();
    const { attachManagedOutgoingMediaToMessage } = await loadManagedAttachments();
    const { readAssistantDisplayContent } = await loadAssistantDisplayContent();
    const mediaUrls = deliveredMirror.mediaUrls.filter((url) => url.trim());
    if (mediaUrls.length > 0) {
      try {
        const { createManagedOutgoingMediaBlocks } = await loadManagedAttachments();
        const { getAgentScopedMediaLocalRootsForSources } = await loadMediaLocalRoots();
        mediaBlocks = await createManagedOutgoingMediaBlocks({
          sessionKey: mirror.sessionKey,
          agentId: mirror.agentId,
          items: mediaUrls.map((url) => ({ url, trustedLocal: false })),
          localRoots: getAgentScopedMediaLocalRootsForSources({
            cfg: params.delivery.cfg,
            agentId: mirror.agentId,
            mediaSources: mediaUrls,
          }),
          continueOnPrepareError: true,
        });
      } catch (err) {
        log.warn(
          `failed to materialize outbound delivery media for Control UI; channel send already succeeded: ${formatErrorMessage(err)}`,
          { channel: params.channel, to: params.to, sessionKey: mirror.sessionKey },
        );
      }
    }
    const displayContent = [
      ...(deliveredMirror.text.trim()
        ? [{ type: "text" as const, text: deliveredMirror.text }]
        : []),
      ...mediaBlocks,
    ];
    // Fence against the session this mirror lands in, not whichever run is delivering:
    // a cross-session delivery would otherwise carry the sending run's writer claim.
    const writerFence = getOwnedSessionTranscriptWriterFence({ sessionKey: mirror.sessionKey });
    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      agentId: mirror.agentId,
      sessionKey: mirror.sessionKey,
      expectedSessionId: mirror.expectedSessionId,
      ...(writerFence?.expectedLifecycleRevision !== undefined
        ? { expectedLifecycleRevision: writerFence.expectedLifecycleRevision }
        : {}),
      ...(writerFence ? { expectedWriterRunId: writerFence.expectedWriterRunId } : {}),
      text: deliveredMirror.text,
      mediaUrls: mediaUrls.length ? mediaUrls : undefined,
      ...(mediaBlocks.length > 0 ? { displayContent } : {}),
      idempotencyKey: mirror.idempotencyKey,
      deliveryMirror: mirror.deliveryMirror,
      config: params.delivery.cfg,
      onMessageCommitted: (result) => {
        // Publication can fail after commit; cleanup must never delete owned media.
        committed = result.appended;
        if (!result.appended) {
          return;
        }
        const committedBlocks = readAssistantDisplayContent(result.message).filter(
          (block) => block.type !== "text",
        );
        const blocks = committedBlocks.length > 0 ? committedBlocks : mediaBlocks;
        if (blocks.length > 0) {
          attachManagedOutgoingMediaToMessage({
            messageId: result.messageId,
            blocks,
          });
        }
      },
    });
    if (!mirrorResult.ok) {
      log.warn(
        `failed to mirror outbound delivery into session transcript; channel send already succeeded: ${mirrorResult.reason}`,
        { channel: params.channel, to: params.to, sessionKey: mirror.sessionKey },
      );
    }
  } catch (err) {
    log.warn(
      `failed to mirror outbound delivery into session transcript; channel send already succeeded: ${formatErrorMessage(err)}`,
      { channel: params.channel, to: params.to, sessionKey: mirror.sessionKey },
    );
  } finally {
    if (!committed && mediaBlocks.length > 0) {
      try {
        const { removeManagedOutgoingMediaBlocks } = await loadManagedAttachments();
        await removeManagedOutgoingMediaBlocks({ blocks: mediaBlocks, messageId: null });
      } catch (err) {
        log.warn(
          `failed to clean up uncommitted outbound delivery media: ${formatErrorMessage(err)}`,
          { channel: params.channel, to: params.to, sessionKey: mirror.sessionKey },
        );
      }
    }
  }
}
