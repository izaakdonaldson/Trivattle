import { test, expect, type Page } from '@playwright/test';
async function register(page: Page, name: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New here? Register' }).click();
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Email', { exact: true }).fill(`${name}-${Date.now()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'The collection.' })).toBeVisible();
  await expect(page.locator('.owned-item')).toHaveCount(0);
}
async function openPack(page: Page) {
  await page.getByRole('link', { name: /Packs/ }).click();
  await page.getByRole('button', { name: 'Open pack', exact: true }).click();
  await expect(page.locator('.pack-results .card')).toHaveCount(1);
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Next card' }).click();
  await page.getByRole('button', { name: 'Show all cards' }).click();
  await expect(page.locator('.pack-results .card')).toHaveCount(5);
  await page.getByRole('link', { name: 'View collection', exact: false }).click();
  await expect(page.getByRole('status')).toContainText('5 owned copies');
}
async function choose(page: Page) {
  for (let i = 0; i < 5; i++)
    await page.locator('.owned-item .card.selectable:not(.selected) .card-cover').first().click();
  await page.getByRole('button', { name: 'Move slot 1 right' }).click();
  await page.getByRole('button', { name: 'Ready', exact: true }).click();
}
test('two accounts privately select, reveal, reconnect, complete battle and retain cards', async ({
  browser,
}) => {
  const ca = await browser.newContext({ reducedMotion: 'reduce' }),
    cb = await browser.newContext({ reducedMotion: 'reduce' });
  const a = await ca.newPage(),
    b = await cb.newPage();
  const errors: string[] = [];
  a.on('pageerror', (e) => errors.push(e.message));
  b.on('pageerror', (e) => errors.push(e.message));
  try {
    await register(a, 'Alpha');
    await register(b, 'Bravo');
    await openPack(a);
    await openPack(b);
    await a.getByRole('link', { name: 'Battle', exact: true }).click();
    await a.getByRole('button', { name: 'Create Battle', exact: true }).click();
    await expect(a.locator('.join-code strong')).toBeVisible();
    const code = await a.locator('.join-code strong').innerText();
    await b.getByRole('link', { name: 'Battle', exact: true }).click();
    await b.getByLabel('Join code', { exact: true }).fill(code);
    await b.getByRole('button', { name: 'Join Battle', exact: true }).click();
    await expect(a.locator('.owned-item .card.selectable .card-cover').first()).toBeVisible();
    await choose(a);
    await expect(a.getByRole('button', { name: 'Unready to edit' })).toBeVisible();
    const room = await (await b.request.get('/api/lobbies/current')).json();
    expect(room.battle).toBeNull();
    expect(room.selection.every((x: unknown) => x === null)).toBe(true);
    expect(Object.keys(room.players[0]).sort()).toEqual(['connected', 'name', 'ready', 'slot']);
    await choose(b);
    await expect(a.locator('.online-arena .card')).toHaveCount(10);
    await expect(b.locator('.online-arena .card')).toHaveCount(10);
    await a.screenshot({ path: 'test-results/online-battle.png', fullPage: true });
    await expect(b.locator('.battle-center b')).toHaveText('Alpha’s turn');
    await expect(a.locator('.battle-center b')).toHaveText(
      'Choose an attacker, an attack, and a target.',
    );
    await a.locator('.own .card:not(.defeated) .move').first().click();
    await a.locator('.opponent .card:not(.defeated) .card-cover').first().click();
    await a.getByRole('button', { name: 'Confirm attack' }).click();
    await expect(a.getByRole('dialog', { name: 'Attack announcement' })).toBeVisible();
    await expect(a.locator('.attack-description strong')).toHaveCount(2);
    await expect(a.locator('.attack-description em')).toHaveCount(1);
    await expect(a.locator('.attack-preview .card')).toHaveCount(2);
    await a.screenshot({ path: 'test-results/attack-announcement.png' });
    await expect(b.locator('.answers')).toBeVisible();
    await expect(a.locator('.answers')).toBeVisible();
    await expect(a.locator('.answers button').first()).toBeDisabled();
    await b.reload();
    await expect(b.locator('.answers')).toBeVisible();
    await b.emulateMedia({ reducedMotion: 'no-preference' });
    const hpBefore = await b.locator('.own [role=meter]').first().getAttribute('aria-valuenow');
    await b.locator('.answers button').nth(1).click();
    await expect(b.locator('.answer-wrong')).toContainText('Selected');
    await expect(a.locator('.answer-wrong')).toContainText('Selected');
    await expect(b.locator('.own [role=meter]').first()).toHaveAttribute(
      'aria-valuenow',
      hpBefore!,
    );
    await b.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(b.locator('.own [role=meter]').first()).not.toHaveAttribute(
      'aria-valuenow',
      hpBefore!,
      { timeout: 15000 },
    );
    await expect(a.locator('.opponent [role=meter]').first()).toHaveAttribute(
      'aria-valuenow',
      hpBefore!,
    );
    await expect(b.locator('.battle-center b')).not.toHaveText('Resolving the attack…', {
      timeout: 15000,
    });
    await b.emulateMedia({ reducedMotion: 'reduce' });
    for (const p of [a])
      await expect(
        p
          .getByRole('button', { name: 'Continue', exact: true })
          .or(p.getByRole('button', { name: 'Find another battle' })),
      ).toBeVisible();
    for (let turn = 0; turn < 120; turn++) {
      for (const p of [a, b]) {
        const cont = p.getByRole('button', { name: 'Continue', exact: true });
        if (await cont.isVisible()) await cont.click();
      }
      if (await a.getByRole('button', { name: 'Find another battle' }).isVisible()) break;
      const snapshot = await (await a.request.get('/api/lobbies/current')).json();
      if (!snapshot?.battle) break;
      const actor = snapshot.battle.currentPlayer === snapshot.self ? a : b,
        defender = actor === a ? b : a;
      await actor.locator('.own .card:not(.defeated) .move').first().click();
      await actor.locator('.opponent .card:not(.defeated) .card-cover').first().click();
      await actor.getByRole('button', { name: 'Confirm attack' }).click();
      // Banks may exhaust; only a pending question opens a dialog for the defender.
      await expect
        .poll(async () => {
          const r = await (await actor.request.get(`/api/lobbies/${snapshot.id}`)).json();
          return r.battle.revision;
        })
        .toBeGreaterThan(snapshot.battle.revision);
      const after = await (await defender.request.get(`/api/lobbies/${snapshot.id}`)).json();
      if (after.battle.pending) {
        await expect(defender.locator('.answers')).toBeVisible();
        await defender
          .locator('.answers button')
          .nth(turn === 0 ? 0 : 1)
          .click();
        if (turn === 0) await expect(defender.locator('.answer-correct')).toContainText('Selected');
        for (const p of [a, b])
          await expect(
            p
              .getByRole('button', { name: 'Continue', exact: true })
              .or(p.getByRole('button', { name: 'Find another battle' })),
          ).toBeVisible();
      }
    }
    await expect(a.getByRole('button', { name: 'Find another battle' })).toBeVisible();
    await expect(b.getByRole('button', { name: 'Find another battle' })).toBeVisible();
    for (const p of [a, b]) {
      const collection = await (await p.request.get('/api/me/collection')).json();
      expect(collection.copies).toBe(5);
    }
    await a.getByRole('button', { name: 'Find another battle' }).click();
    await a.getByRole('button', { name: 'Create Battle', exact: true }).click();
    await expect(a.locator('.empty-slot')).toHaveCount(5);
    expect(errors).toEqual([]);
  } finally {
    await ca.close();
    await cb.close();
  }
});
test('mobile collection, normal-motion pack, skip and account persistence', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'no-preference',
  });
  const page = await context.newPage();
  try {
    await register(page, 'Mobile');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'The collection.' })).toBeVisible();
    await page.getByRole('link', { name: /Packs/ }).click();
    await page.getByRole('button', { name: 'Open pack', exact: true }).click();
    await expect(page.locator('.reveal-wrap.revealed').first()).toBeVisible();
    const nextBox = await page.getByRole('button', { name: 'Next card' }).boundingBox();
    const cardBox = await page.locator('.pack-results .card').boundingBox();
    expect(
      Math.abs(nextBox!.x + nextBox!.width / 2 - cardBox!.x - cardBox!.width / 2),
    ).toBeLessThan(2);
    expect(
      await page
        .locator('.reveal-wrap.revealed')
        .first()
        .evaluate((e) => getComputedStyle(e).animationName),
    ).toBe('reveal-gold');
    await expect(page.locator('.pack-results .card')).toHaveCount(1);
    for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Next card' }).click();
    await page.getByRole('button', { name: 'Show all cards' }).click();
    await expect(page.locator('.pack-results .card.legendary')).toHaveCount(5);
    const againBox = await page.getByRole('button', { name: 'Open another pack' }).boundingBox();
    expect(Math.abs(againBox!.x + againBox!.width / 2 - 195)).toBeLessThan(2);
    await page.screenshot({
      path: 'test-results/packs-mobile.png',
      fullPage: true,
      animations: 'disabled',
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await page.reload();
    await expect(page.getByText('2 packs remaining')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('lost pack response is recovered once after refresh', async ({ page }) => {
  await register(page, 'Recovery');
  await page.getByRole('link', { name: /Packs/ }).click();
  await page.route('**/api/me/pack-openings', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Open pack', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry request' })).toBeVisible();
  await page.unroute('**/api/me/pack-openings');
  await page.reload();
  await expect(page.locator('.pack-results .card')).toHaveCount(1);
  await expect(page.getByText('2 packs remaining')).toBeVisible();
  expect((await (await page.request.get('/api/me/collection')).json()).copies).toBe(5);
});

test('all cards is independent of an empty collection and supports filtering', async ({ page }) => {
  await register(page, 'Catalogue');
  await expect(page.getByRole('button', { name: 'View copies' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Sort cards' })).toHaveValue('rarity');
  await page.getByRole('link', { name: 'All cards', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'All cards.' })).toBeVisible();
  await expect(page.locator('.owned-item')).toHaveCount(15);
  await expect(page.locator('.owned-item .card').first()).toHaveClass(/legendary/);
  await page.getByRole('combobox', { name: 'Filter by rarity' }).selectOption('common');
  await expect(page.locator('.owned-item')).toHaveCount(7);
  await page.locator('.card-info').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Collection', exact: true }).click();
  await expect(page.locator('.owned-item')).toHaveCount(0);
});
