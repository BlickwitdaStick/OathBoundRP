'use strict';

function normalizeLoadOrder(value) {
  if (!Array.isArray(value)) return null;
  return value.map(entry => String(entry).trim().toLowerCase());
}

function verifyRuntimeCompatibility(mpApi) {
  if (!mpApi || typeof mpApi.getServerSettings !== 'function') {
    throw new Error('[compat] mp.getServerSettings unavailable in the SkyMP binary.');
  }
  if (typeof mpApi.getEspmLoadOrder !== 'function') {
    throw new Error('[compat] mp.getEspmLoadOrder unavailable in the SkyMP binary.');
  }

  const settings = mpApi.getServerSettings();
  const expected = normalizeLoadOrder(settings && settings.loadOrder);
  const actual = normalizeLoadOrder(mpApi.getEspmLoadOrder());
  if (!expected || expected.length === 0) {
    throw new Error('[compat] server settings have no valid loadOrder.');
  }
  if (!actual || actual.length === 0) {
    throw new Error('[compat] SkyMP did not report the effective load order.');
  }

  const same = expected.length === actual.length
    && expected.every((plugin, index) => plugin === actual[index]);
  if (!same) {
    throw new Error(
      `[compat] effective load order differs from the configured one: expected=${expected.join(',')} effective=${actual.join(',')}`
    );
  }

  return { loadOrder: actual, settings };
}

module.exports = { normalizeLoadOrder, verifyRuntimeCompatibility };
