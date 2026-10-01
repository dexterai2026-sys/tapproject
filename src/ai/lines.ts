import type { Rng } from '../engine/types';

export type Moment = 'turn' | 'play' | 'draw' | 'skip' | 'reverse' | 'drawTwo' | 'lastCall' | 'lastMissed' | 'win';

/** Pre-written, free-to-play lines. {name} = acting player, {next} = whoever is up, {card} = card played. */
export const LINES: Record<Moment, string[]> = {
  turn: [
    '{next}, you\'re up.', 'Your move, {next}.', '{next}, the table is yours.', 'Over to you, {next}.',
    '{next}, make it count.', 'Okay {next}, show us something.', '{next}, the cards are waiting.',
    'Next up: {next}.', '{next}, no pressure.', 'Whenever you\'re ready, {next}.',
    '{next}, time to shine.', 'Your turn, {next}. Breathe.', '{next}, what\'s the play?',
    'All eyes on {next}.', '{next}, take your time. Not too much time.', 'Here we go, {next}.',
    '{next}, the spotlight is yours.', 'Let\'s see it, {next}.', '{next}, deal us a good one.',
    'Step up, {next}.',
  ],
  play: [
    '{name} plays {card}.', 'Nice, {card}.', '{card}. Bold.', 'Down goes {card}.', '{name} drops {card}.',
    'Smooth, {name}.', '{card}, just like that.', 'Clean play, {name}.', '{name} lays down {card}.',
    'Okay, {card}.', 'Interesting choice, {name}.', '{card} hits the table.', 'Right on cue, {name}.',
    'That\'s a {card}.', '{name} knew exactly what to do.', 'Well played, {name}.', '{card}. Noted.',
    'Look at {name} go.', '{name} keeps it moving.', 'And {card} it is.',
  ],
  draw: [
    '{name} draws.', 'No luck, {name}. Draw.', 'Nothing to play. Pick one up, {name}.', 'Ouch. {name} draws.',
    '{name} comes up empty.', 'The deck owes you one, {name}.', 'A card for {name}.', 'Tough break, {name}.',
    '{name} fishes for a better hand.', 'Back to the pile, {name}.', '{name} reaches for the deck.',
    'It happens, {name}.', 'Nothing doing. {name} draws.', '{name} takes one for the team.',
    'Better luck next round, {name}.', 'The pile giveth, {name}.', '{name} draws and hopes.',
    'Hand getting heavy, {name}?', 'One more card for {name}.', '{name} digs deeper.',
  ],
  skip: ['{name} says not so fast!', 'Skipped! Sit this one out.', 'Someone loses a turn.', 'Skip! Ouch.', 'No turn for you!', 'Blocked!', 'Next player, you\'re benched.', 'Skipped, and it stings.'],
  reverse: ['Reverse! Going the other way.', 'The table turns around.', 'Switching directions!', 'Reverse, reverse!', 'Plot twist: backwards.', 'Other way, everyone.', 'Direction flipped!', 'And we spin it back.'],
  drawTwo: ['Plus two! Somebody\'s drawing.', 'Draw two incoming!', '{name} hits you with a plus two.', 'Ooh, a plus two.', 'Stack it or take it!', 'That\'s going to hurt.', 'Plus two, no mercy.', 'Brace yourself, {next}.'],
  lastCall: ['Last card!', '{name} is down to one!', 'One card left. Watch out.', 'Last card called, nicely done.', '{name} has one card left.', 'Careful, {name} is close.', 'The end is near for {name}.', 'One to go!'],
  lastMissed: ['{name} forgot to call last card. Draw two!', 'Caught! {name} draws two for staying quiet.', 'You have to say it, {name}. Two cards.', 'No call, no mercy. Draw two, {name}.', 'Missed the call, {name}. Penalty!', 'Silence costs two cards, {name}.', '{name} forgot the magic words.', 'Last card, uncalled. Two for {name}.'],
  win: ['{name} wins!', 'And that\'s the game. {name} wins!', 'Victory for {name}!', '{name} takes it!', 'Hands empty, {name} wins!', 'We have a winner: {name}.', 'Take a bow, {name}.', '{name} is the champion tonight.'],
};

export function fill(line: string, vars: Record<string, string>): string {
  return line.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}

/** Random pick per moment that never repeats the previous pick of that moment. */
export function createLinePicker(rng: Rng = Math.random) {
  const last = new Map<Moment, number>();
  return (moment: Moment, vars: Record<string, string>): string => {
    const pool = LINES[moment];
    let i = Math.floor(rng() * pool.length);
    if (pool.length > 1 && i === last.get(moment)) i = (i + 1) % pool.length;
    last.set(moment, i);
    return fill(pool[i] as string, vars);
  };
}
