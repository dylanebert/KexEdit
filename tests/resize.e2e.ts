import { expect, test } from '@playwright/test';

test('splitters resize without replacing the canvas or disturbing transport; chrome stays outside sequential keyboard navigation', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/?stepped');
    await page.locator('[data-shell-ready="true"]').waitFor();
    await page.locator('[data-shallot-loading]').waitFor({state:'detached'});
    await page.waitForTimeout(250);
    await page.evaluate(() => { (window as any).originalCanvas = document.querySelector('canvas'); });
    const ruler = page.getByRole('slider');
    await ruler.focus(); await page.keyboard.press('Shift+ArrowRight');
    const tick = await ruler.getAttribute('aria-valuenow');
    await page.evaluate(() => window.kexeditSubject!.step(0));
    const originalFrame = await page.locator('canvas').screenshot({path:'/tmp/kexedit-orbit-before.png'});
    for (const [name, vertical] of [['Context width', true], ['Timeline height', false]] as const) {
        const divider = page.getByRole('separator', {name});
        const value = async () => Number(await divider.getAttribute('aria-valuenow'));
        const start = await value();
        await divider.focus();
        await page.keyboard.press(vertical ? 'ArrowRight' : 'ArrowUp');
        expect(await value()).toBe(start + 10);
        await page.keyboard.press(vertical ? 'ArrowLeft' : 'ArrowDown');
        expect(await value()).toBe(start);
        await page.keyboard.press('End');
        expect(await value()).toBe(Number(await divider.getAttribute('aria-valuemax')));
        await page.keyboard.press('Home');
        expect(await value()).toBe(Number(await divider.getAttribute('aria-valuemin')));
        const box = (await divider.boundingBox())!;
        const x = box.x + box.width / 2, y = box.y + box.height / 2;
        await page.mouse.move(x,y);
        await page.screenshot({path:`/tmp/kexedit-${vertical?'context':'timeline'}-hover.png`});
        await page.mouse.down();
        await page.mouse.move(x + (vertical ? 90 : 0), y - (vertical ? 0 : 90), {steps:5});
        expect(await value()).toBe(start === 256 ? 282 : 250);
        await expect(page.locator('.shell')).toHaveAttribute('data-resizing', vertical?'vertical':'horizontal');
        await page.screenshot({path:`/tmp/kexedit-${vertical?'context':'timeline'}-drag.png`});
        await page.mouse.move(x + (vertical ? -1000 : 0), y + (vertical ? 0 : 1000));
        expect(await value()).toBe(Number(await divider.getAttribute('aria-valuemin')));
        await page.mouse.move(x + (vertical ? 2000 : 0), y - (vertical ? 0 : 2000));
        expect(await value()).toBe(Number(await divider.getAttribute('aria-valuemax')));
        await page.mouse.up();
        await expect(page.locator('.shell')).not.toHaveAttribute('data-resizing');
        for (const interruption of ['pointercancel','lostpointercapture','blur']) {
            const b = (await divider.boundingBox())!;
            await page.mouse.move(b.x+b.width/2,b.y+b.height/2); await page.mouse.down();
            if (interruption === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
            else await divider.dispatchEvent(interruption, {pointerId:1});
            await expect(page.locator('.shell')).not.toHaveAttribute('data-resizing');
            await page.mouse.up();
        }
    }
    const canvasWidth = await page.locator('canvas').evaluate(el => el.getBoundingClientRect().width);
    const timelineWidth = await page.locator('[data-region="timeline-surface"]').evaluate(el => el.getBoundingClientRect().width);
    await page.setViewportSize({width:900,height:600});
    await expect.poll(() => page.locator('canvas').evaluate(el => el.getBoundingClientRect().width)).not.toBe(canvasWidth);
    expect(await page.locator('[data-region="timeline-surface"]').evaluate(el => el.getBoundingClientRect().width)).toBeLessThan(timelineWidth);
    for (const divider of await page.getByRole('separator').all()) {
        expect(Number(await divider.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(Number(await divider.getAttribute('aria-valuemax')));
    }
    await page.setViewportSize({width:1280,height:800});
    // Restore the original pane sizes and compare a rendered frame: captured divider
    // drags must not leak into the scene's orbit input, including after a world step.
    for (const [name, target, vertical] of [['Context width',256,true],['Timeline height',192,false]] as const) {
        const divider = page.getByRole('separator', {name});
        const delta = target - Number(await divider.getAttribute('aria-valuenow'));
        const b = (await divider.boundingBox())!;
        await page.mouse.move(b.x+b.width/2,b.y+b.height/2); await page.mouse.down();
        await page.mouse.move(b.x+b.width/2+(vertical?delta:0),b.y+b.height/2-(vertical?0:delta));
        await page.mouse.up();
    }
    await ruler.focus();
    await page.mouse.move(20,20);
    await page.evaluate(() => window.kexeditSubject!.step(0));
    expect((await page.locator('canvas').screenshot({path:'/tmp/kexedit-orbit-after.png'})).equals(originalFrame)).toBe(true);
    await expect(ruler).toHaveAttribute('aria-valuenow',tick!);
    expect(await page.evaluate(() => document.querySelector('canvas') === (window as any).originalCanvas)).toBe(true);
    const readout = page.locator('[data-readout="time"]');
    await readout.dblclick();
    const timeBox = (await readout.boundingBox())!;
    await page.mouse.move(timeBox.x, timeBox.y + 5); await page.mouse.down();
    await page.mouse.move(timeBox.x + timeBox.width, timeBox.y + 5, {steps:5}); await page.mouse.up();
    expect(await page.evaluate(() => getSelection()?.toString())).toBe('');
    const play = page.locator('[data-action="play-pause"]');
    await play.click();
    expect(await play.evaluate(el => el.matches(':focus-visible'))).toBe(false);
    // Bracket the editor with focusable sentinels so real traversal proves that
    // neither direction stops on Play, the ruler, or either divider.
    await page.evaluate(() => {
        for (const edge of ['before', 'after']) {
            const button = document.createElement('button');
            button.id = `tab-${edge}`;
            button.textContent = edge;
            if (edge === 'before') document.body.prepend(button);
            else document.body.append(button);
        }
    });
    await page.locator('#tab-before').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('#tab-after')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#tab-before')).toBeFocused();
    await page.locator('#tab-before').evaluate(el => el.remove());
    await page.locator('#tab-after').evaluate(el => el.remove());
    // Pointer-focused controls still accept deliberate keyboard manipulation.
    await play.click();
    await page.keyboard.press('Space');
    await expect(play).toHaveAccessibleName('Pause');
    await page.keyboard.press('Space');
    await expect(play).toHaveAccessibleName('Play');
    expect(errors).toEqual([]);
});

for (const fixture of ['', '&fixture=stalled']) test(`palette ${fixture || 'ordinary'}`, async ({page}) => {
    await page.goto('/?stepped'+fixture);
    await page.locator('[data-shell-ready="true"]').waitFor();
    await page.locator('[data-shallot-loading]').waitFor({state:'detached'});
    await page.waitForTimeout(300);
    await page.screenshot({path:`/tmp/kexedit-after-${fixture ? 'stalled':'ordinary'}.png`});
});
