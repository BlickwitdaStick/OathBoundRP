const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { isDiscordSnowflake } = require('./inputValidation');

describe('Discord input validation', () => {
    it('accepts decimal snowflakes within the supported length', () => {
        assert.equal(isDiscordSnowflake('12345678901234567'), true);
        assert.equal(isDiscordSnowflake('12345678901234567890'), true);
    });

    it('rejects invalid types, characters and lengths', () => {
        for (const value of [null, 123, '', '1234567890123456', '123456789012345678901', '1234567890123456a']) {
            assert.equal(isDiscordSnowflake(value), false, String(value));
        }
    });
});
