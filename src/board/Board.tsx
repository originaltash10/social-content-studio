/**
 * The board: one card per photo and placement, grouped by photo, with filters, a validation
 * badge on every card, per-card progress while its file is made, and a details dialog.
 *
 * Files are made by the image worker through the render controller in src/lib/board, and stay
 * in memory: nothing is written to the session's renders/ or exports/ folders.
 *
 * The controller is created inside an effect and disposed of in that effect's cleanup. React
 * runs effects twice in development; each run gets its own controller, so the second never
 * inherits a disposed one.
 */

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createImageWorkerClient } from '../lib/render/client';
import type { ImageWorkerClient } from '../lib/render/client';
import { createRenderController } from '../lib/board/controller';
import type { CardRender, RenderController } from '../lib/board/controller';
import { planCreation, creationSummary } from '../lib/board/cards';
import { Slot } from '../lib/board/slot';
import { boardPlacements, placementName, PLATFORM_LABEL } from '../lib/board/targets';
import { versionInfo, versionLabel } from '../lib/board/versions';
import type { VersionInfo } from '../lib/board/versions';
import {
  PLATFORM_FILTERS,
  RESULT_FILTERS,
  RESULT_LABEL,
  groupCards,
  isPending,
  platformCounts,
  renderSummary,
} from '../lib/board/view';
import type { PlatformFilter, ResultFilter } from '../lib/board/view';
import { getPlacement, platforms } from '../lib/platforms';
import { isImageEdit } from '../lib/board/renderValidation';
import { getAssetBlob, useSessionStore } from '../store/sessionStore';
import type { Asset, Card, PlacementSpec } from '../types';
import { buttonClass, focusClass } from '../app/styles';
import { Editor } from '../editor/Editor';
import type { PhotoLoader } from '../editor/useSourcePhoto';
import { CardDetails } from './CardDetails';
import { createDialogUndo } from './dialogUndo';
import { lockPageScroll } from './scrollLock';
import { CardTile } from './CardTile';
import { CreateCards } from './CreateCards';

/** The parts of the image worker client the board uses. */
export type BoardClient = Pick<ImageWorkerClient, 'render' | 'cancel' | 'dispose'>;

export type BoardProps = {
  /** Starts the image worker client. Tests pass a fake. */
  createClient?: () => BoardClient;
  /** Hears each controller as it is created (and null when it goes), so tests can await it. */
  onController?: (controller: RenderController | null) => void;
  /** Opens a photo for the editor. Tests pass a fake. */
  loadPhoto?: PhotoLoader;
  /** Hears whether any card's preview is waiting or being made, whenever that changes. */
  onBusyChange?: (busy: boolean) => void;
};

const EMPTY: ReadonlyMap<string, CardRender> = new Map();
const noSubscribe = () => () => undefined;
const noSnapshot = () => EMPTY;

export const NO_SESSION_TEXT = 'Start or open a session to see cards.';
export const NO_PHOTOS_TEXT = 'Import a photo, then create cards for it.';
export const NO_CARDS_TEXT = 'No cards yet. Choose Create cards to pick placements.';
export const NO_MATCH_TEXT = 'No cards match these filters.';

const PLACEMENT_GROUPS = boardPlacements(platforms);

/** What the board shows for a card's placement, even if it is no longer in the data. */
function describe(card: Card): { name: string; spec: PlacementSpec | undefined } {
  const spec = getPlacement(card.platform, card.placement);
  return {
    spec,
    name: spec ? placementName(spec) : `${PLATFORM_LABEL[card.platform]} ${card.placement}`,
  };
}

function cardLabel(name: string, fileName: string, version: VersionInfo): string {
  return `${name} for ${fileName}, ${versionLabel(version)}`;
}

