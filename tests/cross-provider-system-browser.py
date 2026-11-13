"""Real Chromium DOM smoke tests of untagged and tagged error notices.
This exercises the actual content/core sources; Chrome background is stubbed.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
BASE = '''<!doctype html><html><head><style>body{font:16px Arial;} .bubble{margin:12px}</style></head><body>
<main id="conversation"><section data-message-author-role="user" data-turn-key="user-current" class="bubble">Продолжи работу</section>
<div data-testid="assistant-message" data-message-author-role="assistant" data-turn-key="assistant-current"><div>Отчёт<br>!!!ГОТОВО!!!</div></div></main>
<div id="portal"></div></body></html>'''

INIT = '''() => {
  window.__calls=[];window.__leases=new Set();window.__sounds=new Set();
  window.chrome={runtime:{onMessage:{addListener(fn){window.__listener=fn}},
    sendMessage:async function(msg){window.__calls.push(msg.type);
      if(msg.type==='GET_CONFIG')return {enabled:true,mode:'errors',toastEnabled:false};
      if(msg.type==='GET_SEND_STATE')return {ok:true,lockedUntil:0};
      if(msg.type==='CLAIM_ERROR_DIALOG'){
        if(window.__leases.size)return {ok:false,reason:'dialog-already-open'};
        window.__leases.add('lease');return {ok:true,leaseId:'lease'};
      }
      if(msg.type==='PLAY_ERROR'){
        if(window.__sounds.has(msg.incidentKey))return {ok:false,reason:'audio-incident-duplicate'};
        window.__sounds.add(msg.incidentKey);return {ok:true};
      }
      if(msg.type==='RELEASE_ERROR_DIALOG'){window.__leases.delete(msg.leaseId);return {ok:true}}
      return {ok:true};
  }}};
}'''


def run_case(browser, host, title, initial_html=None, inject_js='', expected=1, update_js=None):
    context=browser.new_context()
    # The browser uses an offline fixture. Node VM tests cover hostname adapters.
    page=context.new_page()
    page.set_content(initial_html or BASE)
    page.evaluate(INIT)
    page.add_script_tag(path=str(ROOT/'core.js'))
    page.add_script_tag(path=str(ROOT/'content.js'))
    page.wait_for_timeout(450)
    if inject_js:page.evaluate(inject_js)
    if update_js: page.evaluate(update_js)
    page.wait_for_timeout(1150)
    result=page.evaluate('''() => ({ modal:document.querySelectorAll('#chat-watchdog-alert-host').length,
      audio:window.__calls.filter(x=>x==='PLAY_ERROR').length })''')
    # diagnostic Promise is not JSON serializable inside object -- not needed
    assert result['modal']==expected and result['audio']==expected, f'{title}: {result}'
    print(f'PASS {title} ({host}) — modal={result["modal"]}, error_audio_requests={result["audio"]}')
    context.close()

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
    try:
        for host,tag,phrase in [
          ('claude.ai','div','Failed to fetch'),
          ('gemini.google.com','section','Unknown error'),
          ('chat.deepseek.com','li','Неизвестная ошибка'),
          ('chat.example.org','span','Ошибка в потоке сообщений')
        ]:
            run_case(browser,host, f'roleless {tag}: {phrase}',inject_js=f'''() => {{
              const el=document.createElement('{tag}');el.textContent={phrase!r};
              document.querySelector('#portal').append(el);
            }}''')
        run_case(browser,'claude.ai','roleless notice with a recovery button',inject_js='''() => {
          const el=document.createElement('div');el.innerHTML='Failed to fetch <button>Retry</button>';
          document.querySelector('#portal').append(el);
        }''')
        run_case(browser,'gemini.google.com','updated existing div text',
          initial_html=BASE.replace('<div id="portal"></div>','<div id="portal"><div id="status">Loading</div></div>'),
          update_js='''() => { document.querySelector('#status').textContent='Unknown error'; }''')
        run_case(browser,'chat.example.org','new roleless portal before chat',
          initial_html=BASE.replace('<main id="conversation">','<div id="portal-early"></div><main id="conversation">'),
          inject_js="""() => { const div=document.createElement('div');div.textContent='Failed to fetch';
            document.querySelector('#portal-early').append(div); }""")
        run_case(browser,'chat.example.org','explicit portal alert before chat with a button',
          initial_html=BASE.replace('<main id="conversation">','<div id="portal"><div role="alert" id="in-header">Ready</div></div><main id="conversation">').replace('<div id="portal"></div></body>','</body>'),
          update_js='''() => { document.querySelector('#in-header').innerHTML='Failed to fetch <button>Retry</button>'; }''')
        run_case(browser,'claude.ai','old assistant quotation ignored',expected=0,
          inject_js='''() => { const older=document.createElement('div');older.className='font-claude-message';older.innerHTML='<div>Failed to fetch</div>';
            document.querySelector('#portal').append(older); }''')
        run_case(browser,'chat.example.org','user-authored quote ignored',expected=0,
          inject_js='''() => { const user=document.createElement('div');user.setAttribute('data-message-author-role','user');user.innerHTML='<div>Failed to fetch</div>';
            document.querySelector('#portal').append(user); }''')
        run_case(browser,'chatgpt.com','fresh nested alert with completion marker',
          inject_js='''() => { const aside=document.createElement('aside');aside.setAttribute('role','alert');
            aside.innerHTML='Вы достигли максимальной длины этого обсуждения, но можете продолжить обсуждение, начав новый чат. <button>Начать новый чат</button>';
            document.querySelector('[data-message-author-role="assistant"]').append(aside); }''')
    finally:browser.close()
