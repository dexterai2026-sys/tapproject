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
| Voice latency tracing (Timing panel) | Built: per-stage timings, every spoken line traced separately, output latency read from the browser's audio clock. Verified against injected delays (reads back 100/400/300/50ms as 102/400/317/54). **Real numbers need one round on a phone** |
| Scoring: specials 20, winning +2 is drawn first; optional play-on mode (last holding cards loses, 3+ players) | Built and tested, including simulated whole games |\n| Mic closes while the app speaks (fixes audio cut-outs); draw pile empty/restock prompts for real cards | Built and tested with a fake recognizer and 10-card simulated games. **Not yet confirmed on a real phone** |
| Setup remembers your choices: player count, "Use real NFC taps" (defaults on when the phone supports it and tags are registered), dealing, deck | Built and tested, with a "N of M cards have tags" hint. |
| Real-card table model: count-only and scan-hands dealing, any number of cards in play | Built and tested: counts match real hands through whole simulated games (3,000+ moves, many deck sizes). **Not yet tried with real NFC cards** |
| Voice speed: hybrid voice, pipelined + cached Lazybird, heard-text, wake-word timing | Built; verified in a browser against a mocked 4s Lazybird (answers audible in ~440ms, repeats from cache in ~470ms). **Real-phone gain, iOS behavior and voice quality still to confirm** |
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
| "undo" / "go back" / "oops" | Takes back the last move |
| "pause" | Saves and exits to home (resume from Home or Saved) |
| "play again" / "rematch" | New game, only after a game has finished |

Playing a card is always a tap, never a voice command. Questions never change the game. Examples: "hey deck, whose turn" or hold the mic and say "how many cards".

### Voice reliability
- **Wake word is forgiving:** "hey dec", "hay deck", "hi tech" etc. still wake it; a false wake does nothing unless a valid command follows.
- **Backoff:** if the speech service errors (offline etc.), restarts slow down (0.5s, 1s, 2s, 4s…, max 30s) and stop after 5 failures in a row, with a *Voice stopped. Tap to retry* button.
- **Push-to-talk interrupts the app:** pressing it stops the app's speech and un-mutes the mic. Wake-word mode mutes the mic while the app speaks so it doesn't hear itself.
- Chrome's speech recognition sends audio to Google's servers, so it needs internet, and wake-word mode keeps the mic open while a game is on. Accuracy in a noisy room is unmeasured; test it on your device.

## Voice speed: hybrid voice, cache, pipelining

First real-phone numbers (Android Chrome, wake word, Lazybird): **5.6s from transcript to first sound**, of which **4.3s was Lazybird** generating a 16-character line and 1.2s was an OpenRouter call because my grammar didn't recognise the phrase. So:

- **Hybrid voice (default).** Quick, functional lines (answers, spoken confirmations, errors, "X, you're up") are spoken instantly by **this device's own voice**. Only reactions ("Nice play") use Lazybird. Change it in Settings → *Voice mode*: *Hybrid*, *Lazybird for everything*, or *This device's voice only*. You can pick the device voice and speed there and test it. Without a Lazybird key everything uses the device voice.
- **Flavor lines never hold anything up.** A Lazybird reaction is requested immediately, plays whenever its audio is ready, and is dropped if a newer move happened in the meantime. A confirmation ("Sam draws 1") is now spoken before the reaction.
- **Pipelined.** Lazybird audio is requested as soon as a line is queued, not when it reaches the front, so two lines no longer wait on each other to download.
- **Cached.** Synthesized lines are stored in IndexedDB (about 150 lines / 15MB, oldest evicted). Repeating a line plays with no request. In the Timing panel each line shows `cache hit` or `miss`.
- **iOS.** The device-voice path uses the Web Speech synthesis built into WebKit, so it should work on iOS Safari. Both speech and audio must start from a tap, so the Start button does a silent "unlock". Not tested on a real iPhone. NFC and the wake-word mic still need the native wrapper on iOS (step 6).
- **What it heard.** The Timing panel lists the last 20 things the recognizer heard and how each was understood (*grammar*, *model*, or *no match*), so grammar misses are easy to spot and fix. It stays on screen: *Copy results* includes only counts unless you tick **Include what I said**.
- **Wake-word timing.** Chrome often sends no "speech ended" signal in wake-word mode, so recognizer time is now measured from the last partial result. Chatter without the wake word no longer leaks into the next command's timing.

## Real cards, dealing and deck size

The app can deal for you (a screen-only game, also handy for testing), or **you deal real cards** and the app only sees what you tap. Choose on the setup screen:

