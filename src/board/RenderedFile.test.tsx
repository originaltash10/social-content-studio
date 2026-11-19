/** The picture box and the dialog's Rendered file, which keep their size while a card renders. */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CardRender } from '../lib/board/controller';
import type { DoneRender } from './lastDone';
import { FilePreview, RenderedFile } from './RenderedFile';

const DONE: DoneRender = {
  kind: 'done',
  url: 'blob:first',
  width: 1200,
  height: 627,
  bytes: 90_000,
  format: 'jpg',
  upscaled: false,
};
const WORKING: CardRender = { kind: 'working', stage: 'decoding' };

function preview(props: Partial<Parameters<typeof FilePreview>[0]> = {}) {
  return (
    <FilePreview
      render={undefined}
      shown={null}
      alt="Preview"
      progressName="Rendering it"
      boxClassName="h-48"
      shape={null}
      emptyText="Nothing yet"
      {...props}
    />
  );
}

describe('FilePreview', () => {
  it('shows the empty text in a box without a shape when nothing is known', () => {
    const { container } = render(preview());
    const box = container.firstElementChild as HTMLElement;
    expect(box).toHaveTextContent('Nothing yet');
    expect(box.style.aspectRatio).toBe('');
    expect(box).toHaveClass('h-48');
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('shows the empty text while a first file is being made when no pending text is given', () => {
    render(preview({ render: WORKING }));
    expect(screen.getByText('Nothing yet')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Rendering it' })).toHaveAttribute(
      'aria-valuetext',
      'Opening the photo',
    );
  });

  it('shows the pending text instead when one is given', () => {
    render(preview({ render: WORKING, pendingText: 'Coming' }));
    expect(screen.getByText('Coming')).toBeInTheDocument();
    expect(screen.queryByText('Nothing yet')).toBeNull();
  });

  it('lays the progress over the bottom edge of a kept picture', () => {
    render(preview({ render: WORKING, shown: DONE, shape: DONE }));
    const picture = screen.getByRole('img', { name: 'Preview' });
    expect(picture).toHaveAttribute('data-updating', 'true');
    expect(screen.getByRole('progressbar')).toHaveClass('absolute', 'bottom-0');
  });
});

describe('RenderedFile', () => {
  it('is shaped by the last file, not the placement size, once there is one', () => {
    render(
      <RenderedFile
        render={WORKING}
        shown={DONE}
        alt="Preview"
        progressName="Rendering it"
        size={{ width: 1080, height: 1080 }}
      />,
    );
    const box = screen.getByRole('img').parentElement as HTMLElement;
    expect(box.style.aspectRatio).toBe('1200 / 627');
    expect(screen.getByRole('figure')).toHaveTextContent('Updating…');
  });

  it('is shaped by the placement size before the first file, and says there is no preview yet', () => {
    render(
      <RenderedFile
        render={undefined}
        shown={null}
        alt="Preview"
        progressName="Rendering it"
        size={{ width: 1080, height: 1080 }}
      />,
    );
    const box = screen.getByRole('figure').firstElementChild as HTMLElement;
    expect(box.style.aspectRatio).toBe('1080 / 1080');
    expect(box).toHaveTextContent('No preview yet.');
  });
});
