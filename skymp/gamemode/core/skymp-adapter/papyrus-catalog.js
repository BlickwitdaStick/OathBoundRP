/**
 * core/skymp-adapter/papyrus-catalog.js
 *
 * The Papyrus functions the SkyMP server actually implements.
 *
 * ─── How this list was made, and why it exists ──────────────────────────────
 *
 * Extracted from `skymp5-server/cpp/server_guest_lib/script_classes/Papyrus*.cpp`
 * at commit `d85f18d8` — the `AddMethod(vm, "Name", …)` and
 * `AddStatic(vm, "Name", …)` calls. 128 entries.
 *
 * Calling any name outside this list **does not throw**: the VM logs an error and returns
 * `VarValue::None()`, which reaches JavaScript as `null`. And `null <= 0` is
 * `true`, so a missing function does not produce an error — it produces a wrong decision.
 *
 * That is how `death-service.js` started knocking down every connected player within
 * two seconds by calling `Actor.GetActorValue`, which does not exist. See
 * docs/research/SKYMP_INTEGRATION_AUDIT.md §4.
 *
 * ─── This list ages ──────────────────────────────────────────────────────────
 *
 * It is valid for one commit. When the pin in `patches/manifest.json` moves up, it
 * has to be redone — the command is in
 * docs/technical/SKYMP_COMPATIBILITY_MATRIX.md §4.1.
 *
 * The adapter prefers runtime reflection (`mp._sp3GetFunctionImplementation`)
 * when it exists, precisely so it does not depend on this file. The list is the
 * fallback, not the authority.
 *
 * Lowercase names because the VM uses `CIString`: lookups are case-insensitive.
 */

'use strict';

/** Metodos — `callType: 'method'`. */
const METHODS = new Set([
  'actor.addspell',
  'actor.addtofaction',
  'actor.damageactorvalue',
  'actor.drawweapon',
  'actor.equipitem',
  'actor.equipitemex',
  'actor.equipspell',
  'actor.getactorvaluepercentage',
  'actor.getfactions',
  'actor.getnthspell',
  'actor.getrace',
  'actor.getsitstate',
  'actor.getspellcount',
  'actor.isdead',
  'actor.isequipped',
  'actor.isinfaction',
  'actor.isweapondrawn',
  'actor.playidle',
  'actor.removefromfaction',
  'actor.removespell',
  'actor.restoreactorvalue',
  'actor.setactorvalue',
  'actor.setalpha',
  'actor.setdontmove',
  'actor.unequipall',
  'actor.unequipitem',
  'actor.wornhaskeyword',
  'book.getspell',
  'cell.isattached',
  'cell.isinterior',
  'effectbase.play',
  'effectbase.stop',
  'faction.getreaction',
  'form.getformid',
  'form.getname',
  'form.gettype',
  'form.getweight',
  'form.haskeyword',
  'form.registerforsingleupdate',
  'formlist.find',
  'formlist.getat',
  'formlist.getsize',
  'leveledbase.getnthform',
  'message.show',
  'objectreference.activate',
  'objectreference.additem',
  'objectreference.blockactivation',
  'objectreference.delete',
  'objectreference.disable',
  'objectreference.disablenowait',
  'objectreference.enable',
  'objectreference.enablenowait',
  'objectreference.getallitemscount',
  'objectreference.getanimationvariablebool',
  'objectreference.getbaseobject',
  'objectreference.getdistance',
  'objectreference.getitemcount',
  'objectreference.getlinkedref',
  'objectreference.getnthlinkedref',
  'objectreference.getopenstate',
  'objectreference.getparentcell',
  'objectreference.getpositionx',
  'objectreference.getpositiony',
  'objectreference.getpositionz',
  'objectreference.getscale',
  'objectreference.gettotalitemweight',
  'objectreference.is3dloaded',
  'objectreference.isactivationblocked',
  'objectreference.iscontainerempty',
  'objectreference.isdeleted',
  'objectreference.isdisabled',
  'objectreference.isharvested',
  'objectreference.moveto',
  'objectreference.placeatme',
  'objectreference.playanimation',
  'objectreference.playanimationandwait',
  'objectreference.playgamebryoanimation',
  'objectreference.removeallitems',
  'objectreference.removeitem',
  'objectreference.setangle',
  'objectreference.setdisplayname',
  'objectreference.setopen',
  'objectreference.setposition',
  'objectreference.setscale',
  'potion.isfood',
  'quest.getcurrentstageid',
  'quest.getstage',
  'sound.play',
]);

/** Estaticas — `callType: 'global'`. */
const STATICS = new Set([
  'debug.messagebox',
  'debug.notification',
  'debug.sendanimationevent',
  'debug.trace',
  'game.disableplayercontrols',
  'game.enableplayercontrols',
  'game.findclosestreferenceofanytypeinlistfromref',
  'game.findclosestreferenceoftypefromref',
  'game.forcethirdperson',
  'game.getcamerastate',
  'game.getform',
  'game.getformex',
  'game.getplayer',
  'game.incrementstat',
  'game.shakecontroller',
  'game.showlimitedracemenu',
  'game.showracemenu',
  'keyword.getkeyword',
  'netimmerse.setnodescale',
  'netimmerse.setnodetextureset',
  'skymp.setdefaultactor',
  'utility.createaliasarray',
  'utility.createboolarray',
  'utility.createfloatarray',
  'utility.createformarray',
  'utility.createintarray',
  'utility.gametimetostring',
  'utility.getcurrentgametime',
  'utility.getcurrentrealtime',
  'utility.isinmenumode',
  'utility.randomfloat',
  'utility.randomint',
  'utility.resizealiasarray',
  'utility.resizeboolarray',
  'utility.resizefloatarray',
  'utility.resizeformarray',
  'utility.resizeintarray',
  'utility.wait',
  'utility.waitgametime',
  'utility.waitmenumode',
]);

/** Upstream commit the list was extracted from. */
const UPSTREAM_COMMIT = 'd85f18d808f877401c4e20484d2c2f6f73cf9caa';

/**
 * @param {'method'|'global'} callType
 * @param {string} className
 * @param {string} functionName
 * @returns {boolean}
 */
function isKnownPapyrusFunction(callType, className, functionName) {
  const chave = `${className}.${functionName}`.toLowerCase();
  if (callType === 'method') return METHODS.has(chave);
  if (callType === 'global') return STATICS.has(chave);
  return false;
}

module.exports = { METHODS, STATICS, UPSTREAM_COMMIT, isKnownPapyrusFunction };