| Setup choice | What the app knows | What you do |
|---|---|---|
| **Real cards, count only** (default) | How many cards each player holds, derived from taps and declared draws. Every card played is tapped, so it always knows the pile. | Deal, flip the first card and tap it. Tap each card as you play it. Say or press *Draw* when you pick one up. |
| **Real cards, scan hands** | Counts, plus the identity of every card in a hand. It can then refuse a card that isn't yours and enforce "draw only if you can't play". | As above, plus everyone taps their cards when dealt and any card they draw. Scanning can be skipped at any time: the cards are then just counted. |
| **The app deals** | Everything. | Play on the screen. |

How it behaves with real cards:
- **The draw pile is derived**, not seen: cards in play, minus hands, minus the discard pile. When it runs short the app tells you to reshuffle the discard pile (keeping the top card).
- **Last card and winning come from the counts.** When someone's count reaches zero the table is asked to **confirm** they're out (or say they still have a card), because a missed *Draw* can make a count drift.
- **Scoring:** numbers are face value, Skip/Reverse/+2 are 20. After a confirmed win, tap the cards still in the other hands to score them, or finish. In scan mode cards the app already identified are scored automatically.
- **Mistakes:** *Undo last move* (or say "undo"), and *Fix a card count* for a forgotten *Draw*.
- **Cards in play is open-ended.** Type any number up to 52 (the highest numbers are dropped first, so 40 is numbers 1-10 in every shape), or choose the exact cards, for example when one has gone missing. The setup screen shows how the deal works out (cards each, cards left in the pile) and refuses a table that can't work. Your choice is remembered.
- **Without NFC** the simulator plays the people holding the cards: it deals real hands that the app never sees, so it is a fair test of the physical flow.

Design note: a hand is "cards the app has identified" plus "cards it hasn't". Count-only is the case where nothing is identified; scan hands identifies them; the app dealing identifies all of them. Future games (Go Fish, Spades) will use the same model and ask for the level of knowledge they need.

## Measuring voice latency

Every game screen has a **Timing** panel (hide it in Settings → *Show voice timing panel*). After a voice command it shows where the time went, from the moment you stop talking:

