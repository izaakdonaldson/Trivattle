import { test, expect, type Page } from '@playwright/test';
async function attack(page: Page) {
  await page.locator('.own .card:not(.defeated) .card-cover').first().click();
  await page.locator('.own .card.selected .move').first().click();
  await page.locator('.opponent .card:not(.defeated) .card-cover').first().click();
  await page.getByRole('button', { name: 'Confirm attack' }).click();
  await expect(page.locator('dialog')).toBeVisible();
}
async function defend(page: Page) {
  await page.getByRole('button', { name: 'Ready for Trivia' }).click();
  await page.locator('.answers button').nth(1).click();
  await expect(page.locator('.result-icon')).toBeVisible();
}
test('team setup, inspection, keyboard handoff, full battle and rematch', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('10 cards', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Inspect Fixture Observatory 1', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('base power');
  await page.keyboard.press('Escape');
  for (let i = 0; i < 5; i++)
    await page.getByRole('button', { name: 'Add to Player 1' }).nth(i).click();
  await page.getByRole('button', { name: 'Player 2', exact: false }).first().click();
  for (let i = 0; i < 5; i++)
    await page
      .getByRole('button', { name: 'Add to Player 2' })
      .nth(i + 5)
      .click();
  await page.getByRole('button', { name: 'Enter the arena' }).click();
  await expect(page.locator('.battle-slot')).toHaveCount(10);
  await attack(page);
  await expect(page.locator('.answers')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Ready for Trivia' })).toBeVisible();
  await defend(page);
  await expect(page.getByText('The correct answer', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Continue to Player' }).click();
  let turns = 0;
  while (
    !(await page.getByRole('button', { name: 'Rematch', exact: true }).count()) &&
    turns++ < 90
  ) {
    await attack(page);
    if (await page.getByRole('button', { name: 'Ready for Trivia' }).count()) await defend(page);
    await expect(page.locator('dialog')).toBeVisible();
    const next = page.getByRole('button', { name: 'Continue to Player' });
    if (await next.count()) await next.click();
  }
  await expect(page.getByRole('button', { name: 'Rematch', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/victory.png', fullPage: true });
  await page.getByRole('button', { name: 'Rematch', exact: true }).click();
  await expect(page.locator('.turn-chip')).toContainText('TURN 1');
  await expect(page.locator('.defeated')).toHaveCount(0);
});
test('mobile, rarity visuals, type crops and reduced motion', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.card')).toHaveCount(10);
  await page.screenshot({ path: 'test-results/catalogue-desktop.png', fullPage: true });
  for (const rarity of ['common', 'uncommon', 'rare', 'epic', 'legendary'])
    await expect(page.locator(`.card.${rarity}`).first()).toBeVisible();
  await page.getByRole('button', { name: 'Quick battle' }).click();
  await page.screenshot({ path: 'test-results/battle-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/battle-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(
    await page
      .locator('.card')
      .first()
      .evaluate((e) => getComputedStyle(e).transform),
  ).toBe('none');
});
test('exhaustion feedback and expired match recovery', async ({ page, request }) => {
  const cards = await (await request.get('/api/cards')).json();
  const id = cards.cards[0].versionId;
  let battle = await (
    await request.post('/api/battles', { data: { teams: [Array(5).fill(id), Array(5).fill(id)] } })
  ).json();
  for (let i = 0; i < 12; i++) {
    const p = battle.players.indexOf(battle.currentPlayer),
      a = battle.teams[p].find((u: any) => u.hp > 0),
      t = battle.teams[1 - p].find((u: any) => u.hp > 0);
    battle = await (
      await request.post(`/api/battles/${battle.id}/commands`, {
        data: {
          kind: 'attack',
          commandId: `a${i}`,
          revision: battle.revision,
          playerId: battle.currentPlayer,
          attackerId: a.instanceId,
          attackId: a.card.attacks[0].id,
          targetId: t.instanceId,
        },
      })
    ).json();
    battle = await (
      await request.post(`/api/battles/${battle.id}/commands`, {
        data: {
          kind: 'answer',
          commandId: `q${i}`,
          revision: battle.revision,
          playerId: battle.pending.defenderId,
          questionId: battle.pending.question.id,
          answerIndex: 0,
        },
      })
    ).json();
  }
  await page.goto('/');
  await page.evaluate((id) => localStorage.setItem('trivattle-match', id), battle.id);
  await page.reload();
  await page.getByRole('button', { name: 'Continue to Player' }).click();
  await attack(page);
  await expect(page.getByText('The well of knowledge runs dry.')).toBeVisible();
  await expect(page.locator('.resolution-log')).toContainText('No unused questions');
  await page.evaluate(() => localStorage.setItem('trivattle-match', 'missing'));
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Battle expired');
  await expect(page.getByRole('button', { name: 'Quick battle' })).toBeVisible();
});

test('failed article images retain type artwork; a lost server can be left from trivia', async ({
  page,
}) => {
  await page.route('**/api/cards?*', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.cards[0].image = {
      url: 'https://image.invalid/missing.jpg',
      fileName: 'missing.jpg',
      attribution: null,
      license: null,
      licenseUrl: null,
      descriptionUrl: null,
    };
    await route.fulfill({ response, json: data });
  });
  await page.route('https://image.invalid/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('.card').first().locator('.art.placeholder')).toBeVisible();
  await expect(page.locator('.card').first().locator('.article-image')).toHaveCount(0);
  await page.getByRole('button', { name: 'Quick battle' }).click();
  await attack(page);
  await page.getByRole('button', { name: 'Ready for Trivia' }).click();
  await page.route('**/api/battles/**', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Battle expired or server restarted. Start a new battle.' }),
    }),
  );
  await page.locator('.answers button').first().click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Battle expired');
  await page.getByRole('button', { name: 'Return to setup' }).click();
  await expect(page.getByRole('button', { name: 'Quick battle' })).toBeVisible();
});

test('article details follow the active player and attacks have a prominent announcement', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Inspect Fixture Observatory 1', exact: true }).click();
  await expect(page.getByText('About this article')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Read the Wikipedia article' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Quick battle' }).click();
  await page.locator('.opponent .card-info').first().click();
  await expect(page.locator('dialog')).toBeVisible();
  await expect(page.getByText('About this article')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Read the Wikipedia article' })).toHaveCount(0);
  await expect(page.locator('dialog .detail-move .type-icon').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('.own .card-info').first().click();
  await expect(page.getByText('About this article')).toBeVisible();
  await page.keyboard.press('Escape');
  await attack(page);
  await page.getByRole('button', { name: 'Ready for Trivia' }).click();
  await page.locator('.answers button').nth(1).click();
  await expect(page.locator('.attack-announcement')).toContainText('used');
  await expect(page.locator('.result-icon')).toBeVisible();
  await page.getByRole('button', { name: 'Continue to Player' }).click();
  await page.locator('.opponent .card-info').first().click();
  await expect(page.locator('dialog')).toBeVisible();
  await expect(page.getByText('About this article')).toHaveCount(0);
});

test('battle cards select directly, info stays separate, and matchup labels sit outside cards', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Quick battle' }).click();
  const own = page.locator('.own .card').first(),
    enemy = page.locator('.opponent .card').first();
  await expect(page.locator('.battle-slot .select-card')).toHaveCount(0);
  await enemy.locator('.stats').click();
  await expect(enemy).not.toHaveClass(/selected/);
  await own.locator('.card-cover').focus();
  await page.keyboard.press('Enter');
  await expect(own).toHaveClass(/selected/);
  await own.locator('.move').first().click();
  await expect(page.locator('.opponent .matchup-label.shown')).toHaveCount(5);
  await expect(page.locator('.card .matchup-label')).toHaveCount(0);
  await enemy.locator('.card-info').click();
  await expect(page.locator('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(enemy).not.toHaveClass(/selected/);
  await enemy.locator('.stats').click();
  await expect(enemy).toHaveClass(/selected/);
  await expect(page.getByRole('button', { name: 'Confirm attack' })).toBeEnabled();
  const size = await own
    .locator('.art')
    .evaluate((e) => ({ width: e.clientWidth, height: e.clientHeight }));
  expect(size.width / size.height).toBeCloseTo(1.85, 1);
});
