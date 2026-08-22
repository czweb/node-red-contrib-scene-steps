from playwright.sync_api import sync_playwright, expect
import time, json, os

SCDIR = '/workspace/node-red-contrib-scene-steps/.screens'
os.makedirs(SCDIR, exist_ok=True)

def ss(page, name):
    p = f'{SCDIR}/{name}.png'
    page.screenshot(path=p, full_page=True)
    print(f'  [shot] {p}')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={'width': 1500, 'height': 900})
    logs = []
    page = ctx.new_page()
    page.on('console', lambda m: logs.append(f'[{m.type}] {m.text[:200]}'))
    page.on('pageerror', lambda e: logs.append(f'[pageerror] {str(e)[:500]}'))

    print('\n=== 1. open Node-RED ===')
    page.goto('http://127.0.0.1:1880/', timeout=45000)
    page.wait_for_load_state('networkidle', timeout=45000)
    time.sleep(4)
    ss(page, '01-editor')
    print('   title =', page.title())

    print('\n=== 2. search scene-steps in palette ===')
    # NR4 官方 palette 搜索输入 id 不同，先尝试多个候选
    candidates = ['#red-ui-palette-search', '#red-palette-search']
    search_box = None
    for sel in candidates:
        el = page.locator(sel).first
        if el.count() > 0 and el.is_visible():
            search_box = el; break
    if search_box:
        search_box.fill('scene')
        time.sleep(0.8)
    ss(page, '02-palette-scene')
    palette_nodes = page.locator('.red-ui-palette-node')
    hit = None
    for i in range(palette_nodes.count()):
        try:
            attrs = palette_nodes.nth(i).get_attribute('data-type') or ''
            text = palette_nodes.nth(i).inner_text()[:60]
            print(f'   palette[{i}] data-type={attrs!r} text={text!r}')
            if 'scene' in attrs.lower(): hit = palette_nodes.nth(i)
        except: pass
    print('   scene palette hit =', hit is not None)

    print('\n=== 3. add node to canvas (dblclick palette) ===')
    if hit is not None:
        hit.dblclick(delay=200)
        time.sleep(1.5)
    ss(page, '03-after-add')

    print('\n=== 4. open node editor via dblclick workspace node ===')
    ws_nodes = page.locator('.red-ui-flow-node')
    print(f'   workspace nodes count = {ws_nodes.count()}')
    opened = False
    for i in range(ws_nodes.count()):
        try:
            label_el = ws_nodes.nth(i).locator('text=scene-steps')
            txt = ws_nodes.nth(i).inner_text()[:80]
            print(f'   ws-node[{i}] text = {txt!r}')
            if 'scene-steps' in txt.lower() or (label_el.count() > 0):
                ws_nodes.nth(i).dblclick(delay=200)
                time.sleep(3)
                opened = True
                break
        except Exception as e:
            print(f'   ws-node[{i}] err: {e}')
    if not opened:
        # fallback: just pick first flow node and try
        if ws_nodes.count():
            ws_nodes.first.dblclick(delay=200); time.sleep(3)
    ss(page, '04-dialog-open')

    print('\n=== 5. actions-meta backend endpoint ===')
    try:
        r = page.request.get('http://127.0.0.1:1880/scene-steps/actions-meta')
        assert r.ok, f'HTTP {r.status}'
        data = r.json()
        print('   ok =', data.get('ok'), 'ver =', data.get('version'), 'n=', len(data.get('actions',[])))
        for a in data['actions']:
            print('    -', a['type'], a['category'], a['label'])
        assert len(data['actions']) == 10
    except Exception as e:
        print('   FAIL:', e)

    print('\n=== 6. editor body check (three-pane or fallback) ===')
    root = page.locator('#nr-scene-steps-root')
    print('   root visible =', root.count() > 0 and root.first.is_visible())
    for i in range(8):
        app = page.locator('.nr-ss-app')
        fb = page.locator('#nr-ss-fallback-textarea')
        print(f'   [{i+1}s] app={app.count()} fallback={fb.count()}')
        if app.count() or fb.count(): break
        time.sleep(1)
    ss(page, '05-editor-ready')

    # 尝试一些交互：如果 Vue 加载成功了，点动作库的「+」添加 delay 和 tcp_send
    print('\n=== 7. interaction smoke test ===')
    try:
        app = page.locator('.nr-ss-app').first
        if app.count() and app.is_visible():
            # 点第一个动作库项的 +
            add_btns = page.locator('.nr-ss-action-add-btn')
            for i in range(min(3, add_btns.count())):
                add_btns.nth(i).click(timeout=3000)
                time.sleep(0.3)
            step_count = page.locator('.nr-ss-step').count()
            print('   after + clicks, step cards count =', step_count)
            ss(page, '06-steps-added')
            if step_count:
                page.locator('.nr-ss-step').first.click()
                time.sleep(0.5)
                # 右栏表单渲染验证
                right_pane = page.locator('.nr-ss-pane:last-child .nr-ss-pane-body').first
                print('   right-pane children count=', right_pane.count())
                ss(page, '07-form-rendered')
    except Exception as e:
        print('   interaction note:', e)

    # 保存 & 关闭
    print('\n=== 8. save & close dialog, deploy flow ===')
    try:
        done_btn = page.locator('.red-ui-dialog-buttons button').filter(has_text='Done').first
        if not done_btn.count():
            done_btn = page.locator('.red-ui-dialog-buttons button').last
        done_btn.click(); time.sleep(1)
    except Exception as e:
        print('   dialog close note:', e)
    try:
        dep = page.locator('#red-ui-header-button-deploy, button#btn-deploy, .red-ui-deploy-button').first
        if dep.count(): dep.click(); time.sleep(2)
    except Exception as e:
        print('   deploy note:', e)
    ss(page, '08-deployed')

    print('\n=== browser log tail ===')
    for l in logs[-30:]: print('   ', l)

    browser.close()
    print('\n✅ 交互验证结束。截图在', SCDIR)
