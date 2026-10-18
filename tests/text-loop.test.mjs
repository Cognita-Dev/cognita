// Runaway repetition guard (providers.js): a model that writes the same sentence over and over is cut off.
import { findTextLoop, collapseTextLoops } from '../providers.js';

let bad = 0;
const t = (name, ok) => { console.log(name, ok ? 'OK' : 'FAIL'); if (!ok) bad++; };

const line = 'The subtitle is still too long. Let me make it even shorter and rebuild.';

// the exact failure from the screenshots: the same sentence glued together with no separator
const glued = 'Intro. ' + line.repeat(3);
t('glued repeats found', !!findTextLoop(glued));
t('glued repeats keep one copy', collapseTextLoops(glued) === 'Intro. ' + line);

// found while it is still being typed (stops mid-sentence)
const partial = line.repeat(40) + 'The subtitle is';
t('mid-sentence loop found', !!findTextLoop(line.repeat(3) + 'The subtitle is still too'));
t('long loop collapses to one copy', collapseTextLoops(line.repeat(40)) === line);
t('partial tail is not mistaken', collapseTextLoops(partial) === line.repeat(40) + 'The subtitle is' || collapseTextLoops(partial).length < partial.length);

// repeats separated by spaces or new lines
t('spaced repeats found', !!findTextLoop((line + ' ').repeat(3)));
t('line repeats found', !!findTextLoop((line + '\n').repeat(3)));

// text that must NOT be touched
t('two copies are fine', findTextLoop(line + ' ' + line) === null);
t('normal paragraph untouched', collapseTextLoops('Here is the plan. First we gather the data, then we clean it, then we chart it and write up what it shows.') === 'Here is the plan. First we gather the data, then we clean it, then we chart it and write up what it shows.');
t('dash rule untouched', findTextLoop('-'.repeat(200)) === null);
t('table separator untouched', findTextLoop('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |') === null);
t('short repeat untouched', findTextLoop('ha ha ha ha ha ha ha ha ha ha ha ha') === null);
t('empty and non-string safe', findTextLoop('') === null && findTextLoop(null) === null && collapseTextLoops(undefined) === '');

// speed: a long reply is checked on every chunk, so it must stay cheap
const big = 'abcdefghijklmnopqrstuvwxyz '.repeat(2) + Array.from({ length: 4000 }, (_, i) => 'word' + i).join(' ');
const t0 = Date.now();
for (let i = 0; i < 300; i++) findTextLoop(big);
t('300 checks of a long reply are quick', Date.now() - t0 < 2000);

process.exit(bad ? 1 : 0);
