'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const transcode = require('../lib/transcode');

test('transcode detection is limited to direct legacy video containers', () => {
  assert.equal(transcode.needsTranscode('https://media.example/movie.mkv'), true);
  assert.equal(transcode.needsTranscode('https://media.example/movie.avi?token=x'), true);
  assert.equal(transcode.needsTranscode('https://media.example/movie.flv'), true);
  assert.equal(transcode.needsTranscode('https://media.example/movie.mp4'), false);
  assert.equal(transcode.needsTranscode('https://media.example/live/index.m3u8'), false);
  assert.equal(transcode.needsTranscode('file:///etc/passwd'), false);
  assert.equal(transcode.needsTranscode('/movie.mkv'), false);
});

test('ffmpeg input is piped and output is browser-compatible fragmented MP4', () => {
  const args = transcode.ffmpegArgs();
  assert.equal(args[args.indexOf('-i') + 1], 'pipe:0');
  assert.equal(args[args.indexOf('-f') + 1], 'mp4');
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  assert.ok(args.includes('pipe:1'));
  assert.ok(args.includes('pipe,crypto,data'), 'FFmpeg network protocols must be disabled for piped input');
});
