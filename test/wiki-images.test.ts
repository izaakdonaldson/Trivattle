import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWikiImageUrl, wikiImage } from '../src/wiki-images.js';
test('Wikimedia upload and thumb hosts both produce attributed image metadata', () => {
  for (const host of ['upload.wikimedia.org', 'thumb.wikimedia.org']) {
    const image = wikiImage(
      {
        thumbnail: { source: `https://${host}/wikipedia/commons/example.jpg` },
        pageimage: 'Example.jpg',
      },
      {
        descriptionurl: 'https://commons.wikimedia.org/wiki/File:Example.jpg',
        extmetadata: {
          Artist: { value: '<b>Photographer</b>' },
          LicenseShortName: { value: 'CC BY-SA 4.0' },
        },
      },
    );
    assert(image);
    assert.equal(image.attribution, 'Photographer');
    assert.equal(image.license, 'CC BY-SA 4.0');
  }
  for (const url of [
    'http://thumb.wikimedia.org/a',
    'https://thumb.wikimedia.org.evil.test/a',
    'https://example.org/a',
    'not a URL',
  ])
    assert.equal(isWikiImageUrl(url), false);
  assert.equal(wikiImage({}), null);
});