export function Board({
  createClient = createImageWorkerClient,
  onController,
  loadPhoto,
  onBusyChange,
}: BoardProps) {
  const session = useSessionStore((state) => state.session);
  const missingAssetIds = useSessionStore((state) => state.missingAssetIds);
  const [slot] = useState(() => new Slot<RenderController | null>(null));
  const controller = useSyncExternalStore(slot.subscribe, slot.get);
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>('all');
  const [resultFilter, setResultFilter] = useState<ResultFilter>('all');
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  /** Lets the page scroll again; set while the dialog is open. */
  const unlockScroll = useRef<(() => void) | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const formId = useId();
  const dialogHeadingId = useId();

  useEffect(() => {
    const client = createClient();
    const made = createRenderController({
      client,
      blobOf: getAssetBlob,
      writeResult: (id, result) => {
        useSessionStore.getState().setValidation(id, result);
      },
    });
    slot.set(made);
    onController?.(made);
    return () => {
      made.dispose();
      client.dispose();
      slot.set(null);
      onController?.(null);
    };
  }, [slot, createClient, onController]);

  useEffect(() => {
    controller?.sync({
      id: session?.id ?? null,
      cards: session?.cards ?? [],
      assets: session?.assets ?? [],
      missingAssetIds,
    });
  }, [controller, session, missingAssetIds]);

  const renders = useSyncExternalStore(
    controller ? controller.subscribe : noSubscribe,
    controller ? controller.snapshot : noSnapshot,
  );

  const cards = useMemo(() => session?.cards ?? [], [session]);
  const assets = useMemo(() => session?.assets ?? [], [session]);
  const photos = useMemo(() => assets.filter((asset) => asset.kind === 'image'), [assets]);
  const versions = useMemo(() => versionInfo(cards), [cards]);
  const filters = { platform: platformFilter, result: resultFilter };
  const groups = groupCards(assets, cards, renders, filters);
  const counts = platformCounts(cards);
  const pendingCount = cards.filter((card) => isPending(renders.get(card.id))).length;
  const busy = pendingCount > 0;
  useEffect(() => {
    onBusyChange?.(busy);
  }, [onBusyChange, busy]);
  const openCard = cards.find((card) => card.id === openId);
  const openAsset = assets.find((asset) => asset.id === openCard?.assetIds[0]);

  // A session change closes the form and the dialog, and clears the old session's message.
  const sessionId = session?.id ?? null;
  const [shownSession, setShownSession] = useState(sessionId);
  if (shownSession !== sessionId) {
    setShownSession(sessionId);
    setCreating(false);
    setMessage('');
    setOpenId(null);
  }

  // Each opening of the dialog gets its own undo: Ctrl/Cmd-Z there reverses only its changes.
  const [undoFor, setUndoFor] = useState(openId);
  const [dialogUndo, setDialogUndo] = useState(createDialogUndo);
  if (undoFor !== openId) {
    setUndoFor(openId);
    setDialogUndo(createDialogUndo());
  }

  // Show or close the dialog to match the open card. If the card goes away (undo), close it.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (openCard && !element.open) {
      element.showModal();
      // The board must stay where it is behind the dialog (src/board/scrollLock.ts).
      unlockScroll.current = lockPageScroll();
      // The browser puts focus on the first control it finds, which is past the editor while
      // the photo is still being opened. Start at the heading instead, so Tab goes through the
      // dialog from the top: crop area, focal point, Reset crop, file type, and Close last.
      document.getElementById(dialogHeadingId)?.focus({ preventScroll: true });
    }
    if (!openCard && element.open) element.close();
  }, [openCard, dialogHeadingId]);

  /** Lets the page scroll again, back where it was when the dialog opened. */
  function releaseScroll() {
    unlockScroll.current?.();
    unlockScroll.current = null;
  }
  // If the board goes away with the dialog open, the page must not stay locked.
  useEffect(() => releaseScroll, []);

  // Every way of closing the dialog ends here: Esc, its Close button, and the board closing it
  // because its card or its session went away.
  function onDialogClose() {
    setOpenId(null);
    releaseScroll();
    const target = opener.current?.isConnected ? opener.current : heading.current;
    opener.current = null;
    // Without scrolling: the page is already exactly where it was.
    target?.focus({ preventScroll: true });
  }

  function onCreate(chosen: Asset[], specs: PlacementSpec[]) {
    const plan = planCreation(chosen, specs, cards);
    const store = useSessionStore.getState();
    for (const draft of plan.drafts) store.addCard(draft);
    setMessage(creationSummary(plan));
    setCreating(false);
    createButton.current?.focus();
  }

  function onDuplicate(card: Card, name: string) {
    if (useSessionStore.getState().duplicateCard(card.id)) setMessage(`Made a copy of ${name}.`);
  }

  /** The editor for a card for one photo in a known placement; nothing for any other card. */
  function editorFor(card: Card, asset: Asset | undefined) {
    const target = describe(card).spec?.sizes[0];
    const edit = card.edit;
    if (!asset || asset.kind !== 'image' || !target || card.assetIds.length !== 1) return undefined;
    if (!isImageEdit(edit)) return undefined;
    return (
      <Editor
        key={card.id}
        card={{ ...card, edit }}
        asset={asset}
        target={target}
        blob={missingAssetIds.includes(asset.id) ? undefined : getAssetBlob(asset.id)}
        loadPhoto={loadPhoto}
        undo={dialogUndo}
      />
    );
  }

  function showAll() {
    setPlatformFilter('all');
    setResultFilter('all');
  }

  return (
    <section aria-label="Board" className="flex flex-col gap-4 rounded-card bg-surface p-6">
      <h2 ref={heading} tabIndex={-1} className="font-heading text-lg font-semibold">
        Board
      </h2>

      {!session ? (
        <p className="text-ink-secondary">{NO_SESSION_TEXT}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-4">
            <button
              ref={createButton}
              type="button"
              className={buttonClass}
              aria-expanded={creating}
              aria-controls={creating ? formId : undefined}
              disabled={photos.length === 0}
              onClick={() => setCreating((open) => !open)}
            >
              Create cards
            </button>

            <fieldset className="flex flex-wrap items-center gap-3">
              <legend className="text-label text-muted-text">Platform</legend>
              {PLATFORM_FILTERS.map((value) => (
                <label key={value} className="flex items-center gap-1">
                  <input
                    type="radio"
                    name="board-platform"
                    className={`accent-accent ${focusClass}`}
                    checked={platformFilter === value}
                    onChange={() => setPlatformFilter(value)}
                  />
                  {value === 'all' ? 'All' : PLATFORM_LABEL[value]} ({counts[value]})
                </label>
              ))}
            </fieldset>

            <label className="flex flex-col gap-1">
              <span className="text-label text-muted-text">Result</span>
              <select
                className={`rounded-control border border-muted bg-surface px-2 py-1 text-ink ${focusClass}`}
                value={resultFilter}
                onChange={(event) => setResultFilter(event.target.value as ResultFilter)}
              >
                {RESULT_FILTERS.map((value) => (
                  <option key={value} value={value}>
                    {value === 'all' ? 'All results' : RESULT_LABEL[value]}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className={buttonClass}
              disabled={pendingCount === 0}
              onClick={() => controller?.cancelAll()}
            >
              Cancel all
            </button>
          </div>

          {creating && (
            <CreateCards
              id={formId}
              photos={photos}
              missingAssetIds={missingAssetIds}
              groups={PLACEMENT_GROUPS}
              onCreate={onCreate}
              onClose={() => {
                setCreating(false);
                createButton.current?.focus();
              }}
            />
          )}

          {photos.length === 0 && cards.length === 0 ? (
            <p className="text-ink-secondary">{NO_PHOTOS_TEXT}</p>
          ) : cards.length === 0 ? (
            <p className="text-ink-secondary">{NO_CARDS_TEXT}</p>
          ) : groups.length === 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-ink-secondary">{NO_MATCH_TEXT}</p>
              <button type="button" className={buttonClass} onClick={showAll}>
                Show all
              </button>
            </div>
          ) : (
            groups.map((group) => {
              const fileName = group.asset?.fileName ?? 'A photo that is not in this session';
              return (
                <section key={group.assetId} aria-label={fileName} className="flex flex-col gap-2">
                  <h3 className="font-heading font-semibold">{fileName}</h3>
                  <ul
                    aria-label={`Cards for ${fileName}`}
                    className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4"
                  >
                    {group.cards.map((card) => {
                      const { name, spec } = describe(card);
                      const version = versions.get(card.id) as VersionInfo;
                      const label = cardLabel(name, fileName, version);
                      return (
                        <li key={card.id}>
                          <CardTile
                            card={card}
                            name={name}
                            label={label}
                            size={spec?.sizes[0] ?? null}
                            fileName={fileName}
                            render={renders.get(card.id)}
                            version={version}
                            onCancel={() => controller?.cancel(card.id)}
                            onRenderAgain={() => controller?.renderAgain(card.id)}
                            onOpen={(button) => {
                              opener.current = button;
                              setOpenId(card.id);
                            }}
                            onDuplicate={() => onDuplicate(card, name)}
                          />
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })
          )}
        </>
      )}

      <p role="status" aria-label="Board messages" className="text-ink-secondary">
        {message}
      </p>
      <p role="status" aria-label="Render progress" className="text-ink-secondary">
        {renderSummary(cards, renders)}
      </p>

      <dialog
        ref={dialog}
        aria-labelledby={dialogHeadingId}
        className="m-auto w-[min(64rem,calc(100vw-2rem))] overscroll-contain rounded-card bg-surface p-6 text-ink backdrop:bg-ink/40"
        onClose={onDialogClose}
      >
        {openCard && (
          <div className="flex flex-col gap-4">
            <CardDetails
              card={openCard}
              name={describe(openCard).name}
              fileName={openAsset?.fileName ?? 'A photo that is not in this session'}
              editor={editorFor(openCard, openAsset)}
              render={renders.get(openCard.id)}
              size={describe(openCard).spec?.sizes[0] ?? null}
              version={versions.get(openCard.id) as VersionInfo}
              headingId={dialogHeadingId}
              undo={dialogUndo}
            />
            <div>
              <button type="button" className={buttonClass} onClick={() => dialog.current?.close()}>
                Close
              </button>
            </div>
          </div>
        )}
      </dialog>
    </section>
  );
}
