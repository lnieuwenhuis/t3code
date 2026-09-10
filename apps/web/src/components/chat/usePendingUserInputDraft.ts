import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import {
  setPendingUserInputCustomAnswer,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import {
  collectPendingUserInputCustomAnswers,
  type PendingUserInputRequestSnapshot,
  resolveComposerDraftPromptAfterReturningPendingAnswer,
  resolveComposerDraftToCarryIntoPendingUserInput,
  shouldRescueCancelledPendingUserInput,
  pendingUserInputRequestKey,
} from "../ChatView.logic";

type AnswersByRequest = Record<string, Record<string, PendingUserInputDraftAnswer>>;

/** Keeps persisted composer text through question transitions, navigation and failed responses. */
export function usePendingUserInputDraft({
  composerDraftTarget,
  activePendingUserInput,
  pendingUserInputAnswersByRequestId,
  setPendingUserInputAnswersByRequestId,
}: {
  composerDraftTarget: ScopedThreadRef | DraftId;
  activePendingUserInput: {
    requestId: string;
    questions: ReadonlyArray<{ id: string; allowCustomAnswer?: boolean | undefined }>;
  } | null;
  pendingUserInputAnswersByRequestId: AnswersByRequest;
  setPendingUserInputAnswersByRequestId: Dispatch<SetStateAction<AnswersByRequest>>;
}) {
  const composerDraftTargetRef = useRef(composerDraftTarget);
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const activePendingRequestKey = pendingUserInputRequestKey(
    composerDraftTarget,
    activePendingUserInput?.requestId ?? null,
  );
  // The pending question seen on the previous render; see the rescue effect
  // below.
  const prevPendingUserInputRef = useRef<PendingUserInputRequestSnapshot<
    ScopedThreadRef | DraftId
  > | null>(null);
  // Request ids with an answer submitted via onRespondToUserInput. A submitted
  // question also disappears from pendingUserInputs, but that's the answer
  // being sent, not the question being cancelled, so the effect below must
  // not rescue its text. Unmarked when the submit fails.
  const submittedPendingUserInputRequestIdsRef = useRef<Set<string>>(new Set());
  // Draft text carried into a request's first question when the question
  // appeared. Answer state is in-memory, so the draft store keeps that text
  // as the persisted copy until the answer is sent; the copy counts as blank
  // when text returns to the draft so it is never merged with itself.
  const carriedComposerDraftByRequestIdRef = useRef(
    new Map<string, { draftTarget: ScopedThreadRef | DraftId; text: string }>(),
  );
  // Text typed in the composer is never dropped: it is sent, or it stays in
  // the draft. Appends text that is leaving a request's answer slot unsent to
  // the thread's composer draft, replacing the persisted copy of text that
  // was carried in from the draft.
  const returnTextToComposerDraft = useCallback(
    (
      requestId: string,
      text: string,
      draftTarget: ScopedThreadRef | DraftId,
      discardEmptyCarriedDraft = false,
    ) => {
      const requestKey = pendingUserInputRequestKey(draftTarget, requestId);
      // The request key already includes the draft owner; object identity changes on navigation.
      const carried = carriedComposerDraftByRequestIdRef.current.get(requestKey);
      const draftPrompt =
        useComposerDraftStore.getState().getComposerDraft(draftTarget)?.prompt ?? "";
      const nextDraftPrompt = resolveComposerDraftPromptAfterReturningPendingAnswer({
        draftPrompt,
        carriedDraftPrompt: carried?.text ?? null,
        pendingCustomAnswer: text,
        discardEmptyCarriedDraft,
      });
      if (nextDraftPrompt === null) {
        return;
      }
      carriedComposerDraftByRequestIdRef.current.delete(requestKey);
      if (nextDraftPrompt !== draftPrompt) {
        setComposerDraftPrompt(draftTarget, nextDraftPrompt);
      }
    },
    [setComposerDraftPrompt],
  );
  // Merges a request's typed custom answers into a thread's composer draft.
  // Answers by request id are never pruned, so they stay readable after the
  // request itself has disappeared.
  const rescuePendingUserInputAnswers = useCallback(
    (requestId: string, draftTarget: ScopedThreadRef | DraftId) => {
      const text = collectPendingUserInputCustomAnswers(
        pendingUserInputAnswersByRequestId[pendingUserInputRequestKey(draftTarget, requestId)],
      );
      if (text !== null) {
        returnTextToComposerDraft(requestId, text, draftTarget);
      }
    },
    [pendingUserInputAnswersByRequestId, returnTextToComposerDraft],
  );
  const activePendingFirstQuestionId = activePendingUserInput?.questions[0]?.id ?? null;
  const activePendingFirstQuestionAllowsCustomAnswer =
    activePendingUserInput?.questions[0]?.allowCustomAnswer !== false;
  const activePendingHasAnswerState =
    activePendingUserInput !== null &&
    pendingUserInputAnswersByRequestId[activePendingRequestKey] !== undefined;
  // Moves composer text across the pending-question boundary (issue #8963).
  // A question that just appeared takes over the composer, so the draft is
  // carried into its first question's free-form answer and stays visible;
  // a question that disappears without being answered has its typed answers
  // rescued back into the draft. Both run in a layout effect so the composer
  // never paints a frame without the text. `prevPendingUserInputRef` is
  // written only here, so "previous" is always the state before this
  // transition.
  useLayoutEffect(() => {
    composerDraftTargetRef.current = composerDraftTarget;
    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const previous = prevPendingUserInputRef.current;
    // A thread switch only hides the question, so it neither rescues nor
    // consumes the submitted mark; the real resolve may arrive after the user
    // returns and must still read as an answer, not a cancel.
    if (
      previous &&
      previous.requestId !== nextRequestId &&
      pendingUserInputRequestKey(previous.draftTarget, null) ===
        pendingUserInputRequestKey(composerDraftTarget, null)
    ) {
      const previousKey = pendingUserInputRequestKey(previous.draftTarget, previous.requestId);
      const wasSubmitted = submittedPendingUserInputRequestIdsRef.current.has(previousKey);
      submittedPendingUserInputRequestIdsRef.current.delete(previousKey);
      if (
        shouldRescueCancelledPendingUserInput({
          previous,
          nextRequestId,
          currentDraftTarget: composerDraftTarget,
          wasSubmitted,
        })
      ) {
        rescuePendingUserInputAnswers(previous.requestId, previous.draftTarget);
      }
    }
    // Runs after the rescue so text from a question replaced in the same
    // render follows the user into the new one.
    if (
      nextRequestId !== null &&
      activePendingFirstQuestionId !== null &&
      (previous?.requestId !== nextRequestId ||
        pendingUserInputRequestKey(previous.draftTarget, null) !==
          pendingUserInputRequestKey(composerDraftTarget, null))
    ) {
      const draftToCarry = resolveComposerDraftToCarryIntoPendingUserInput({
        hasAnswerState: activePendingHasAnswerState,
        allowCustomAnswer: activePendingFirstQuestionAllowsCustomAnswer,
        draftPrompt:
          useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.prompt ?? "",
      });
      if (draftToCarry !== null) {
        carriedComposerDraftByRequestIdRef.current.set(activePendingRequestKey, {
          draftTarget: composerDraftTarget,
          text: draftToCarry,
        });
        setPendingUserInputAnswersByRequestId((existing) => ({
          ...existing,
          [activePendingRequestKey]: {
            ...existing[activePendingRequestKey],
            [activePendingFirstQuestionId]: setPendingUserInputCustomAnswer(
              existing[activePendingRequestKey]?.[activePendingFirstQuestionId],
              draftToCarry,
            ),
          },
        }));
      }
    }
    prevPendingUserInputRef.current = nextRequestId
      ? { requestId: nextRequestId, draftTarget: composerDraftTarget }
      : null;
  }, [
    activePendingFirstQuestionId,
    activePendingFirstQuestionAllowsCustomAnswer,
    activePendingHasAnswerState,
    activePendingRequestKey,
    activePendingUserInput?.requestId,
    composerDraftTarget,
    rescuePendingUserInputAnswers,
    setPendingUserInputAnswersByRequestId,
  ]);
  const beginSubmission = useCallback(
    (requestId: string) => {
      // Marked before the round trip: the resolved activity can arrive over the
      // socket before this RPC settles, and the rescue effect must already know
      // the question was answered rather than cancelled. Unmarked on failure so
      // a later real Stop of the still-open question can rescue the text.
      const requestKey = pendingUserInputRequestKey(composerDraftTarget, requestId);
      submittedPendingUserInputRequestIdsRef.current.add(requestKey);
      // The answer is what gets sent, so the persisted copy of text carried in
      // from the draft goes now, before the resolve can bring the draft back
      // on screen.
      const carried = carriedComposerDraftByRequestIdRef.current.get(requestKey);
      if (carried) {
        carriedComposerDraftByRequestIdRef.current.delete(requestKey);
        const draftPrompt =
          useComposerDraftStore.getState().getComposerDraft(carried.draftTarget)?.prompt ?? "";
        if (draftPrompt === carried.text) {
          setComposerDraftPrompt(carried.draftTarget, "");
        }
      }
      // Captures the submitting owner and answer snapshot across navigation.
      return () => {
        submittedPendingUserInputRequestIdsRef.current.delete(requestKey);
        // The answer was not sent after all, so the persisted copy of the
        // carried draft comes back (unless something else filled the draft
        // meanwhile) and the rescue below treats it as blank as usual. This
        // does not depend on which thread is on screen, so a reload or an
        // off-screen cancel after a failed submit still finds the draft.
        if (
          carried &&
          (useComposerDraftStore.getState().getComposerDraft(carried.draftTarget)?.prompt ?? "")
            .length === 0
        ) {
          carriedComposerDraftByRequestIdRef.current.set(requestKey, carried);
          setComposerDraftPrompt(carried.draftTarget, carried.text);
        }
        // Stop can remove the question while the answer is in flight. The
        // transition effect skipped it as submitted, so rescue here when the
        // question is gone and this thread is still on screen.
        if (
          prevPendingUserInputRef.current?.requestId !== requestId &&
          pendingUserInputRequestKey(composerDraftTargetRef.current, null) ===
            pendingUserInputRequestKey(composerDraftTarget, null)
        ) {
          rescuePendingUserInputAnswers(requestId, composerDraftTarget);
        }
      };
    },
    [composerDraftTarget, rescuePendingUserInputAnswers, setComposerDraftPrompt],
  );
  return { returnTextToComposerDraft, beginSubmission };
}