| Stage | What it is |
|---|---|
| Mic warm-up | Push-to-talk press → the recognizer is actually capturing |
| Recognizer finalize | You stop talking → Chrome returns the final transcript (it sends audio to Google's service and waits for a pause) |
| Parse command | Wake-word strip + grammar (the OpenRouter fallback time is recorded separately as `llmParseMs`) |
| Game action / Commentary text | Applying the move; picking the line (instant for built-in lines, an OpenRouter call for Live AI) |
| Speech queue wait | How long a line waited behind earlier lines. **Per line:** a voice command can speak two (a reaction, then a spoken confirmation); each is timed on its own and line 2 shows with a *(line 2)* suffix |
| Lazybird first byte / download | Request sent → response starts → audio fully downloaded |
| Playback start | Audio decoded → actually audible |
| Browser voice start | Same idea when the browser's built-in voice is used (no Lazybird key or Lazybird failed) |

Headline numbers: **end of speech → first sound**, **→ at the ear**, **→ screen update** and **→ all spoken lines done**, with median and p90 over the session. The slowest stage is highlighted. Each spoken line also shows when it became audible, how long it lasted, and the gap after the previous line.

**Output latency (speaker delay).** "First sound" is when the browser reports audio *playing*, which is before the sound leaves the device (Bluetooth adds a lot). Where Chrome reports the audio output latency (`outputLatency`, or derived from the output clock), the panel shows it and adds it to give an **"at the ear" estimate**. If the browser doesn't report it, the panel says so and shows no estimate: it is never guessed. The export records which source was used (`outputLatency`, `timestamp`, or `none`).

**Still not measured:** the true moment you stopped talking (the start point is Chrome's own "speech ended" signal, which fires after it hears silence, so real lag is probably longer), the wake word on its own (wake-word mode times the whole utterance), and the short feedback chimes.

**To share results:** play a round (try push-to-talk and wake word, with and without Live AI), tap **Copy results**, and paste the JSON into the chat. It contains timings, the voice path used (`lazybird`, `browser`, or `browser-after-lazybird-failed`) and your mic/commentary settings. It never contains your keys or what you said (only the command type).

Likely fixes, picked once the numbers show the biggest stage: act on interim results, play an instant "heard you" chime, cache the synthesized built-in lines, shorten clips, limit Live AI, and **fetch line 2's audio while line 1 is still playing** (today line 2 starts its Lazybird request only after line 1 finishes playing, so its queue wait is roughly line 1's whole duration).

## Deploy
`.github/workflows/pages.yml` publishes `dist/` to GitHub Pages on push to `main` (enable Pages → "GitHub Actions" in repo settings).

## Running log

Newest first. Add an entry with every push.

### 2026-10-05 (scoring review, play-on mode)
- **Scoring:** reviewed against the rules. Fixed: Skip, Reverse and +2 now score **20** each (were 10); numbers stay face value. A winning **+2** now makes the next player draw two before the points are counted (app-dealt: at once; real cards: when the table confirms the win). A Reverse with only two players left now correctly hands the turn back (it used the seat count, not who is still in).
- **Play on (last one holding cards loses):** new optional switch in Setup for 3+ players (off by default; remembered). When on, a player who goes out leaves the turn order and is placed 1st, 2nd, ...; the others keep playing (a +2 played to go out stays owed and can be stacked). When one player is left they lose and the round ends: the **first player out wins** and scores that last hand (real cards: tap its unidentified cards as usual). The screen shows who is out and who was left holding cards. With 2 players the switch does nothing. Game-night tally still counts the first-out winner. Simulated whole games (counts and scanned, 3 to 6 players) always end with a named loser and counts matching real cards.

### 2026-10-04 (audio cut-outs, draw pile restock)
- **Audio:** in wake-word mode the mic stayed open while the app spoke (only the transcripts were dropped), which on phones switches to call-style audio and cuts playback. The listener now really closes the mic while the app talks and reopens it ~350ms after, without counting that as a failure. Push-to-talk is unchanged. **Needs a real-phone check.** If it still clips, use push-to-talk.
- **Draw pile:** a 10-card deck at 2-3 players now has simulated whole-game checks (counts and scanned): hands + pile + discard always equal the deck, and every restock keeps the top card. New: the screen and voice say right away when the pile is empty and the discards need shuffling; restocks are counted and logged (also in app-dealt games); a draw with nothing left anywhere says the turn passes. 4+ players can't be dealt from 10 cards (the app refuses at setup).

### 2026-10-04 (left-out cards)
- **Fix:** "That card isn't in this game's deck" now says which card and why ("star-13 was left out of this game (40 cards in play)") and offers an **Add it to the deck** button. The usual cause is a remembered smaller "cards in play" count, which drops the highest numbers first. Setup's tag hint also warns when registered tags aren't in play. 242 unit tests; browser-tested.

### 2026-10-04 (setup remembers choices)
- **Setup:** the player count and the "Use real NFC taps" checkbox are now remembered between games. First time, NFC defaults on only if the phone supports Web NFC and at least one tag is registered; an explicit choice always wins, and an unsupported browser shows it disabled without losing the saved choice. A hint under the checkbox says how many cards in play have tags registered. 241 unit tests; browser-tested with a stubbed `NDEFReader`.

### 2026-10-04 (real cards + deck size)
- **Table model:** you can now play with real cards. Setup offers *Real cards, count only* (default), *Real cards, scan hands* and *The app deals*. The app tracks hand counts and the discard pile from taps, derives the draw pile, asks the table to confirm a win, scores leftover cards, and has Undo and a count-correction control. Scan mode adds card identities (it can refuse a card that isn't yours). A hand is now "identified cards + a count of unidentified ones", used by every mode.
- **Cards in play:** any number up to 52, or pick the exact cards (a lost card, a short deck); the setup screen previews the deal and blocks a table that can't work. The simulator plays pretend people holding real cards that the app never sees. 240 unit tests (including full simulated games checked against the real hands after every move) and 66 browser checks. Found and fixed along the way: an accessibility bug in the card picker (`aria-pressed`), two panels that collapsed after every tap, and a setup re-render that could swallow the tap on Start.
- Saved games moved to a new format (older saves are ignored).

### 2026-10-02 (hybrid voice + cache)
- **Voice speed:** first real-phone export showed 5.6s to first sound (Lazybird first byte 4.3s, plus a 1.2s OpenRouter call for a phrase the grammar missed). Added **hybrid voice** (quick lines on the device voice, personality via Lazybird, with a voice/speed picker and Voice mode setting), **pipelined** synthesis, an **IndexedDB audio cache**, **late flavor lines** that never block and are dropped when stale, confirmations spoken before reactions, the turn announcement as its own instant line, an **iOS unlock** on Start, an on-screen **heard-text** list (export is opt-in), interim-result timing for wake-word mode, and wider grammar (whose go, who's leading, how many do I have, what's showing…). 184 unit tests; 33 new browser checks against a mocked 4s Lazybird.

### 2026-10-02 (latency: lines + output latency)
- **Timing panel:** every spoken line is now traced separately (reaction, confirmation, answer), with when it became audible, how long it lasted, and the gap after the previous line. Added output-device latency (read from Chrome's audio clock when available, never guessed) and an "at the ear" estimate. "All lines done" is only shown once every line has finished. First finding from the mocked run: line 2's Lazybird request starts only after line 1 finishes playing, which makes its queue wait the slowest stage. 145 unit tests; browser-verified with a fake audio device reporting 120ms and one reporting none.

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
