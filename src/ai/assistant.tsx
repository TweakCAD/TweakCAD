/**
 * The assistant in the app: the tool context over the app's services, the
 * MCP bridge client, the models the site offers the caller, and the chat
 * panel running turns through the agent loop.
 */
import { useEffect, useMemo, useState } from 'react';
import type { AppServices } from '../app/services';
import { loadSketchSolver } from '../sketcher';
import type { SaasState } from '../storage/saasState';
import { runAgentTurn } from './agentTurn';
import { startBridgeClient } from './bridgeClient';
import { ChatPanel, type ChatModelOption } from './ChatPanel';
import { listAvailableModels } from './chatClient';
import { createAiContext, type AiContext, type ViewControl } from './context';

/** The tool context for the booted services; null before boot. */
export function useAiContext(services: AppServices | null, viewport: () => ViewControl | null): AiContext | null {
  const ctx = useMemo(
    () => (services ? createAiContext({ services, viewport, solver: loadSketchSolver }) : null),
    [services, viewport],
  );
  // The bridge follows Settings, AI from boot on, as long as the services live.
  useEffect(() => (ctx ? startBridgeClient({ ctx }) : undefined), [ctx]);
  return ctx;
}

/**
 * The models the site offers the caller, fetched when the site is reachable
 * and again when the signed-in user changes; empty means no assistant. Kept
 * with the caller it was fetched for, so one user's list never shows for the
 * next.
 */
export function useAssistantModels(saas: SaasState): readonly ChatModelOption[] {
  const caller = saas.kind === 'available' ? (saas.signedIn ? saas.user.id : '') : null;
  const [fetched, setFetched] = useState<{ caller: string; models: readonly ChatModelOption[] } | null>(null);
  useEffect(() => {
    if (caller === null) return;
    const ac = new AbortController();
    void listAvailableModels(ac.signal).then((models) => {
      if (!ac.signal.aborted) setFetched({ caller, models });
    });
    return () => ac.abort();
  }, [caller]);
  return caller !== null && fetched?.caller === caller ? fetched.models : [];
}

export interface AssistantPanelProps {
  ctx: AiContext;
  saas: Extract<SaasState, { kind: 'available' }>;
  models: readonly ChatModelOption[];
  onClose: () => void;
  onRequestSignIn: () => void;
}

export function AssistantPanel(props: AssistantPanelProps) {
  const { ctx } = props;
  const documentId = String(ctx.services.editor.document.id ?? 'current');
  return (
    <ChatPanel
      onClose={props.onClose}
      saas={props.saas}
      onRequestSignIn={props.onRequestSignIn}
      projectKey={documentId}
      availableModels={props.models}
      onSendMessage={(text, history, opts) =>
        runAgentTurn({ text, history, modelId: opts.modelId, signal: opts.signal, ctx })
      }
    />
  );
}
