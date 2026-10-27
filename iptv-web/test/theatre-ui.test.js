'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const theatreHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'movies.html'), 'utf8');

test('Theatre keeps playback source and episode controls visible beside the player', () => {
  assert.match(theatreHtml, /id="playerTools"[^>]*aria-label="Playback settings and episode list"/);
  assert.doesNotMatch(theatreHtml, /id="playerTools"[^>]*hidden/);
  assert.match(theatreHtml, /id="sourceSelect"/);
  assert.match(theatreHtml, /\.player-modal\.show\{display:flex;position:sticky;top:70px/);
  assert.match(theatreHtml, /id="playerToolsToggle"[^>]*aria-expanded="true"/);
  assert.match(theatreHtml, /id="playerToolsToggle"[^>]*aria-controls="playerTools"/);
  assert.match(theatreHtml, /function setPlayerTools\(open\)/);
  assert.match(theatreHtml, /playerBody'\)\.classList\.toggle\('tools-open',open\)/);
  assert.match(theatreHtml, /id="proxyToggle"/);
  assert.match(theatreHtml, /id="autoNext"/);
  assert.match(theatreHtml, /id="episodeSelect"/);
  assert.match(theatreHtml, /id="retry"/);
  assert.match(theatreHtml, /\.player-body\.tools-open/);
  assert.match(theatreHtml, /@media\(max-width:760px\)/);
});

test('Theatre provider selector requests the selected provider from the server', () => {
  assert.match(theatreHtml, /p\.set\('sourceId',state\.sourceFilter\)/);
  assert.match(theatreHtml, /providerOptions/);
});
test('Theatre does not render or load the unwanted preference-sharing section', () => {
  assert.doesNotMatch(theatreHtml, /visitor-discovery\.js/i);
  assert.doesNotMatch(theatreHtml, /Improve local resource discovery/i);
  assert.doesNotMatch(theatreHtml, /Share preferences/i);
  assert.doesNotMatch(theatreHtml, /I consent to sharing these broad preferences/i);
});

test('Theatre restores the last saved episode and playback position', () => {
  assert.match(theatreHtml, /async function loadAccountResume\(item\)/);
  assert.match(theatreHtml, /loadedmetadata/);
  assert.match(theatreHtml, /video\.currentTime=position/);
  assert.doesNotMatch(theatreHtml, /position:0,duration:0/);
});
