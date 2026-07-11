'use strict';

/**
 * Plain-node unit tests for src/main/hotkey-match.js (issue #1 combo matching).
 * Run: `node test/hotkey-match-test.js` — exits non-zero on any failure.
 */

const assert = require('assert');
const { variantsOf, modsSatisfied, watchKeysFor } = require('../src/main/hotkey-match');

let passed = 0;
let failed = 0;

function ok(cond, label) {
  try { assert.ok(cond); passed++; }
  catch (e) { failed++; console.error('FAIL: ' + label); }
}
function eqSet(actual, expected, label) {
  const a = actual.slice().sort(function (x, y) { return x - y; });
  const b = expected.slice().sort(function (x, y) { return x - y; });
  try { assert.deepStrictEqual(a, b); passed++; }
  catch (e) {
    failed++;
    console.error('FAIL: ' + label);
    console.error('  expected: ' + JSON.stringify(b));
    console.error('  actual:   ' + JSON.stringify(a));
  }
}

function held() {
  var m = Object.create(null);
  for (var i = 0; i < arguments.length; i++) m[arguments[i]] = true;
  return m;
}

// ---- variantsOf --------------------------------------------------------------
eqSet(variantsOf(18), [18, 164, 165], 'variantsOf: Alt -> generic + L/R');
eqSet(variantsOf(17), [17, 162, 163], 'variantsOf: Ctrl -> generic + L/R');
eqSet(variantsOf(91), [91, 92], 'variantsOf: Win -> L/R');
eqSet(variantsOf(84), [84], 'variantsOf: a non-modifier -> just itself');

// ---- modsSatisfied -----------------------------------------------------------
ok(modsSatisfied([], held()) === true, 'mods: empty is always satisfied');
ok(modsSatisfied(null, held()) === true, 'mods: null is always satisfied');
ok(modsSatisfied([18], held(164)) === true, 'mods: Alt satisfied by LEFT alt (164)');
ok(modsSatisfied([18], held(165)) === true, 'mods: Alt satisfied by RIGHT alt (165)');
ok(modsSatisfied([18], held(18)) === true, 'mods: Alt satisfied by generic alt (18)');
ok(modsSatisfied([18], held(162)) === false, 'mods: Alt NOT satisfied by ctrl');
ok(modsSatisfied([18], held()) === false, 'mods: Alt not satisfied when nothing held');
ok(modsSatisfied([17, 16], held(162, 160)) === true, 'mods: Ctrl+Shift satisfied by L-ctrl + L-shift');
ok(modsSatisfied([17, 16], held(162)) === false, 'mods: Ctrl+Shift NOT satisfied with only ctrl');

// ---- watchKeysFor ------------------------------------------------------------
eqSet(watchKeysFor(163, []), [163], 'watch: bare Right Ctrl -> just 163');
eqSet(watchKeysFor(84, [18]), [84, 18, 164, 165], 'watch: Alt+T -> T plus all alt variants');
eqSet(watchKeysFor(84, [17, 16]), [84, 17, 162, 163, 16, 160, 161],
   'watch: Ctrl+Shift+T -> T plus all ctrl and shift variants');

// ---- summary -----------------------------------------------------------------
console.log('hotkey-match-test: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
process.exit(0);
