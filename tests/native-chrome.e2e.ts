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

test('readonly text remains selectable and copyable without accepting edits', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.locator('.shell').evaluate(el => {
        el.insertAdjacentHTML('beforeend', '<div style="position:fixed;top:40px;left:30px;z-index:99999"><input readonly value="diagnostics"><textarea readonly>diagnostics</textarea></div>');
    });
    for (const selector of ['input', 'textarea']) {
        const field = page.locator(selector);
        await field.dblclick();
        await expect(field).toBeFocused();
        await expect(field).toHaveCSS('user-select', 'text');
        expect(await field.evaluate(el => {
            const text = el as HTMLInputElement | HTMLTextAreaElement;
            return text.value.slice(text.selectionStart!, text.selectionEnd!);
        })).toBe('diagnostics');
        await page.keyboard.press('ControlOrMeta+c');
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('diagnostics');
        const tick = await page.getByRole('slider').getAttribute('aria-valuenow');
        const playing = await page.locator('[data-action="play-pause"]').getAttribute('aria-label');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('Space');
        await page.keyboard.type('replacement');
        await expect(field).toHaveValue('diagnostics');
        await expect(page.getByRole('slider')).toHaveAttribute('aria-valuenow', tick!);
        await expect(page.locator('[data-action="play-pause"]')).toHaveAttribute('aria-label', playing!);
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
        el.insertAdjacentHTML('beforeend', '<div style="position:fixed;top:40px;left:30px;z-index:99999"><input value="editable text"><textarea>editable text</textarea><div contenteditable="true">editable text</div><div contenteditable="">editable text</div><div contenteditable="plaintext-only">editable text</div><input disabled value="disabled"><input type="range"><pre>copyable diagnostics</pre></div>');
    });
    for (const selector of ['input:not([type]):not(:disabled)', 'textarea', '[contenteditable="true"]', '[contenteditable=""]', '[contenteditable="plaintext-only"]']) {
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
    await page.locator('input:disabled').evaluate(el => el.focus());
    expect(await page.locator('input:disabled').evaluate(el => el === document.activeElement)).toBe(false);
    await expect(page.locator('input:disabled')).toHaveCSS('user-select', 'none');
    await page.locator('input[type=range]').click();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});
