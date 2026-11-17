# Social Content Studio

Social Content Studio is a browser-only app that prepares images and video for Instagram,
LinkedIn, Facebook and X: the right size and shape for each placement, with captions checked
against each platform's rules.

Live app: <https://originaltash10.github.io/social-content-studio> (available once published)

## Status: early development

The app is not yet usable for making posts. What works today:

- **Sessions.** Create a session, save it, load it again, and clear it. Changes save
  automatically once a session has a folder. The Undo button, or Ctrl/Cmd-Z, reverses the last
  change to a card, up to 50 steps back. For now the only card action on screen is adding a
  sample card.
- **Importing photos.** With a session open, drop JPG, PNG or HEIC photos onto the import panel,
  or use Choose files. Each photo is shown as a small preview with its name and size, and is
  saved with the session, unchanged. A photo that is already in the session is not added twice.
  Files are recognised by their contents, not their names. Video (MP4, MOV) is not imported yet,
  and other file types need converting to JPG or PNG first; the panel says so for each file.
- **Platform rules.** The sizes, caption limits and other rules for each placement are kept in
  one data file (`src/data/platforms.json`), and the checker that compares a post against them is
  written and tested. It is not yet connected to anything on screen.
- **Image resizing.** The engine that crops a photo around its focal point and resizes it to a
  placement's size, as JPG or PNG, is built and tested. Nothing on screen uses it yet; it will be
  usable from the board of posts in a later step.

The screen is a plain test panel for sessions and importing. Still planned and not built yet:
importing video, captions, the board of posts, the editor for adjusting a crop, and export.
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
