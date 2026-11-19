#!/usr/bin/env node
/**
 * Validates `patches/manifest.json`.
 *
 * The point is not type checking for its own sake. It is that an incomplete patch
 * record is worse than none: it looks like control and is not. The two fields that
 * exist because of ecosystem experience, and not out of a taste for schemas, are:
 *
 * - `loss_condition`, because a patch that vanishes silently turns into a new bug
 *   months later without anyone connecting the two;
 * - `upstream_pr`, which accepts `null` but requires `notes` explaining why — a patch
 *   that should become a PR and never does is a fork starting slowly.
 *
 * And the pin: `upstream.pin` declares the commit that ALL patches apply
 * against. The rule looks bureaucratic and is not — it is what stops a patch
 * validated against a January commit from coexisting with another validated against
 * an August one, giving the impression that both were checked at the same time.
 *
 * No dependencies on purpose: it runs in CI with `node patches/validate.js`,
 * without `npm ci`.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TARGETS = ['skymp', 'skyrim-platform'];

/** Full commit SHA-1. */
const FULL_SHA = /^[0-9a-f]{40}$/i;
/** Acceptable SHA prefix: 7 characters is what `git log --oneline` shows. */
const SHA_PREFIX = /^[0-9a-f]{7,40}$/i;

const REQUIRED_STRINGS = [
  'id', 'target', 'file', 'upstream_commit', 'reason',
  'impact', 'loss_condition', 'removal_strategy', 'added'
];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validates the already-parsed manifest. `fileExists` is injected so the test does
 * not need to touch the disk.
 *
 * Returns `{ ok, errors }` instead of throwing: a manifest can have several
 * problems, and showing them all at once saves rounds.
 */
function validateManifest(manifest, { fileExists }) {
  const errors = [];
  const err = (msg) => errors.push(msg);

  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, errors: ['manifest.json is not an object'] };
  }
  if (manifest.version !== 1) {
    err(`version must be 1, got ${JSON.stringify(manifest.version)}`);
  }
  if (!Array.isArray(manifest.patches)) {
    return { ok: false, errors: errors.concat('patches must be a list') };
  }

  // The pin is only required when a patch exists. An empty manifest does not need
  // to declare what zero diffs apply against.
  const pin = manifest.upstream && manifest.upstream.pin;
  if (manifest.patches.length > 0) {
    if (!isNonEmptyString(pin) || !FULL_SHA.test(pin)) {
      err(
        'upstream.pin is required when there is a patch, and must be the full SHA-1 ' +
        'of the upstream commit all of them apply against'
      );
    }
  } else if (pin !== undefined && !FULL_SHA.test(String(pin))) {
    err('upstream.pin, when present, must be a full SHA-1');
  }

  const seen = new Set();

  manifest.patches.forEach((patch, i) => {
    const label = isNonEmptyString(patch && patch.id) ? `patches[${i}] (${patch.id})` : `patches[${i}]`;

    if (!patch || typeof patch !== 'object') {
      err(`${label}: is not an object`);
      return;
    }

    for (const field of REQUIRED_STRINGS) {
      if (!isNonEmptyString(patch[field])) {
        err(`${label}: required field "${field}" missing or empty`);
      }
    }

    if (isNonEmptyString(patch.id)) {
      if (seen.has(patch.id)) err(`${label}: duplicate id`);
      seen.add(patch.id);
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(patch.id)) {
        err(`${label}: id must be kebab-case`);
      }
    }

    if (patch.target !== undefined && !TARGETS.includes(patch.target)) {
      err(`${label}: target must be one of ${TARGETS.join(', ')}`);
    }

    if (isNonEmptyString(patch.file) && !fileExists(patch.file)) {
      err(`${label}: file "${patch.file}" does not exist`);
    }

    // Every patch points to the same commit. Two patches checked against
    // different commits in the same manifest is the situation the pin exists to
    // prevent: it looks like control and is not.
    if (isNonEmptyString(patch.upstream_commit)) {
      if (!SHA_PREFIX.test(patch.upstream_commit)) {
        err(`${label}: upstream_commit "${patch.upstream_commit}" does not look like a SHA (at least 7 hex)`);
      } else if (isNonEmptyString(pin) && FULL_SHA.test(pin)) {
        if (!pin.toLowerCase().startsWith(patch.upstream_commit.toLowerCase())) {
          err(
            `${label}: upstream_commit "${patch.upstream_commit}" does not match upstream.pin ` +
            `"${pin.slice(0, 12)}…". Raising the pin forces every patch to be re-evaluated`
          );
        }
      }
    }

    if (!Array.isArray(patch.files_touched) || patch.files_touched.length === 0) {
      err(`${label}: files_touched must be a non-empty list`);
    }

    // `test` may be null, but then `notes` must justify it. A patch with no
    // test and no justification is exactly what rule §34 forbids.
    if (!isNonEmptyString(patch.test) && patch.test !== null) {
      err(`${label}: test must be a string or null`);
    }
    if (patch.test === null && !isNonEmptyString(patch.notes)) {
      err(`${label}: test is null, so notes must explain why`);
    }

    // Same for upstream_pr: null is acceptable, silence is not.
    if (!Object.prototype.hasOwnProperty.call(patch, 'upstream_pr')) {
      err(`${label}: upstream_pr is required (use null with notes if it does not fit upstream)`);
    } else if (patch.upstream_pr !== null && !isNonEmptyString(patch.upstream_pr)) {
      err(`${label}: upstream_pr must be a URL or null`);
    } else if (patch.upstream_pr === null && !isNonEmptyString(patch.notes)) {
      err(`${label}: upstream_pr is null, so notes must explain why`);
    }

    if (isNonEmptyString(patch.added) && !/^\d{4}-\d{2}-\d{2}$/.test(patch.added)) {
      err(`${label}: added must be an ISO date (YYYY-MM-DD)`);
    }
  });

  return { ok: errors.length === 0, errors };
}

function main() {
  const dir = __dirname;
  const manifestPath = path.join(dir, 'manifest.json');

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    console.error(`[patches] Could not read manifest.json: ${e.message}`);
    process.exit(1);
  }

  const { ok, errors } = validateManifest(manifest, {
    fileExists: (rel) => fs.existsSync(path.join(dir, rel))
  });

  if (!ok) {
    console.error('[patches] invalid manifest.json:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const n = manifest.patches.length;
  console.log(
    n === 0
      ? '[patches] No patch registered — that is the preferred situation.'
      : `[patches] ${n} patch(es) registered, manifest valid.`
  );
}

if (require.main === module) main();

module.exports = { validateManifest };
