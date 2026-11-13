from pathlib import Path
from playwright.sync_api import sync_playwright
import json

root=Path(__file__).resolve().parent.parent
error = 'Вы достигли максимальной длины этого обсуждения, но можете продолжить обсуждение, начав новый чат.'
aside = '''<aside class="relative isolate flex w-full overflow-hidden bg-surface border text-pretty text-sm rounded-md px-4 py-3 border-text-danger/20 text-danger @container items-start gap-4" role="alert"><div aria-hidden="true" class="absolute inset-0 -z-10 bg-background-danger-surface/20"></div><div class="flex h-full w-full gap-3 items-start @min-[560px]:items-center"><div class="flex min-w-0 grow flex-col @min-[560px]:flex-row @min-[560px]:items-center @min-[560px]:justify-between @min-[560px]:gap-8"><div class="flex min-w-0 flex-col flex-1"><div class="flex min-w-0 flex-1 flex-col"><div class="min-w-0 flex-1">Вы достигли максимальной длины этого обсуждения, но можете продолжить обсуждение, начав новый чат.</div></div></div><div class="flex gap-2 shrink-0 mt-2 min-w-fit @min-[560px]:mt-0"><button type="button" class="no-drag cursor-interaction items-center select-none disabled:cursor-default aria-disabled:cursor-default focus:outline-hidden disabled:opacity-40 aria-disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 whitespace-nowrap flex border gap-1 rounded-full">Начать новый чат</button></div></div></div></aside>'''
html='''<!doctype html><html><head><meta charset="UTF-8"><style>body{font:16px Arial;} aside{border:1px solid red;padding:12px;margin-top:20px;} .response{padding:20px} button{display:block}</style></head><body><main><div data-turn-key="user-1" data-message-author-role="user"><div data-user-message-bubble="true">Продолжай</div></div><div id="answer" data-turn-key="assistant-1" data-message-author-role="assistant"><div class="response" data-testid="assistant-message">Результат проверки<br>!!!ГОТОВО!!!</div></div><div id="system-error"></div></main></body></html>'''

def simulate(nested=False, clean_button=False, old_before_user=False, inside_user=False):
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox','--disable-dev-shm-usage'])
        page=browser.new_page()
        page.set_content(html)
        page.evaluate('''() => {
          window.__watchdogCalls = [];
          window.chrome = {runtime: {onMessage: {addListener(fn){window.__watchdogListener=fn}}, sendMessage: async function(msg){window.__watchdogCalls.push(msg.type); switch(msg.type){case "GET_CONFIG":return {enabled:true, mode:"auto",toastEnabled:false, errorWordsVersion:3};case "GET_SEND_STATE":return {ok:true, lockedUntil:0};case "CLAIM_ERROR_DIALOG":return {ok:true, leaseId:"l1"};case "PLAY_ERROR":return {ok:true};case "PLAY_COMPLETION":return {ok:true};default:return {ok:true}}}}};
        }''')
        page.add_script_tag(path=str(root/'core.js'))
        page.add_script_tag(path=str(root/'content.js'))
        page.wait_for_timeout(250)
        updated=aside.replace('Начать новый чат</button>','</button>') if clean_button else aside
        if old_before_user:
          page.locator('[data-turn-key="user-1"]').evaluate(
            '(node, html)=>node.insertAdjacentHTML("beforebegin", html)', updated)
        elif inside_user:
          page.locator('[data-user-message-bubble="true"]').evaluate(
            '(node, html)=>node.insertAdjacentHTML("beforeend", html)', updated)
        elif nested:
          page.locator('#answer').evaluate('(node, html)=>node.insertAdjacentHTML("beforeend", html)',updated)
        else:
          page.locator('#system-error').evaluate('(node, html)=>node.insertAdjacentHTML("afterend", html)',updated)
        page.wait_for_timeout(900)
        calls=page.evaluate('window.__watchdogCalls')
        diagnostic=page.evaluate('''async () => new Promise(resolve => window.__watchdogListener({type:"WATCHDOG_DIAGNOSE"},{},resolve))''')
        inner=page.locator('aside[role="alert"]').evaluate('(e)=>({inner:e.innerText,text:e.textContent,closestTurn:!!e.closest("[data-turn-key]")})')
        host=page.locator('#chat-watchdog-alert-host').count()
        browser.close()
        return {'nested':nested,'clean_button':clean_button,'old_before_user':old_before_user,'inside_user':inside_user,'calls':calls,'modalCount':host,'inner':inner,'diagnostic':{k:diagnostic.get(k) for k in ['enabled','mode','assistantCount','markerDetected','lastAutoDecision']}}

if __name__=='__main__':
    cases = [
      ({}, True, 'independent alert with recovery action'),
      ({'nested': True}, True, 'alert nested in current assistant reply'),
      ({'old_before_user': True}, False, 'old alert before newest user turn'),
      ({'inside_user': True}, False, 'HTML inside a user-authored message'),
    ]
    for kwargs, expected, title in cases:
        outcome = simulate(**kwargs)
        got = outcome['calls'].count('PLAY_ERROR') == 1 and outcome['modalCount'] == 1
        if expected:
            assert got, f'{title}: expected exactly 1 sound request and 1 modal: {outcome}'
        else:
            assert 'PLAY_ERROR' not in outcome['calls'] and outcome['modalCount'] == 0, (
                f'{title}: old/user content should not alert: {outcome}')
        print(f'PASS {title}: modal={outcome["modalCount"]}, sound_requests={outcome["calls"].count("PLAY_ERROR")}')
