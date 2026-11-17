/** The form that turns chosen photos and placements into cards. */

import { useState } from 'react';
import type { PlatformPlacements } from '../lib/board/targets';
import { sizeLabel } from '../lib/board/targets';
import type { Asset, PlacementSpec } from '../types';
import { buttonClass, focusClass } from '../app/styles';

export type CreateCardsProps = {
  id: string;
  photos: readonly Asset[];
  missingAssetIds: readonly string[];
  groups: readonly PlatformPlacements[];
  onCreate: (photos: Asset[], placements: PlacementSpec[]) => void;
  onClose: () => void;
};

const keyOf = (spec: PlacementSpec) => `${spec.platform}/${spec.placement}`;
const checkboxClass = `h-4 w-4 accent-accent ${focusClass}`;

export function CreateCards({
  id,
  photos,
  missingAssetIds,
  groups,
  onCreate,
  onClose,
}: CreateCardsProps) {
  const usable = photos.filter((photo) => !missingAssetIds.includes(photo.id));
  const [chosenPhotos, setChosenPhotos] = useState<string[]>(() => usable.map((p) => p.id));
  const [chosenPlacements, setChosenPlacements] = useState<string[]>([]);

  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const pickedPhotos = usable.filter((photo) => chosenPhotos.includes(photo.id));
  const pickedPlacements = groups
    .flatMap((group) => group.placements)
    .filter((spec) => chosenPlacements.includes(keyOf(spec)));
  const ready = pickedPhotos.length > 0 && pickedPlacements.length > 0;

  return (
    <form
      id={id}
      aria-label="Create cards"
      className="flex flex-col gap-4 rounded-card border border-page p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onCreate(pickedPhotos, pickedPlacements);
      }}
    >
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 font-medium">Photos</legend>
        {photos.map((photo) => {
          const missing = missingAssetIds.includes(photo.id);
          return (
            <label key={photo.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                className={checkboxClass}
                checked={!missing && chosenPhotos.includes(photo.id)}
                disabled={missing}
                onChange={() => setChosenPhotos((list) => toggle(list, photo.id))}
              />
              {photo.fileName}
              {missing && (
                <span className="text-label text-muted-text">
                  (file missing, so it cannot be used)
                </span>
              )}
            </label>
          );
        })}
      </fieldset>

      <div className="flex flex-wrap gap-6">
        {groups.map((group) => (
          <fieldset key={group.platform} className="flex flex-col gap-1">
            <legend className="mb-1 font-medium">{group.label}</legend>
            {group.placements.map((spec) => (
              <label key={keyOf(spec)} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className={checkboxClass}
                  checked={chosenPlacements.includes(keyOf(spec))}
                  onChange={() => setChosenPlacements((list) => toggle(list, keyOf(spec)))}
                />
                {spec.label} <span className="text-label text-muted-text">({sizeLabel(spec)})</span>
              </label>
            ))}
          </fieldset>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={buttonClass} disabled={!ready}>
          Create
        </button>
        <button type="button" className={buttonClass} onClick={onClose}>
          Close
        </button>
        {!ready && (
          <span className="text-label text-muted-text">
            Choose at least one photo and one placement.
          </span>
        )}
      </div>
    </form>
  );
}
