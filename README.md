# Tap Cards (MVP prototype)

A deck of NFC playing cards plus a companion web app. Built from the *AI Smart Card Platform – Concept Brief*, following its Build Sequence. Done so far: steps 1–5 (engine, turns, matching game with simulated taps, Web NFC, OpenRouter commentary, Lazybird voice, wake-word / push-to-talk). The native wrapper is deferred.

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

## Voice & AI (step 5)
Open **Voice & AI settings** on the home screen and paste your own keys. They are stored only in your browser's `localStorage` and sent only to their own service, so this mode is for local testing: a shipped app needs server-side keys (the brief's design).
- **Commentary:** *Built-in lines* (free, 20+ variations for frequent moments) or *Live AI* (OpenRouter premium model for plays, +2 and wins, capped per game). Any AI failure silently falls back to built-in lines; scoring never depends on it.
- **Voice out:** Lazybird (click *Load voices*, pick one) or the browser's voice when no key/voice is set. Captions always show.
- **Voice in (Chrome):** push-to-talk or wake word (default "hey deck"). Commands: "draw", "last card". A local grammar handles them; the fast model is only a fallback for odd phrasing.
- **Lazybird API:** `GET /voices` and `POST /generate-speech` (`{voiceId, text|ssml}` → MP3), matching Lazybird's API reference. Their docs say API keys shouldn't be exposed in browser code, which is exactly what this paste-your-own-key mode does; use it for local testing only and move the calls behind a server before shipping. Lazybird's browser CORS support is untested. OpenRouter and the microphone were also untested against the real services; tests use mocked `fetch` and a fake recognizer.

Key hygiene: create the OpenRouter key with a credit limit (OpenRouter recommends this for every key) and delete it if exposed. Never commit keys.

Real-device checklist: paste both keys → Load voices → play a round with Live AI → try push-to-talk "draw" → try "hey deck, last card".

## Deploy
`.github/workflows/pages.yml` publishes `dist/` to GitHub Pages on push to `main` (enable Pages → "GitHub Actions" in repo settings).
