# Tap Cards (MVP prototype)

A deck of NFC playing cards plus a companion web app. Built from the *AI Smart Card Platform – Concept Brief*, following its Build Sequence. Live site (GitHub Pages): https://dexterai2026-sys.github.io/tapproject/

> **This README is a running document.** Every push updates the **Status** table and adds an entry to the **Running log** at the bottom (newest first).

## Status

| Area | State |
|---|---|
| Engine, turns, Match Up game (steps 1–3) | Done, unit-tested (3,000 simulated games finish; no stalemates) |
| Web NFC tap input + tag registration (step 4) | Built; tested with a mocked reader only, **not on real tags** |
| OpenRouter commentary + Lazybird voice (step 5) | Built to the documented APIs; **not run against the live services** |
| Voice input: wake word + push-to-talk | Built with backoff, tolerant wake word, interrupt; tested with a fake recognizer, **not on a real mic** |
| Voice latency tracing (Timing panel) | Built; verified against injected delays (reads back 100/400/300/50ms as 102/400/317/54). **Real numbers need one round on a phone** |
| Brief UX decisions (names, pause/resume, sound/haptics, accessibility, nav, onboarding, accents, game-night tally) | Done |
| Spades + other launch games, The Last Witness | Not started |
| Multi-device sync, game creation by voice, shared game library, accounts | Not started (later phases) |
| Server-side API keys, native Capacitor wrapper (step 6) | Not started; keys are pasted by the user for now |

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

## Design-brief UX (audit pass)
- **Player names:** name each seat on the setup screen (remembered; blanks become "Player N", duplicates get a number).
- **Pause & resume:** every move is saved; *Pause & exit* keeps the game and *Resume game* (home or Saved tab) restores it exactly. Finished games are not kept.
- **Game night:** wins are tallied per player name across games until *New game night*.
- **Sound & haptics:** three cue families (tap registered, error, game moments such as your turn and a win), styled per game (Match Up is playful). Sound can be turned off in Settings.
- **Accessibility:** shape-distinct suits, text size S/M/L/XL, and a high-contrast mode, all in Settings and applied live.
- **Onboarding:** the first Match Up game coaches the first tap, then hints at the voice layer; replay it from Settings.
- **Navigation:** bottom bar (Games / Saved / Tags / Settings), hidden during a game. Each game sets its own accent color.
- Voice-triggered actions are always confirmed aloud, even with commentary off.
- Not verifiable in CI: how the sounds feel on a phone. Check by ear on your device.

## Voice & AI (step 5)
Open **Voice & AI settings** on the home screen and paste your own keys. They are stored only in your browser's `localStorage` and sent only to their own service, so this mode is for local testing: a shipped app needs server-side keys (the brief's design).
- **Commentary:** *Built-in lines* (free, 20+ variations for frequent moments) or *Live AI* (OpenRouter premium model for plays, +2 and wins, capped per game). Any AI failure silently falls back to built-in lines; scoring never depends on it.
- **Voice out:** Lazybird (click *Load voices*, pick one) or the browser's voice when no key/voice is set. Captions always show.
- **Voice in (Chrome):** push-to-talk (hold the mic button, no wake word) or wake word (default "hey deck", then the command). A local grammar handles commands; the fast model is only a fallback for odd phrasing. Commands must be 8 words or fewer.
- **Lazybird API:** `GET /voices` and `POST /generate-speech` (`{voiceId, text|ssml}` → MP3), matching Lazybird's API reference. Their docs say API keys shouldn't be exposed in browser code, which is exactly what this paste-your-own-key mode does; use it for local testing only and move the calls behind a server before shipping. Lazybird's browser CORS support is untested. OpenRouter and the microphone were also untested against the real services; tests use mocked `fetch` and a fake recognizer.

