import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatMapUploadLogLine,
  formatMapUploadLogPrefix,
} from '../../dist/map-uploader.js';

test('colorizes only map upload log prefix contents', () => {
  const originalNoColor = process.env.NO_COLOR;
  const originalLogColor = process.env.LOG_COLOR;
  delete process.env.NO_COLOR;
  delete process.env.LOG_COLOR;

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
  }
});

test('sanitizes control characters in map upload log lines', () => {
  const originalNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';

  try {
    const line = formatMapUploadLogLine('bad\nnode\x1b[31m', new Date('2026-06-17T19:14:03.245Z'));
    assert.equal(line, '[Map upload 21:14] bad\\x0anode\\x1b[31m');
  } finally {
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
  }
});
