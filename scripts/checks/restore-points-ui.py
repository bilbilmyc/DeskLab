"""Test final packaged restore points with isolated QCOW2 images and a headless browser."""
import argparse
from datetime import datetime, timezone
from importlib.metadata import version
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright, expect

workspace = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--exe', type=Path, default=workspace / 'dist' / 'app' / 'DeskLab.exe')
parser.add_argument('--installer', type=Path, default=workspace / 'dist' / 'installer' / 'DeskLab-Setup.exe')
parser.add_argument('--manifest', type=Path)
parser.add_argument('--browser-channel', default='chromium', choices=('chromium', 'msedge'))
args = parser.parse_args()
checks = workspace / '.runtime' / 'checks'
checks.mkdir(parents=True, exist_ok=True)
root = Path(tempfile.mkdtemp(prefix='restore-points-ui-', dir=checks))
started_at = datetime.now(timezone.utc).isoformat()
app, evidence = None, None
completed = False
origin, token = '', ''
results, errors = [], []
browser_version = None

def api(path, body=None):
    request = urllib.request.Request(origin + '/api/' + path, data=json.dumps(body).encode() if body is not None else None,
                                     headers={'Content-Type': 'application/json', 'x-lab-token': token})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)

try:
    capture = ['bun', 'scripts/checks/check-evidence.ts', 'capture', '--exe', str(args.exe.resolve()), '--installer', str(args.installer.resolve())]
    if args.manifest:
        capture += ['--manifest', str(args.manifest.resolve())]
    evidence = json.loads(subprocess.check_output(capture, cwd=workspace, text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW))
    (root / 'artifacts.json').write_text(json.dumps(evidence, indent=2), encoding='utf-8')
    subprocess.run(['bun', 'scripts/checks/restore-points-fixture.ts', str(root)], cwd=workspace, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
    fixture = json.loads((root / 'fixture.json').read_text())
    qemu_directory = Path(os.environ.get('QEMU_TEST_DIR', workspace / '.runtime' / 'tools' / 'qemu'))
    qemu_io, qemu_img = qemu_directory / 'qemu-io.exe', qemu_directory / 'qemu-img.exe'
    assert qemu_io.is_file() and qemu_img.is_file(), 'Real QEMU tools are required; this check cannot skip'
    env = dict(os.environ, LAB_DATA_DIR=str(root / 'data'), LAB_PORT='0', LAB_OPEN='0', LAB_TRAY='0')
    app = subprocess.Popen([str(args.exe.resolve())], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
    for _ in range(240):
        instance = root / 'data' / 'instance.json'
        if instance.exists():
            origin = 'http://127.0.0.1:' + str(json.loads(instance.read_text())['port'])
            break
        assert app.poll() is None, 'Packaged process exited'
        time.sleep(.25)
    assert origin
    token = api('state')['token']
    assert api('health')['version'] == evidence['version'], 'Running package version differs from the final manifest'
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=args.browser_channel, headless=True)
        browser_version = browser.version
        try:
            for width in (1440, 320, 768, 1024):
                page = browser.new_page(viewport={'width': width, 'height': 900})
                page.on('pageerror', lambda error: errors.append(str(error)))
                writes = []
                page.on('request', lambda request: writes.append(request.url) if request.method == 'POST' and '/restore-points' in request.url else None)
                page.goto(origin)
                page.wait_for_load_state('networkidle')
                page.get_by_role('button', name='还原点验收环境 更多操作', exact=True).click()
                page.get_by_role('button', name='还原点', exact=True).click()
                dialog = page.get_by_role('dialog')
                expect(dialog).to_contain_text('暂无还原点')
                name = f'依赖已安装 {width}'
                page.get_by_label('还原点名称', exact=True).fill(name)
                page.get_by_role('button', name='创建还原点', exact=True).click()
                expect(dialog.get_by_role('status').filter(has_text='还原点已创建')).to_be_visible(timeout=60000)
                expect(dialog.get_by_text(name, exact=True)).to_be_visible()
                page.screenshot(path=str(root / f'width-{width}.png'), full_page=True)
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'{width}px page overflow'
                assert dialog.evaluate('(el) => el.scrollWidth <= el.clientWidth + 1'), f'{width}px dialog overflow'
                page.get_by_role('button', name=f'恢复到 {name}', exact=True).click()
                expect(page.get_by_role('button', name='取消', exact=True)).to_be_focused()
                page.get_by_role('button', name='取消', exact=True).click()
                assert not any(url.endswith('/restore') for url in writes), 'cancel must not send restore request'
                # Simulate changed guest blocks while the isolated VM is stopped.
                subprocess.run([str(qemu_io), '-f', 'qcow2', '-c', 'write -P 66 0 65536', fixture['disk']], stdout=subprocess.DEVNULL, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
                assert subprocess.run([str(qemu_img), 'compare', fixture['disk'], fixture['base']], stdout=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW).returncode == 1
                page.get_by_role('button', name=f'恢复到 {name}', exact=True).click()
                page.get_by_role('button', name='确认恢复', exact=True).click()
                expect(dialog.get_by_role('status').filter(has_text='已恢复到选定还原点')).to_be_visible(timeout=60000)
                subprocess.run([str(qemu_img), 'compare', fixture['disk'], fixture['base']], stdout=subprocess.DEVNULL, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
                assert api('state')['machines'][0]['state'] == 'stopped'
                page.get_by_role('button', name=f'删除还原点 {name}', exact=True).click()
                expect(page.get_by_role('button', name='取消', exact=True)).to_be_focused()
                page.get_by_role('button', name='确认删除还原点', exact=True).click()
                expect(dialog.get_by_role('status').filter(has_text='还原点已删除')).to_be_visible(timeout=60000)
                expect(dialog).to_contain_text('暂无还原点')
                results.append(f'{width}px: create, cancel, restore changed blocks, delete, keyboard focus, no overflow')
                page.close()
            # A second browser cannot operate on a VM with uncertain/live state.
            page = browser.new_page(viewport={'width': 1024, 'height': 900})
            state = api('state')
            state['machines'][0]['state'] = 'running'
            state['machines'][0]['session'] = {'pid': 42, 'qmpPort': 10001, 'vncPort': 10002}
            page.route('**/api/state', lambda route: route.fulfill(json=state))
            page.goto(origin)
            page.get_by_role('button', name='还原点验收环境 更多操作', exact=True).click()
            page.get_by_role('button', name='还原点', exact=True).click()
            expect(page.get_by_role('button', name='创建还原点', exact=True)).to_be_disabled()
            expect(page.get_by_role('dialog')).to_contain_text('请先正常关闭环境')
            results.append('running-state UI disables snapshot creation')
            assert not errors, errors
        finally:
            browser.close()
    completed = True
except Exception as error:
    errors.append(f'{type(error).__name__}: {error}')
    raise
finally:
    if app is not None and origin and token and app.poll() is None:
        try:
            api('app/quit', {})
            app.wait(timeout=20)
        except Exception as error:
            errors.append(f'Clean exit failed: {error}')
            app.kill()
    if app is not None:
        if app.poll() is None:
            app.kill()
        app.wait()
        if app.returncode != 0:
            errors.append(f'Packaged app exit code: {app.returncode}')
    try:
        if evidence is not None:
            subprocess.run(['bun', 'scripts/checks/check-evidence.ts', 'verify', '--evidence', str(root / 'artifacts.json')], cwd=workspace, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
    except Exception as error:
        errors.append(f'Final artifact verification failed: {error}')
    (root / 'result.json').write_text(json.dumps({
        'startedAt': started_at, 'finishedAt': datetime.now(timezone.utc).isoformat(),
        'passed': completed and not errors, 'checks': results, 'errors': errors, 'evidence': evidence,
        'browser': {'channel': args.browser_channel, 'version': browser_version, 'playwright': version('playwright'), 'python': sys.version},
    }, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'passed': completed and not errors, 'checks': results, 'errors': errors, 'result': str(root / 'result.json')}, ensure_ascii=False))
if errors:
    raise SystemExit(1)
