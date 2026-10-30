import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.beforeEach(async ({ page }) => {
    await page.goto('/?stepped');
    await page.locator('[data-shell-ready="true"]').waitFor();
    await page.locator('[data-shallot-loading]').waitFor({ state: 'detached' });
    await page.waitForTimeout(300);
});

test('pointer controls leave editor keys on body', async ({ page }) => {
    const ruler = page.getByRole('slider');
    const play = page.locator('[data-action="play-pause"]');
    for (const control of [play, ruler, ...await page.getByRole('separator').all(), page.locator('canvas')]) {
        await control.click();
        expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
        await page.keyboard.press('Home');
        await page.keyboard.press('ArrowRight');
        await expect(ruler).toHaveAttribute('aria-valuenow', '1');
        const before = await play.getAttribute('aria-label');
        await page.keyboard.press('Space');
        await expect(play).toHaveAttribute('aria-label', before === 'Play' ? 'Pause' : 'Play');
    }
});

test('native chrome properties and editable content exception', async ({ page }) => {
    for (const selector of ['.shell', '.panel', '[data-readout="time"]', 'button', '.splitter', '.timeline-ruler', 'canvas']) {
        const el = page.locator(selector).first();
        await expect(el).toHaveCSS('user-select', 'none');
        await expect(el).toHaveCSS('-webkit-user-select', 'none');
        await expect(el).toHaveCSS('-webkit-tap-highlight-color', 'rgba(0, 0, 0, 0)');
        await expect(el).toHaveCSS('-webkit-user-drag', 'none');
    }
    expect(readFileSync('src/app.css', 'utf8')).toContain('-webkit-touch-callout: none');
    await page.locator('.shell').evaluate(el => {
        el.insertAdjacentHTML('beforeend', '<div style="position:fixed;top:40px;left:30px;z-index:99999"><input value="editable text"><textarea>editable text</textarea><div contenteditable="true">editable text</div><input type="range"><pre>copyable diagnostics</pre></div>');
    });
    for (const selector of ['input:not([type])', 'textarea', '[contenteditable]']) {
        const field = page.locator(selector);
        await field.click();
        await expect(field).toBeFocused();
        await expect(field).toHaveCSS('user-select', 'text');
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.type('replacement');
        expect(await field.evaluate(el => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.textContent)).toBe('replacement');
    }
    const diagnostic = page.locator('pre');
    await diagnostic.dblclick();
    expect(await page.evaluate(() => getSelection()?.toString())).not.toBe('');
    await expect(diagnostic).toHaveCSS('user-select', 'text');
    await page.locator('input[type=range]').click();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});
