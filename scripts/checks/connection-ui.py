"""Connection recovery UI checks. All API traffic is intercepted; no VM is used.

Run against a dedicated Next development server or an isolated packaged app:
  python scripts/checks/connection-ui.py --url http://127.0.0.1:3117
  python scripts/checks/connection-ui.py --browser-channel chromium
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from urllib.parse import urlparse
import urllib.request

from playwright.sync_api import sync_playwright, expect


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', help='Loopback frontend to check; launches the packaged app when omitted')
    parser.add_argument('--exe', type=Path, default=Path(__file__).resolve().parents[2] / 'dist' / 'app' / 'DeskLab.exe')
    parser.add_argument('--browser-channel', default='chromium', choices=('chromium', 'msedge'))
    args = parser.parse_args()
    workspace = Path(__file__).resolve().parents[2]
    checks = workspace / '.runtime' / 'checks'
    checks.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix='connection-ui-', dir=checks))
    app, artifacts, origin = None, None, (urlparse(args.url).geturl() if args.url else '')
    if args.url:
        assert urlparse(args.url).hostname == '127.0.0.1', 'Use an isolated loopback frontend'
    else:
        artifacts = json.loads(subprocess.check_output(
            ['bun', 'scripts/checks/check-evidence.ts', 'capture', '--exe', str(args.exe.resolve())],
            cwd=workspace, text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW))
        (evidence / 'artifacts.json').write_text(json.dumps(artifacts, indent=2), encoding='utf-8')
        app_data = evidence / 'app-data'
        env = dict(os.environ, LAB_DATA_DIR=str(app_data), LAB_PORT='0', LAB_OPEN='0', LAB_TRAY='0')
        app = subprocess.Popen([str(args.exe.resolve())], env=env, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
        for _ in range(240):
            instance = app_data / 'instance.json'
            if instance.exists():
                origin = 'http://127.0.0.1:' + str(json.loads(instance.read_text())['port'])
                break
            assert app.poll() is None, 'Packaged process exited'
            time.sleep(.25)
        assert origin, 'Packaged app did not publish its port'
    vm_id = '11111111-1111-4111-8111-111111111111'
    snapshot = {
        'token': 'fixture-token',
        'machines': [{'id': vm_id, 'name': '连接恢复测试环境', 'family': 'ubuntu',
                      'memory': 2048, 'cpus': 2, 'diskGB': 20, 'state': 'stopped',
                      'createdAt': '2026-09-26T00:00:00Z', 'network': {'mode': 'nat'}}],
        'templates': [], 'catalogue': [], 'images': [],
        'settings': {'qemuPath': '', 'accelerator': 'whpx'},
        'host': {'platform': 'win32', 'arch': 'x64', 'cpu': 'Fixture CPU', 'threads': 4,
                 'totalMemory': 16 * 1073741824, 'freeMemory': 8 * 1073741824,
                 'qemuFound': True, 'imageToolFound': True, 'accelerators': ['whpx'],
                 'dataDirectory': 'fixture-data', 'isoDirectory': 'fixture-iso'},
    }
    results, errors, writes = [], [], []
    report = {'target': origin, 'mode': 'all API requests intercepted', 'results': results,
              'browser': args.browser_channel, 'evidence': artifacts}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel=args.browser_channel, headless=True)
            try:
                page = browser.new_page(viewport={'width': 1440, 'height': 900})
                page.on('pageerror', lambda error: errors.append(str(error)))
                state = {'offline': False}

                def api(route):
                    path = urlparse(route.request.url).path
                    if path == '/api/state':
                        if state['offline']:
                            route.fulfill(status=503, json={'error': 'fixture unavailable'})
                        else:
                            route.fulfill(json=snapshot)
                    elif path == '/api/diagnostics/check':
                        route.fulfill(json={'checkedAt': '2026-09-26T00:00:00Z',
                                            'summary': {'pass': 0, 'fail': 0, 'warning': 0, 'unknown': 0},
                                            'checks': []})
                    else:
                        writes.append(path)
                        route.fulfill(status=400, json={'error': '端口已被占用（业务错误）'})

                page.route('**/api/**', api)
                page.goto(origin)
                page.wait_for_load_state('networkidle')
                expect(page.locator('.host-indicator')).to_contain_text('本地服务已连接')
                page.get_by_role('button', name='启动环境', exact=True).click()
                expect(page.get_by_role('alert').filter(has_text='端口已被占用')).to_be_visible()
                state['offline'] = True
                expect(page.locator('.host-indicator')).to_contain_text('本地服务已断开', timeout=5000)
                expect(page.get_by_role('heading', name='连接恢复测试环境', exact=True)).to_be_visible()
                expect(page.get_by_role('button', name='启动环境', exact=True)).to_be_disabled()
                expect(page.get_by_role('button', name='创建环境', exact=True)).to_be_disabled()
                expect(page.get_by_role('alert').filter(has_text='端口已被占用')).to_be_visible()
                page.screenshot(path=str(evidence / 'disconnected.png'), full_page=True)
                results.append('disconnect retains old data and business error; service actions disabled')
                state['offline'] = False
                expect(page.locator('.host-indicator')).to_contain_text('本地服务已连接', timeout=5000)
                expect(page.locator('.connection-alert')).to_have_count(0)
                expect(page.get_by_role('button', name='启动环境', exact=True)).to_be_enabled()
                expect(page.get_by_role('alert').filter(has_text='端口已被占用')).to_be_visible()
                results.append('recovery clears only connection error and enables operations')
                assert writes == [f'/api/machines/{vm_id}/start'], writes
                assert not errors, errors
                report['passed'] = True
            finally:
                browser.close()
    except Exception as error:
        report['passed'] = False
        report['failure'] = str(error)
        raise
    finally:
        if app is not None and app.poll() is None:
            try:
                token = json.load(urllib.request.urlopen(origin + '/api/state', timeout=30))['token']
                request = urllib.request.Request(origin + '/api/app/quit', data=b'{}',
                                                 headers={'Content-Type': 'application/json', 'x-lab-token': token})
                urllib.request.urlopen(request, timeout=30)
                app.wait(timeout=20)
            except Exception as error:
                errors.append(f'Clean exit failed: {error}')
                app.kill()
        if app is not None:
            app.wait()
            if app.returncode != 0:
                errors.append(f'Packaged app exit code: {app.returncode}')
        if artifacts is not None:
            try:
                subprocess.run(['bun', 'scripts/checks/check-evidence.ts', 'verify', '--evidence', str(evidence / 'artifacts.json')],
                               cwd=workspace, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
            except Exception as error:
                errors.append(f'Final artifact verification failed: {error}')
        report['pageErrors'] = errors
        (evidence / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(evidence / 'report.json')
        if errors:
            raise SystemExit(1)


if __name__ == '__main__':
    main()
