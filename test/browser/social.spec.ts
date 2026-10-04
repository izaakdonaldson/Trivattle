import { test, expect, type Page } from '@playwright/test';
import { setTimeout as delay } from 'node:timers/promises';
async function register(page: Page, name: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New here? Register' }).click();
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Email', { exact: true }).fill(name + Date.now() + '@example.com');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  // The suite shares one loopback IP and deliberately retains production auth limits.
  // Respect Retry-After when earlier tests consumed the signup window.
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = page.waitForResponse((r) => r.url().endsWith('/sign-up/email'));
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    const result = await response;
    if (result.status() !== 429) {
      expect(result.status()).toBe(200);
      break;
    }
    await delay((Number(result.headers()['retry-after']) || 10) * 1000 + 100);
  }
  await expect(page.getByRole('heading', { name: 'The collection.' })).toBeVisible();
}
async function open(page: Page) {
  await page.getByRole('link', { name: /Packs/ }).click();
  await page.getByRole('button', { name: 'Open pack', exact: true }).click();
  await expect(page.locator('.pack-results .card')).toHaveCount(1);
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Next card' }).click();
  await page.getByRole('button', { name: 'Show all cards' }).click();
  await expect(page.locator('.pack-results .card')).toHaveCount(5);
}
async function confirm(page: Page) {
  await page.getByRole('button', { name: 'Review exchange', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm this exact exchange' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm this exchange', exact: true }).click();
}
test('friends, reviewed trades, multi-tab reconnection, received-card battles and offline pack regeneration', async ({
  browser,
  request,
}) => {
  test.setTimeout(180000);
  const ca = await browser.newContext({ reducedMotion: 'reduce' }),
    cb = await browser.newContext({ reducedMotion: 'reduce' }),
    cc = await browser.newContext();
  const a = await ca.newPage();
  let b = await cb.newPage();
  const c = await cc.newPage();
  const errors: string[] = [];
  for (const p of [a, b]) p.on('pageerror', (e) => errors.push(e.message));
  try {
    await register(a, 'TraderA');
    await register(b, 'TraderB');
    await register(c, 'Outsider');
    await a.getByRole('link', { name: /^Friends/ }).click();
    await b.getByRole('link', { name: /^Friends/ }).click();
    const code = await b.getByTestId('friend-code').innerText();
    await a.getByLabel('Friend code', { exact: true }).fill(code.toLowerCase());
    await a.getByRole('button', { name: 'Find player' }).click();
    await a.getByRole('button', { name: 'Add friend', exact: true }).click();
    await b.getByRole('button', { name: 'Accept', exact: true }).click();
    for (const p of [a, b])
      await expect(p.getByRole('button', { name: 'Trade', exact: true })).toBeVisible();
    await open(a);
    await open(b);
    const originalA = await (await a.request.get('/api/me/collection')).json();
    const originalB = await (await b.request.get('/api/me/collection')).json();
    await a.getByRole('link', { name: /^Friends/ }).click();
    await a.getByRole('button', { name: 'Trade', exact: true }).click();
    await expect(a.getByRole('heading', { name: 'Invitation sent' })).toBeVisible();
    const id = a.url().split('/').at(-1)!;
    expect((await c.request.get('/api/trades/' + id)).status()).toBe(404);
    await b.getByRole('link', { name: /^Trades/ }).click();
    await b.locator('.trade-link').first().click();
    await b.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(a.locator('.trade-picker')).toBeVisible();
    await a.locator('.trade-picker .card-cover:not(:disabled)').first().click();
    await b.locator('.trade-picker .card-cover:not(:disabled)').first().click();
    await expect(a.getByRole('region', { name: 'Their offer' }).locator('.card')).toHaveCount(1);
    await confirm(a);
    await expect(a.getByRole('button', { name: 'You confirmed', exact: true })).toBeVisible();
    await b.locator('.trade-picker .card-cover:not(:disabled)').first().click();
    await expect(a.getByRole('button', { name: 'Review exchange', exact: true })).toBeEnabled();
    await b
      .getByRole('button', { name: /Remove offered/ })
      .last()
      .click();
    await confirm(a);
    const extra = await cb.newPage();
    await extra.goto('/#/trades/' + id);
    await expect(extra.locator('.trade-picker')).toBeVisible();
    await b.close();
    await expect(a.getByRole('button', { name: 'You confirmed', exact: true })).toBeVisible();
    await extra.close();
    await expect(a.getByRole('button', { name: 'Review exchange', exact: true })).toBeDisabled();
    b = await cb.newPage();
    await b.goto('/#/trades/' + id);
    await expect(a.getByRole('button', { name: 'Review exchange', exact: true })).toBeEnabled();
    await expect(b.getByRole('region', { name: 'Your offer' }).locator('.card')).toHaveCount(1);
    await a.setViewportSize({ width: 390, height: 844 });
    await a.screenshot({ path: 'test-results/trade-mobile.png', fullPage: true });
    expect(await a.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await a.setViewportSize({ width: 1440, height: 1100 });
    await confirm(a);
    await expect(
      b.getByRole('region', { name: 'Their offer' }).locator('.confirmed'),
    ).toBeVisible();
    await confirm(b);
    for (const p of [a, b])
      await expect(p.locator('.page-heading [role=status]')).toHaveText('Trade completed');
    const trade = await (await a.request.get('/api/trades/' + id)).json();
    expect(JSON.stringify(trade)).not.toContain('correctIndex');
    const givenA = trade.players[0].cards[0].id,
      givenB = trade.players[1].cards[0].id;
    const afterA = await (await a.request.get('/api/me/collection')).json(),
      afterB = await (await b.request.get('/api/me/collection')).json();
    expect(afterA.cards.map((v: { id: string }) => v.id)).toContain(givenB);
    expect(afterB.cards.map((v: { id: string }) => v.id)).toContain(givenA);
    expect(afterA.copies).toBe(originalA.copies);
    expect(afterB.copies).toBe(originalB.copies);
    await a.getByRole('link', { name: /Trade history/ }).click();
    await expect(a.locator('.trade-link')).toContainText('completed');
    await a.getByRole('link', { name: 'Battle', exact: true }).click();
    await a.getByRole('button', { name: 'Create Battle', exact: true }).click();
    const roomCode = await a.locator('.join-code strong').innerText();
    await b.getByRole('link', { name: 'Battle', exact: true }).click();
    await b.getByLabel('Join code', { exact: true }).fill(roomCode);
    await b.getByRole('button', { name: 'Join Battle', exact: true }).click();
    for (const p of [a, b]) {
      for (let i = 0; i < 5; i++)
        await p.locator('.owned-item .card-cover:not(:disabled)').first().click();
      await p.getByRole('button', { name: 'Ready', exact: true }).click();
    }
    await expect(a.locator('.online-arena .card')).toHaveCount(10);
    for (let turn = 0; turn < 120; turn++) {
      for (const p of [a, b]) {
        const cont = p.getByRole('button', { name: 'Continue', exact: true });
        if (await cont.isVisible()) await cont.click();
      }
      if (await a.getByRole('button', { name: 'Find another battle' }).isVisible()) break;
      const room = await (await a.request.get('/api/lobbies/current')).json();
      if (!room?.battle) break;
      const actor = room.battle.currentPlayer === room.self ? a : b,
        defender = actor === a ? b : a;
      await actor.locator('.own .card:not(.defeated) .move').first().click();
      await actor.locator('.opponent .card:not(.defeated) .card-cover').first().click();
      await actor.getByRole('button', { name: 'Confirm attack' }).click();
      await expect
        .poll(
          async () =>
            (await (await actor.request.get('/api/lobbies/' + room.id)).json()).battle.revision,
        )
        .toBeGreaterThan(room.battle.revision);
      const latest = await (await defender.request.get('/api/lobbies/' + room.id)).json();
      if (latest.battle.pending) {
        await defender.locator('.answers button').nth(1).click();
        for (const p of [a, b])
          await expect(
            p
              .getByRole('button', { name: 'Continue', exact: true })
              .or(p.getByRole('button', { name: 'Find another battle' })),
          ).toBeVisible();
      }
    }
    await expect(a.getByRole('button', { name: 'Find another battle' })).toBeVisible();
    await a.getByRole('button', { name: 'Find another battle' }).click();
    await a.getByRole('link', { name: /Packs/ }).click();
    await expect(a.locator('.pack-countdown')).toContainText('Next free pack');
    await request.post('/__test/clock', { data: { advance: 300000 } });
    const accrued = await (await a.request.get('/api/me/packs')).json();
    expect(accrued.packs).toBe(3);
    expect(accrued.nextPackAt).toBeNull();
    await a.reload();
    await expect(a.locator('.pack-countdown')).toContainText('Packs Full');
    await a.getByRole('button', { name: 'Open pack', exact: true }).click();
    await expect(a.locator('.pack-countdown')).toContainText('Next free pack');
    await ca.setOffline(true);
    await request.post('/__test/clock', { data: { advance: 3600000 } });
    await ca.setOffline(false);
    await a.reload();
    await expect(a.locator('.pack-countdown')).toContainText('Your packs: 3 / 3');
    expect(errors).toEqual([]);
  } finally {
    await request.post('/__test/clock', { data: { reset: true } });
    await ca.close();
    await cb.close();
    await cc.close();
  }
});
