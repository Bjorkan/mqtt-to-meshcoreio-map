import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatMapUploadLogLine,
  formatMapUploadLogPrefix,
} from '../../dist/map-uploader.js';

test('colorizes only map upload log prefix contents', () => {
  const originalNoColor = process.env.NO_COLOR;
  const originalLogColor = process.env.LOG_COLOR;
  const originalTimeZone = process.env.TZ;
  delete process.env.NO_COLOR;
  delete process.env.LOG_COLOR;
  process.env.TZ = 'Europe/Stockholm';

  try {
    assert.equal(
      formatMapUploadLogPrefix(new Date('2026-06-17T19:14:03.245Z')),
      '[\x1b[36mMap upload 21:14\x1b[0m]'
    );

    process.env.NO_COLOR = '1';
    assert.equal(
      formatMapUploadLogPrefix(new Date('2026-06-17T19:14:03.245Z')),
      '[Map upload 21:14]'
    );
  } finally {
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }

    if (originalLogColor === undefined) {
      delete process.env.LOG_COLOR;
    } else {
      process.env.LOG_COLOR = originalLogColor;
    }

    if (originalTimeZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTimeZone;
    }
  }
});

test('uses TZ for map upload log timestamps', () => {
  const originalNoColor = process.env.NO_COLOR;
  const originalTimeZone = process.env.TZ;
  process.env.NO_COLOR = '1';
  process.env.TZ = 'UTC';

  try {
    assert.equal(
      formatMapUploadLogPrefix(new Date('2026-06-17T19:14:03.245Z')),
      '[Map upload 19:14]'
    );
  } finally {
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }

    if (originalTimeZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTimeZone;
    }
  }
});

test('sanitizes control characters in map upload log lines', () => {
  const originalNoColor = process.env.NO_COLOR;
  const originalTimeZone = process.env.TZ;
  process.env.NO_COLOR = '1';
  process.env.TZ = 'Europe/Stockholm';

  try {
    const line = formatMapUploadLogLine('bad\nnode\x1b[31m', new Date('2026-06-17T19:14:03.245Z'));
    assert.equal(line, '[Map upload 21:14] bad\\x0anode\\x1b[31m');
  } finally {
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }

    if (originalTimeZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTimeZone;
    }
  }
});
