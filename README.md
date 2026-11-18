# Social Content Studio

Social Content Studio is a browser-only app that prepares images and video for Instagram,
LinkedIn, Facebook and X: the right size and shape for each placement, with captions checked
against each platform's rules.

Live app: <https://originaltash10.github.io/social-content-studio> (available once published)

## Status: early development

The app can now turn a photo into correctly sized images for Instagram and LinkedIn, and lets
you adjust how each one is cropped, but it is not finished: there is no way yet to save those
images as files. What works today:

- **Sessions.** Create a session, save it, and open it again later. Changes save automatically
  once a session has a folder. Ctrl/Cmd-Z reverses the last change to a card, up to 50 steps
  back. Clearing a session removes it from the app; nothing on disk is deleted.
- **Importing photos.** With a session open, drop JPG, PNG or HEIC photos onto the import panel,
  or use Choose files. Each photo is shown as a small preview with its name and size, and is
  saved with the session, unchanged. A photo that is already in the session is not added twice.
  Files are recognised by their contents, not their names. Video (MP4, MOV) is not imported yet,
  and other file types need converting to JPG or PNG first; the panel says so for each file.
- **The board.** Choose Create cards, pick photos and Instagram or LinkedIn placements (for
  example Instagram Feed vertical or LinkedIn Image post square), and the board makes one card
  for each. Each card's image is cropped around a point on the photo that you can move, and
  resized to the placement's exact size, with a progress bar while it is made and a Cancel
  button. Every card is then checked against the platform's rules and shows Pass, Warning or
  Fail, with the reason on the card. You can filter the board by platform and by result, open a
  card to adjust its crop and see every check in full, duplicate a card, and render a card
  again. The images are made in your browser and are kept only while the page is open; a
  reopened session makes them again.
- **Adjusting a crop.** Open a card to see the whole photo with the crop drawn over it. Drag the
  crop to move it, or drag a corner to make it larger or smaller; it always keeps the shape the
  placement needs. You can do the same with the keyboard: the arrow keys move the crop, and plus
  and minus resize it (hold Shift for bigger steps). The round marker is the point the photo is
  cropped around. It starts in the middle; move it onto the part of the photo that matters, and
  every card for that photo that you have not adjusted by hand is cropped around it again. A
  duplicated card has its own marker: moving it changes only that card, and moving the photo's
  marker does not change the duplicate.
  Reset crop puts a card back to that automatic crop, and Ctrl/Cmd-Z reverses your last change.
  Cropping in closely enlarges the picture, so the app stops at twice the size and adds a note
  when a picture has been enlarged.
- **Platform rules.** The sizes, caption limits and other rules for each placement are kept in
  one data file (`src/data/platforms.json`), which the board and its checks read.

For now every card shows a Warning, because alt text (a description of the image for people
using screen readers) cannot be written yet. Still to come: saving the images as files
(export), captions and alt text, text and logos on the image, carousels, and video.
[SPEC.md](SPEC.md) describes the full plan.

## Privacy

The app runs entirely in your browser. There is no server, and your media files stay on your
computer.

Planned AI writing features (captions and alt text) will be optional. They will use your own
API key and send content only to the AI provider you choose, and the app will say clearly what
it sends. None of this is built yet.

## Saving your work

- **Chrome or Edge:** save a session to a folder on your computer and reopen it later.
- **Other browsers:** download the session as a `.scs` file and load that file to continue.

## Running it locally

You need [Node.js](https://nodejs.org/) (a current LTS release) and npm.

```bash
npm install     # install dependencies
npm run dev     # start the app, then open the address it prints
npm test        # run the tests
npm run build   # build the app into dist/
```

To check the board in a real Chrome browser, run `node e2e/board.check.mjs`, and to check the
editor, run `node e2e/editor.check.mjs` (each needs Playwright with Chromium installed, and
prints a pass or fail line for each check).

## License

All rights reserved. No license is granted to use, copy or modify this code.

### Fonts

The app bundles two typefaces from npm, served from the app itself and never from a font
service:

- **Inter** (`@fontsource-variable/inter`), Copyright 2016 The Inter Project Authors.
- **Inter Tight** (`@fontsource-variable/inter-tight`), Copyright 2022 The Inter Project
  Authors.

Both are licensed under the [SIL Open Font License, Version 1.1](https://openfontlicense.org/),
which allows them to be bundled and redistributed with this app. The licence text is included
in each package's `LICENSE` file, and the built CSS keeps a notice naming both fonts and the
licence. The "All rights reserved" notice above does not apply to the fonts.

### HEIC decoder

Chrome and Edge cannot open HEIC photos (the iPhone format) on their own, so the app includes
a decoder:

- **heic-to** 1.6.7, by Hopper Gee, licensed under the GNU Lesser General Public License,
  version 3 (LGPL-3.0). Source for this exact version:
  <https://www.npmjs.com/package/heic-to/v/1.6.7?activeTab=code> (project:
  <https://github.com/hoppergee/heic-to>).
- heic-to contains a build of **libheif** 1.23.7 and its HEVC decoder **libde265**, both by
  struktur AG and also licensed under LGPL-3.0. Source: <https://github.com/strukturag/libheif>
  and <https://github.com/strukturag/libde265>.

The licence texts are in this repository and are published with the app:

- [`public/licenses/heic-to-LICENSE.txt`](public/licenses/heic-to-LICENSE.txt): heic-to's
  licence file, which includes the LGPL-3.0 text.
- [`public/licenses/GPL-3.0.txt`](public/licenses/GPL-3.0.txt): the GNU General Public License,
  version 3, which the LGPL-3.0 refers to.

The decoder is used unmodified. It is built into its own file, separate from the app's code,
and is downloaded only when a HEIC photo needs to be opened, so it can be replaced with another
build of the same library. The "All rights reserved" notice above does not apply to the
decoder.
