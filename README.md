# Tap Cards (MVP prototype)

A deck of NFC playing cards plus a companion web app. Built from the *AI Smart Card Platform – Concept Brief*, following its Build Sequence. Done so far: steps 1–4 (engine, turns, matching game with simulated taps, Web NFC). AI/voice and the native wrapper are deferred.

## Run
```
npm install
npm run dev      # play with simulated taps
npm test         # engine + NFC adapter tests
npm run build    # type-check + static bundle in dist/
```

## Layout
- `src/engine/` generic engine: cartridge format, public/private/hidden state split, turn tracking, chip→card mapping.
- `src/games/matching.ts` the first cartridge, "Match Up" (placeholder name; Uno is a Mattel trademark). Match number or shape; 11 = skip, 12 = reverse, 13 = +2 (stackable); draw only when nothing is playable; missing the "last card" call costs 2 cards.
- `src/input/` `CardInput` interface with a simulated implementation and a Web NFC one.
- `src/ui/` minimal status screen, setup, and tag registration.

## Simulated play
Hands are dealt virtually, so the debug panel shows the current player's hand; clicking a card is a tap. Keys: **D** draw, **L** call last card.

## Real NFC (Chrome on Android, HTTPS)
1. Open **Register NFC tags**, pick a card, tap its tag; selection advances so you can go through the deck. Bindings are stored in `localStorage` (chip serial number → card ID).
2. In setup, tick **Use real NFC taps**.
The tag stores only its factory ID; card meaning lives in the app. Web NFC is untested against real hardware here (no device in CI), only against a mocked reader.

## Deploy
`.github/workflows/pages.yml` publishes `dist/` to GitHub Pages on push to `main` (enable Pages → "GitHub Actions" in repo settings).
