'use strict';

/**
 * Pure helpers for modifier-combo hotkeys (issue #1: "multi-button hotkeys").
 *
 * A binding is { vk, mods } where `vk` is the trigger key and `mods` is a list of
 * GENERIC modifier VKs (Ctrl=17, Alt=18, Shift=16, Win=91) that must be held when
 * the trigger fires. A generic modifier is satisfied by itself OR either physical
 * left/right variant, so "Alt + T" fires on either Alt. Bare-modifier bindings
 * (the historical default, e.g. Right Ctrl=163) simply have `mods: []`.
 *
 * No I/O, no globals — exercised directly by test/hotkey-match-test.js.
 */

// Generic modifier VK -> the physical VKs that satisfy it.
var MOD_VARIANTS = {
  16: [16, 160, 161], // Shift : VK_SHIFT / VK_LSHIFT / VK_RSHIFT
  17: [17, 162, 163], // Ctrl  : VK_CONTROL / VK_LCONTROL / VK_RCONTROL
  18: [18, 164, 165], // Alt   : VK_MENU / VK_LMENU / VK_RMENU
  91: [91, 92],       // Win   : VK_LWIN / VK_RWIN
};

/** The physical VKs that satisfy a (possibly generic) modifier vk. */
function variantsOf(vk) {
  return MOD_VARIANTS[vk] || [vk];
}

/** True if any of `vks` is currently held. @param {object} heldSet map {vk:true} */
function anyHeld(vks, heldSet) {
  for (var i = 0; i < vks.length; i++) {
    if (heldSet[vks[i]]) return true;
  }
  return false;
}

/**
 * Are ALL of a binding's modifiers currently held? Empty/missing mods => always
 * satisfied (bare-key or bare-modifier binding).
 * @param {number[]} mods generic modifier VKs
 * @param {object} heldSet map {vk:true} of physically-held keys
 */
function modsSatisfied(mods, heldSet) {
  if (!mods || !mods.length) return true;
  for (var i = 0; i < mods.length; i++) {
    if (!anyHeld(variantsOf(mods[i]), heldSet)) return false;
  }
  return true;
}

/**
 * Every VK the helper must watch for a binding to work: the trigger plus every
 * physical variant of each modifier (so their down/up events populate the held
 * set). De-duped number array.
 * @param {number} triggerVk
 * @param {number[]} [mods]
 * @returns {number[]}
 */
function watchKeysFor(triggerVk, mods) {
  var set = Object.create(null);
  set[triggerVk] = true;
  if (mods) {
    for (var i = 0; i < mods.length; i++) {
      var vs = variantsOf(mods[i]);
      for (var j = 0; j < vs.length; j++) set[vs[j]] = true;
    }
  }
  return Object.keys(set).map(Number);
}

module.exports = {
  variantsOf: variantsOf,
  modsSatisfied: modsSatisfied,
  watchKeysFor: watchKeysFor,
  MOD_VARIANTS: MOD_VARIANTS,
};
