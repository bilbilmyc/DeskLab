"""Headless UI and download checks against a packaged app with isolated data.

Requires Python Playwright and installed Microsoft Edge. Run from the repo root.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request
import urllib.error

from playwright.sync_api import sync_playwright, expect

workspace = Path(__file__).resolve().parents[2]
checks = workspace / '.runtime' / 'checks'
checks.mkdir(parents=True, exist_ok=True)
evidence = Path(tempfile.mkdtemp(prefix='diagnostics-ui-', dir=checks))
data_root = evidence / 'data'
env = dict(os.environ, LAB_DATA_DIR=str(data_root), LAB_PORT='0', LAB_OPEN='0', LAB_TRAY='0')
app = subprocess.Popen([str(workspace / 'dist' / 'app' / 'DeskLab.exe')], env=env,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
origin = ''
token = ''
results = []
errors = []
try:
    for _ in range(240):
        instance = data_root / 'instance.json'
        if instance.exists():
            origin = 'http://127.0.0.1:' + str(json.loads(instance.read_text())['port'])
            break
        assert app.poll() is None, 'Packaged app exited before ready'
        time.sleep(.25)
    assert origin, 'Packaged app did not start'
    state = json.load(urllib.request.urlopen(origin + '/api/state'))
    token = state['token']
    invalid = urllib.request.Request(origin + '/api/settings', data=b'{"accelerator":"PRIVATE_INPUT_MUST_NOT_BE_LOGGED"}', headers={'Content-Type': 'application/json', 'x-lab-token': token})
    try:
        urllib.request.urlopen(invalid).close()
        raise AssertionError('Invalid settings were accepted')
    except urllib.error.HTTPError as error:
        assert error.code == 400
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge', headless=True)
        try:
            for width in (320, 768, 1024, 1440):
                page = browser.new_page(viewport={'width': width, 'height': 900}, accept_downloads=True)
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(origin)
                page.wait_for_load_state('networkidle')
                page.get_by_role('button', name='查看体检', exact=True).click()
                expect(page.get_by_role('heading', name='本机体检', exact=True)).to_be_visible()
                expect(page.locator('.diagnostics-meta')).to_contain_text('检查完成', timeout=45000)
                expect(page.get_by_role('button', name='重新检测', exact=True)).to_be_enabled()
                assert page.locator('.diagnostics-checks li').count() == 14
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'{width}px overflow'
                page.get_by_role('button', name='重新检测', exact=True).focus()
                expect(page.get_by_role('button', name='重新检测', exact=True)).to_be_focused()
                page.keyboard.press('Enter')
                expect(page.get_by_role('button', name='重新检测', exact=True)).to_be_enabled(timeout=45000)
                with page.expect_download(timeout=45000) as download_info:
                    page.get_by_role('button', name='导出诊断日志', exact=True).click()
                output = evidence / f'diagnostics-{width}.json'
                download_info.value.save_as(output)
                exported = json.loads(output.read_text(encoding='utf-8'))
                assert exported['schemaVersion'] == 1
                assert exported['report']['checks']
                assert any(event.get('code') == 'INVALID_INPUT' for event in exported['events'])
                assert 'PRIVATE_INPUT_MUST_NOT_BE_LOGGED' not in output.read_text(encoding='utf-8')
                assert token not in output.read_text(encoding='utf-8')
                assert str(data_root) not in json.dumps(exported, ensure_ascii=False)
                expect(page.get_by_role('status').filter(has_text='诊断文件已交给浏览器下载')).to_be_visible()
                page.screenshot(path=str(evidence / f'width-{width}.png'), full_page=True)
                results.append(f'{width}px: auto-check, navigation, keyboard, refresh, download, no overflow')
                page.close()

            page = browser.new_page(viewport={'width': 1024, 'height': 900})
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.route('**/api/diagnostics/check', lambda route: route.fulfill(status=503, json={'error': '测试体检失败'}))
            page.goto(origin)
            page.get_by_role('button', name='查看体检', exact=True).click()
            expect(page.get_by_role('alert').filter(has_text='测试体检失败')).to_be_visible()
            expect(page.get_by_role('button', name='导出诊断日志', exact=True)).to_be_disabled()
            page.unroute('**/api/diagnostics/check')
            page.get_by_role('button', name='重新检测', exact=True).click()
            expect(page.locator('.diagnostics-meta')).to_contain_text('检查完成', timeout=45000)
            page.get_by_text('修改引擎配置', exact=True).click()
            page.locator('.engine-settings-form select[name="accelerator"]').select_option('tcg')
            page.get_by_role('button', name='保存并检测', exact=True).click()
            expect(page.locator('.diagnostics-checks li').filter(has_text='所选运行模式')).to_contain_text('TCG', timeout=45000)
            results.append('saving accelerator configuration automatically refreshes diagnostics')
            page.route('**/api/diagnostics/export', lambda route: route.fulfill(status=503, json={'error': '测试导出失败'}))
            page.get_by_role('button', name='导出诊断日志', exact=True).click()
            expect(page.get_by_role('alert').filter(has_text='测试导出失败')).to_be_visible()
            results.append('check failure, retry recovery, export failure are visible')
            assert not errors, errors
        finally:
            browser.close()
    (evidence / 'result.json').write_text(json.dumps({'passed': results, 'errors': errors}, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'passed': results, 'evidence': str(evidence)}, ensure_ascii=False))
finally:
    if origin and token and app.poll() is None:
        request = urllib.request.Request(origin + '/api/app/quit', data=b'{}', headers={'Content-Type': 'application/json', 'x-lab-token': token})
        try:
            urllib.request.urlopen(request, timeout=10).close()
            app.wait(timeout=15)
        except Exception:
            app.kill()
    if app.poll() is None:
        app.kill()
    app.wait()
