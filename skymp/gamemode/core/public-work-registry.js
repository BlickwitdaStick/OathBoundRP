/**
 * Executable catalog of Public Work.
 *
 * A definition only gets in here when it has a physical route and concrete values.
 * Jobs approved in the documents do not get fictitious FormDesc/rewards:
 * incomplete content fails closed and does not show up as playable.
 */
'use strict';

const CODE_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const FORM_DESC_SHAPE = /^[0-9a-fA-F]+:.+\.(?:esm|esp|esl)$/i;
// The MVP only implements a persistent token, not a transferable item.
const CARGO_POLICIES = Object.freeze({ TOKEN: 'token' });
const _definitions = new Map();

function _positiveInt(value) { return Number.isSafeInteger(value) && value > 0; }
function _formDesc(value) {
  return typeof value === 'string' && value.length <= 128 && FORM_DESC_SHAPE.test(value);
}

function register(input) {
  const fail = message => { throw new Error(`[public-work-registry] ${message}`); };
  if (!input || typeof input !== 'object') fail('missing descriptor');
  const {
    code, label, boardFormDesc, originFormDesc, originLabel, destinationFormDesc, destinationLabel,
    rewardAmount, timeLimitSeconds, cooldownSeconds, cooldownGroup,
    cargoPolicy = CARGO_POLICIES.TOKEN
  } = input;

  if (!CODE_SHAPE.test(String(code)) || String(code).length > 32) fail(`invalid code '${code}'`);
  if (_definitions.has(code)) fail(`'${code}' registered twice`);
  if (typeof label !== 'string' || !label.trim() || label.length > 80) fail(`'${code}' has no valid label`);
  if (typeof originLabel !== 'string' || !originLabel.trim() || originLabel.length > 80) fail(`'${code}' has no valid originLabel`);
  if (typeof destinationLabel !== 'string' || !destinationLabel.trim() || destinationLabel.length > 80) fail(`'${code}' has no valid destinationLabel`);
  for (const [field, value] of Object.entries({ boardFormDesc, originFormDesc, destinationFormDesc })) {
    if (!_formDesc(value)) fail(`'${code}' has an invalid ${field}`);
  }
  if (!_positiveInt(rewardAmount) || rewardAmount > 1_000_000) fail(`'${code}' has an invalid rewardAmount`);
  if (!_positiveInt(timeLimitSeconds) || timeLimitSeconds < 60 || timeLimitSeconds > 86_400) fail(`'${code}' has an invalid timeLimitSeconds`);
  if (!_positiveInt(cooldownSeconds) || cooldownSeconds > 86_400) fail(`'${code}' has an invalid cooldownSeconds`);
  if (!CODE_SHAPE.test(String(cooldownGroup))) fail(`'${code}' has an invalid cooldownGroup`);
  if (!Object.values(CARGO_POLICIES).includes(cargoPolicy)) fail(`'${code}' has an invalid cargoPolicy`);
  if (originFormDesc === destinationFormDesc) fail(`'${code}' uses the same origin and destination`);

  const definition = Object.freeze({
    code, label: label.trim(), boardFormDesc,
    originFormDesc, originLabel: originLabel.trim(),
    destinationFormDesc, destinationLabel: destinationLabel.trim(),
    rewardAmount, timeLimitSeconds, cooldownSeconds, cooldownGroup, cargoPolicy
  });
  _definitions.set(code, definition);
  return definition;
}

function get(code) { return _definitions.get(code) || null; }
function list() { return [..._definitions.values()]; }
function listByBoard(boardFormDesc) {
  return list().filter(definition => definition.boardFormDesc === boardFormDesc);
}
function _reset() { _definitions.clear(); }

module.exports = { CARGO_POLICIES, register, get, list, listByBoard, _reset };
