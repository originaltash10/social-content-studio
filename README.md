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
- **Platform rules.** The sizes, caption limits and other rules for each placement are kept in
  one data file (`src/data/platforms.json`), and the checker that compares a post against them is
  written and tested. It is not yet connected to anything on screen.

The screen is a plain test panel for sessions. Importing photos and video, cropping and
resizing, captions, the board of posts and export are planned but not built yet.
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