Use **Check models** in settings to confirm your OpenRouter model ids exist (it calls OpenRouter's `GET /api/v1/model/{author}/{slug}`).

Key hygiene: create the OpenRouter key with a credit limit (OpenRouter recommends this for every key) and delete it if exposed. Never commit keys.

Real-device checklist: paste both keys → Load voices → play a round with Live AI → try push-to-talk "draw" and "how many cards" → try "hey deck, last card" → say "help".

### Spoken commands (Match Up)

| Say | What happens |
|---|---|
| "draw" / "I can't play" / "pick up" / "nothing to play" | Draws for the current player (only allowed with no playable card) |
| "last card" / "one card left" / "down to one" / "uno" | Calls last card for the player on one card |
| "whose turn" / "who's up" / "who's next" | Says whose turn it is |
| "score" / "what's the score" / "who's winning" | Points this game and game-night wins |
| "how many cards" / "card count" / "cards left" | Cards in each hand |
| "top card" / "what's on top" | Reads the top card |
| "repeat" / "say that again" | Repeats the last spoken line |
| "help" / "what can I say" | Lists the commands |
| "pause" | Saves and exits to home (resume from Home or Saved) |
| "play again" / "rematch" | New game, only after a game has finished |

Playing a card is always a tap, never a voice command. Questions never change the game. Examples: "hey deck, whose turn" or hold the mic and say "how many cards".

### Voice reliability
- **Wake word is forgiving:** "hey dec", "hay deck", "hi tech" etc. still wake it; a false wake does nothing unless a valid command follows.
- **Backoff:** if the speech service errors (offline etc.), restarts slow down (0.5s, 1s, 2s, 4s…, max 30s) and stop after 5 failures in a row, with a *Voice stopped. Tap to retry* button.
- **Push-to-talk interrupts the app:** pressing it stops the app's speech and un-mutes the mic. Wake-word mode mutes the mic while the app speaks so it doesn't hear itself.
- Chrome's speech recognition sends audio to Google's servers, so it needs internet, and wake-word mode keeps the mic open while a game is on. Accuracy in a noisy room is unmeasured; test it on your device.

## Measuring voice latency

Every game screen has a **Timing** panel (hide it in Settings → *Show voice timing panel*). After a voice command it shows where the time went, from the moment you stop talking:

| Stage | What it is |
|---|---|
| Mic warm-up | Push-to-talk press → the recognizer is actually capturing |
| Recognizer finalize | You stop talking → Chrome returns the final transcript (it sends audio to Google's service and waits for a pause) |
| Parse command | Wake-word strip + grammar (the OpenRouter fallback time is recorded separately as `llmParseMs`) |
| Game action / Commentary text | Applying the move; picking the line (instant for built-in lines, an OpenRouter call for Live AI) |
| Speech queue wait | How long the line waited behind earlier lines |
| Lazybird first byte / download | Request sent → response starts → audio fully downloaded |
| Playback start | Audio decoded → actually audible |
| Browser voice start | Same idea when the browser's built-in voice is used (no Lazybird key or Lazybird failed) |

Two headline numbers: **end of speech → first sound** and **end of speech → screen update**, with median and p90 over the session. The slowest stage is highlighted.

**To share results:** play a round (try push-to-talk and wake word, with and without Live AI), tap **Copy results**, and paste the JSON into the chat. It contains timings, the voice path used (`lazybird`, `browser`, or `browser-after-lazybird-failed`) and your mic/commentary settings. It never contains your keys or what you said (only the command type).

Likely fixes, picked once the numbers show the biggest stage: act on interim results, play an instant "heard you" chime, cache the synthesized built-in lines, shorten clips, and limit Live AI.

## Deploy
`.github/workflows/pages.yml` publishes `dist/` to GitHub Pages on push to `main` (enable Pages → "GitHub Actions" in repo settings).

## Running log

Newest first. Add an entry with every push.

### 2026-10-02 (latency tracing)
- **Voice latency:** added a Timing panel and a tracer that times every stage from wake to first sound (mic warm-up, recognizer finalize, parse, action, commentary, queue wait, Lazybird first byte + download, playback start), with median/p90 and a *Copy results* export that omits keys and transcripts. Per-label trace caps so taps never evict voice traces. 132 unit tests; browser-verified against injected delays. No behavior change.

### 2026-10-02
- **Voice:** added spoken commands (whose turn, score, how many cards, top card, repeat, help, pause, play again). Added error backoff with give-up and retry, tolerant wake-word matching, push-to-talk interrupting speech, a "Listening…" indicator, and a 20s cap so browser speech can never wedge the queue. Created this Status + Running log. 109 unit tests; browser-tested with a fake recognizer (every command, wake and push modes, backoff, interrupt).

### 2026-10-01
- `5575fc7` Closed the brief's UX gaps: player names, pause/resume, sound + haptics, text size + high contrast, bottom nav, first-run tutorial, per-game accent, game-night tally. Pushed to `main`; Pages deploy succeeded after enabling Pages → GitHub Actions.
- `50f8aa4` Added **Check models** to validate OpenRouter model ids.
- `9a07c84` Warned about OpenRouter credit limits for pasted keys.
- `684365a` Aligned the Lazybird client with its API reference (`/generate-speech`, `voiceId`).
- `58e64cb` Step 5: OpenRouter commentary (built-in lines + live AI), Lazybird voice, wake-word / push-to-talk input.
- `e6fec7b` UI, simulated + Web NFC input, tag registration, Pages workflow.
- `c1df909` Engine, turn tracking and the Match Up cartridge.
